#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const WEB_URL = normalizeBaseUrl(process.env.WEB_URL ?? "http://localhost:3000");
const API_URL = normalizeBaseUrl(process.env.API_URL ?? "http://localhost:8080");
const CHROME_PORT = Number(process.env.CHROME_DEBUG_PORT ?? 9242);
const CHROME_URL = `http://127.0.0.1:${CHROME_PORT}`;
const SCREENSHOT_DIR = process.env.AGENT_TRADE_E2E_ARTIFACT_DIR ?? "/tmp";

const ROUTES = [
  ["/", "Agent.trade"],
  ["/terminal", "Ask Agent.trade"],
  ["/terminal?symbol=ETH", "ETH-USD"],
  ["/markets", "Market discovery"],
  ["/portfolio", "Portfolio risk"],
  ["/onboarding", "Account readiness"],
  ["/connectors", "Connector"],
  ["/connect/claude", "Claude"],
  ["/connect/chatgpt", "ChatGPT"],
  ["/approve", "Legacy wallet approvals are disabled"],
  ["/oauth/authorize", "Compatibility approvals disabled"],
  ["/restricted", "restricted"],
];

const TEST_USER = "0xcccc000000000000000000000000000000000001";

const results = [];

function normalizeBaseUrl(input) {
  return input.replace(/\/+$/u, "");
}

function routeUrl(route) {
  return `${WEB_URL}${route}`;
}

function pass(name, details) {
  results.push({ ok: true, name, details });
  console.log(`✓ ${name}${details ? ` — ${details}` : ""}`);
}

function fail(name, details) {
  results.push({ ok: false, name, details });
  throw new Error(`${name}${details ? `: ${details}` : ""}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function check(name, fn) {
  try {
    const details = await fn();
    pass(name, details);
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJson(url, timeoutMs = 12_000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return await res.json();
      }
      lastError = new Error(`${res.status} ${res.statusText}`);
    } catch (err) {
      lastError = err;
    }
    await wait(250);
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for ${url}`);
}

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome",
    "chromium",
    "chromium-browser",
  ].filter(Boolean);

  return candidates[0];
}

async function launchChrome() {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "agent-trade-e2e-chrome-"));
  const chrome = spawn(chromeExecutable(), [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${CHROME_PORT}`,
    `--user-data-dir=${userDataDir}`,
    "--window-size=1440,1100",
    "about:blank",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  chrome.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  chrome.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(stderr.trim());
    }
  });

  await waitForJson(`${CHROME_URL}/json/version`);
  return {
    chrome,
    userDataDir,
    async close() {
      if (!chrome.killed && chrome.exitCode === null) {
        chrome.kill("SIGTERM");
      }
      await waitForChromeExit(chrome);
      await rmWithRetry(userDataDir);
    },
  };
}

async function waitForChromeExit(chrome, timeoutMs = 5000) {
  if (chrome.exitCode !== null) {
    return;
  }
  await Promise.race([
    new Promise((resolve) => chrome.once("exit", resolve)),
    wait(timeoutMs),
  ]);
  if (chrome.exitCode === null && !chrome.killed) {
    chrome.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => chrome.once("exit", resolve)),
      wait(1000),
    ]);
  }
}

async function rmWithRetry(target, attempts = 5) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (err) {
      lastError = err;
      await wait(150 * (index + 1));
    }
  }
  throw lastError;
}

function createCdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const eventHandlers = new Map();

    ws.addEventListener("open", () => {
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && pending.has(msg.id)) {
          const waiter = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) {
            waiter.reject(new Error(JSON.stringify(msg.error)));
          } else {
            waiter.resolve(msg.result ?? {});
          }
          return;
        }

        if (msg.method && eventHandlers.has(msg.method)) {
          for (const handler of eventHandlers.get(msg.method)) {
            handler(msg.params ?? {});
          }
        }
      });

      resolve({
        send(method, params = {}) {
          const callId = ++id;
          ws.send(JSON.stringify({ id: callId, method, params }));
          return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
        },
        on(method, handler) {
          const handlers = eventHandlers.get(method) ?? [];
          handlers.push(handler);
          eventHandlers.set(method, handlers);
        },
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener("error", reject);
  });
}

async function createBrowserClient() {
  const version = await waitForJson(`${CHROME_URL}/json/version`);
  return createCdpClient(version.webSocketDebuggerUrl);
}

async function createPage(url = "about:blank", browserContextId) {
  const browser = await createBrowserClient();
  const target = await browser.send("Target.createTarget", {
    url,
    browserContextId,
  });
  const info = await waitForTarget(target.targetId);
  const page = await createCdpClient(info.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await page.send("Network.enable");
  return { browser, page, targetId: target.targetId };
}

async function waitForTarget(targetId, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const targets = await waitForJson(`${CHROME_URL}/json`);
    const target = targets.find((item) => item.id === targetId);
    if (target?.webSocketDebuggerUrl) {
      return target;
    }
    await wait(100);
  }
  throw new Error(`Timed out waiting for target ${targetId}`);
}

async function evaluate(page, expression) {
  const result = await page.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  return result.result?.value;
}

async function waitFor(page, expression, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await evaluate(page, expression)) {
      return true;
    }
    await wait(250);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function navigate(page, url) {
  await page.send("Page.navigate", { url });
  await waitFor(page, `window.location.href === ${JSON.stringify(url)}`, 15_000);
  await waitFor(page, "document.readyState === 'complete' || document.readyState === 'interactive'", 15_000);
}

async function visibleText(page, selector = "body") {
  return await evaluate(page, `document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`);
}

async function clickButton(page, text, rootSelector = "body") {
  const expression = `(() => {
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    if (!root) throw new Error("Missing root ${rootSelector}");
    const button = [...root.querySelectorAll("button")].find((el) =>
      el.textContent.trim() === ${JSON.stringify(text)} ||
      el.textContent.trim().includes(${JSON.stringify(text)})
    );
    if (!button) throw new Error("Missing button ${text}");
    button.click();
    return true;
  })()`;
  await evaluate(page, expression);
}

async function setTicketSize(page, size) {
  await evaluate(page, `(() => {
    const input = document.querySelector(".ticket-panel input[type='number']");
    if (!input) throw new Error("Missing ticket size input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(String(size))});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input.value;
  })()`);
}

async function typeAgentPrompt(page, prompt) {
  await evaluate(page, `(() => {
    const input = document.querySelector(".agent-chat-box input");
    if (!input) throw new Error("Missing agent chat input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(prompt)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input.value;
  })()`);
}

async function submitPaper(page, options = {}) {
  await clickButton(page, "Review paper order", ".ticket-panel");
  await waitFor(page, "!!document.querySelector('.confirm-modal')", 10_000);
  const modalText = await visibleText(page, ".confirm-modal");

  if (options.expectAgentCopy) {
    assert(/agent drafted/i.test(modalText), "Agent confirmation copy did not mention the agent draft");
  } else {
    assert(!/agent drafted/i.test(modalText), "Manual confirmation copy incorrectly mentioned agent drafting");
  }
  assert(/Paper orders are simulated and never call \/exchange\./i.test(modalText), "Paper modal did not show /exchange separation copy");

  await evaluate(page, `(() => {
    const checkbox = document.querySelector(".confirm-modal input[type='checkbox']");
    if (!checkbox) throw new Error("Missing acknowledgement checkbox");
    checkbox.click();
    return checkbox.checked;
  })()`);
  await clickButton(page, "Confirm paper order", ".confirm-modal");
  await waitFor(page, "document.querySelector('.submit-state')?.textContent.includes('Paper fill recorded') || document.querySelector('.submit-state')?.textContent.includes('Position updated')", 20_000);
  await waitFor(page, "!document.querySelector('.confirm-modal')", 10_000);
}

async function capture(page, name) {
  const shot = await page.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  const file = path.join(SCREENSHOT_DIR, name);
  await writeFile(file, Buffer.from(shot.data, "base64"));
  return file;
}

function countOccurrences(text, needle) {
  return (text.match(new RegExp(needle, "gu")) ?? []).length;
}

async function routeHealth(page) {
  for (const [route, expectedText] of ROUTES) {
    const res = await fetch(routeUrl(route));
    assert(res.status === 200, `${route} returned ${res.status}`);
    await navigate(page, routeUrl(route));
    await waitFor(page, "document.body.innerText.trim().length > 20", 20_000);
    await waitFor(
      page,
      `document.body.innerText.toLowerCase().includes(${JSON.stringify(expectedText.toLowerCase())})`,
      20_000,
    );
    const text = await visibleText(page);
    assert(!/404\s*This page could not be found|This page could not be found/i.test(text), `${route} rendered a not-found state`);
  }
}

async function apiPost(pathname, body, headers = {}) {
  return fetch(`${API_URL}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function orderAction() {
  return {
    type: "order",
    grouping: "na",
    orders: [
      {
        a: 0,
        b: true,
        p: "60000",
        s: "0.001",
        r: false,
        t: { limit: { tif: "Ioc" } },
      },
    ],
  };
}

function updateLeverageAction() {
  return {
    type: "updateLeverage",
    asset: 0,
    isCross: false,
    leverage: 3,
  };
}

function approveAgentAction() {
  return { type: "approveAgent" };
}

function approveBuilderFeeAction() {
  return { type: "approveBuilderFee", maxFeeRate: "1%" };
}

function paperDraft(overrides = {}) {
  return {
    symbol: "BTC-USD",
    side: "long",
    orderType: "market",
    sizeBtc: 0.01,
    leverage: 2,
    marginMode: "isolated",
    reduceOnly: false,
    fromAgent: false,
    ...overrides,
  };
}

async function apiSafetyChecks() {
  const guarded = [
    ["order", { action: orderAction() }],
    ["updateLeverage", { action: updateLeverageAction() }],
    ["approveAgent", { action: approveAgentAction(), user: TEST_USER }],
    ["approveBuilderFee", { action: approveBuilderFeeAction() }],
  ];

  for (const [name, payload] of guarded) {
    const unknown = await apiPost("/agent-trade/exchange", payload);
    assert(unknown.status === 451, `${name} unknown eligibility expected 451, got ${unknown.status}`);

    const restricted = await apiPost("/agent-trade/exchange", payload, {
      "cf-ipcountry": "US",
      "x-agent-trade-risk-accepted": "true",
      "x-agent-trade-terms-accepted": "true",
    });
    assert(restricted.status === 451, `${name} restricted eligibility expected 451, got ${restricted.status}`);
  }

  const sessionId = `e2e-api-${Date.now()}`;
  const paper = await apiPost(
    "/agent-trade/paper-orders",
    { draft: paperDraft(), estimatedEntry: 60000 },
    { "x-agent-trade-session-id": sessionId },
  );
  assert(paper.ok, `paper market order expected 200, got ${paper.status}`);
  const paperBody = await paper.json();
  assert(paperBody.mode === "paper", "paper order response did not mark paper mode");

  const limit = await apiPost(
    "/agent-trade/paper-orders",
    {
      draft: paperDraft({ orderType: "limit", limitPrice: 59000 }),
      estimatedEntry: 60000,
    },
    { "x-agent-trade-session-id": sessionId },
  );
  assert([400, 422].includes(limit.status), `paper limit order expected 400/422, got ${limit.status}`);
  const limitBody = await limit.json();
  assert(/limit orders are not simulated/i.test(limitBody.message), "paper limit rejection was unclear");

  const account = await fetch(`${API_URL}/agent-trade/paper-account`, {
    headers: { "x-agent-trade-session-id": sessionId },
  });
  assert(account.ok, `paper account expected 200, got ${account.status}`);
  const accountBody = await account.json();
  assert(accountBody.positions.length === 1, "paper account did not return session position");
  assert(accountBody.fills.length === 1, "paper account did not return session fill");
}

async function terminalDefaultSafety(page) {
  await navigate(page, routeUrl("/terminal"));
  await waitFor(page, "document.body.innerText.includes('Ask Agent.trade')", 20_000);
  const text = await visibleText(page);
  assert(/Paper mode only|Live trading unavailable|Paper mode active/i.test(text), "Missing paper/live eligibility banner");
  assert(/Paper/i.test(text), "Paper mode not visible");
  assert(/Simulated account values|Paper equity|Paper account/i.test(text), "Terminal did not label local account values as simulated/paper");
  assert(/Ask Agent.trade/i.test(text), "Agent panel heading missing");
  assert(/Hyperliquid candles|Synthetic fallback/i.test(text), "Chart candle source label missing");
  assert(/Live market data|Refreshing|Market data stale|Candles stale|API unavailable/i.test(text), "Terminal compact freshness label missing");
  assert(/Manual/i.test(text), "Ticket did not show Manual source by default");
  assert(!await evaluate(page, `(() => {
    const live = [...document.querySelectorAll('.mode-control button')].find((button) => button.textContent.trim() === 'Live');
    return Boolean(live && !live.disabled);
  })()`), "Live mode was selectable under local default eligibility");
}

async function paperLoop(page) {
  const networkUrls = [];
  page.on("Network.requestWillBeSent", (params) => {
    networkUrls.push(params.request.url);
  });

  await navigate(page, routeUrl("/terminal"));
  await waitFor(page, "document.body.innerText.includes('Ask Agent.trade')", 20_000);
  await evaluate(page, "localStorage.removeItem('agent-trade-paper-session-id'); true");
  await page.send("Page.reload", { ignoreCache: true });
  await waitFor(page, "document.body.innerText.includes('Ask Agent.trade') && localStorage.getItem('agent-trade-paper-session-id')", 20_000);
  const sessionId = await evaluate(page, "localStorage.getItem('agent-trade-paper-session-id')");

  const networkStart = networkUrls.length;
  await setTicketSize(page, "0.01");
  await submitPaper(page);

  await clickButton(page, "Fills", ".bottom-panel");
  const firstFills = await visibleText(page, ".bottom-panel");
  assert(/Paper/i.test(firstFills), "First manual paper fill was not visible");

  await clickButton(page, "Positions", ".bottom-panel");
  const firstPositions = await visibleText(page, ".bottom-panel");
  assert(/Paper/i.test(firstPositions), "First manual paper position was not visible");
  const firstPaperSize = extractFirstPaperPositionSize(firstPositions);

  await setTicketSize(page, "0.02");
  await submitPaper(page);
  await clickButton(page, "Fills", ".bottom-panel");
  const secondFills = await visibleText(page, ".bottom-panel");
  assert(countOccurrences(secondFills, "Paper") >= 2, "Second same-side paper fill did not increase fill count");

  await clickButton(page, "Positions", ".bottom-panel");
  const secondPositions = await visibleText(page, ".bottom-panel");
  const secondPaperSize = extractFirstPaperPositionSize(secondPositions);
  assert(secondPaperSize > firstPaperSize, "Second same-side paper order did not increase netted position size");

  await clickButton(page, "Short", ".ticket-panel");
  await setTicketSize(page, "0.01");
  await submitPaper(page);
  await clickButton(page, "Positions", ".bottom-panel");
  const reducedPositions = await visibleText(page, ".bottom-panel");
  const reducedPaperSize = extractFirstPaperPositionSize(reducedPositions);
  assert(reducedPaperSize < secondPaperSize, "Opposite-side paper order did not reduce/close/flip the netted position");

  await waitFor(page, "document.body.innerText.includes('Live market data')", 20_000);
  await typeAgentPrompt(page, "Should I long BTC here?");
  await clickButton(page, "Send", ".agent-panel");
  await waitFor(page, "document.querySelector('.agent-user-message')?.innerText.includes('Should I long BTC here?')", 10_000);
  await waitFor(page, "[...document.querySelectorAll('.agent-panel button')].some((button) => button.textContent.includes('Send to ticket'))", 20_000);
  const agentText = await visibleText(page, ".agent-panel");
  assert(/Agent.trade response/i.test(agentText), "Typed user message or agent response did not render");
  assert(/Market read|No clean setup|Refusing to draft/i.test(agentText), "Deterministic typed agent response did not render");
  await clickButton(page, "Send to ticket", ".agent-panel");
  await waitFor(page, "document.querySelector('.ticket-panel')?.innerText.includes('From Agent')", 10_000);
  await submitPaper(page, { expectAgentCopy: true });

  await clickButton(page, "Positions", ".bottom-panel");
  const agentPositions = await visibleText(page, ".bottom-panel");
  assert(/Paper/i.test(agentPositions), "Agent-drafted paper order did not leave a visible paper position");

  await waitFor(page, "document.body.innerText.includes('Live market data')", 20_000);
  await typeAgentPrompt(page, "sell ETH");
  await clickButton(page, "Send", ".agent-panel");
  await waitFor(page, "document.querySelector('.agent-user-message')?.innerText.includes('sell ETH')", 10_000);
  await waitFor(page, "[...document.querySelectorAll('.agent-panel button')].some((button) => button.textContent.includes('Send to ticket'))", 20_000);
  const shortAgentText = await visibleText(page, ".agent-panel");
  assert(/Market read/i.test(shortAgentText), "Short deterministic agent response did not render");
  await clickButton(page, "Send to ticket", ".agent-panel");
  await waitFor(page, "document.querySelector('.ticket-panel')?.innerText.includes('From Agent')", 10_000);
  await waitFor(page, "document.querySelector('.ticket-panel')?.innerText.includes('ETH-USD')", 10_000);
  const shortSelected = await evaluate(page, `(() => {
    const buttons = [...document.querySelectorAll('.ticket-panel .segmented button')];
    return buttons.some((button) => button.textContent.trim() === "Short" && button.classList.contains("active"));
  })()`);
  assert(shortSelected, "Short agent proposal did not set ticket side to short");
  const ethTicket = await visibleText(page, ".ticket-panel");
  assert(/ETH-USD/i.test(ethTicket), "Typed sell ETH did not switch the ticket to ETH");
  const shortProposalScreenshot = await capture(page, "agent-trade-8c-short-proposal.png");
  await submitPaper(page, { expectAgentCopy: true });

  await clickButton(page, "Fills", ".bottom-panel");
  const shortFills = await visibleText(page, ".bottom-panel");
  assert(/Paper/i.test(shortFills), "Short agent-drafted paper fill was not visible");

  const marketsBody = await waitForJson(`${API_URL}/markets`);
  const hypeSupported = Boolean(marketsBody.perps?.some((market) => market.name === "HYPE"));
  await waitFor(page, "document.body.innerText.includes('Live market data')", 20_000);
  await typeAgentPrompt(page, "thoughts on Hyperliquid");
  await clickButton(page, "Send", ".agent-panel");
  await waitFor(page, "document.querySelector('.agent-user-message')?.innerText.includes('thoughts on Hyperliquid')", 10_000);
  await waitFor(page, "Boolean(document.querySelector('.agent-panel .agent-answer'))", 20_000);
  const aliasAgentText = await visibleText(page, ".agent-panel");
  assert(!/HYPERLIQUID is not available|THOUGHTS is not available/i.test(aliasAgentText), "Hyperliquid alias produced an unsupported generic-word response");
  if (hypeSupported) {
    await waitFor(page, "document.body.innerText.includes('HYPE-USD')", 20_000);
  }

  const exchangeCalls = networkUrls
    .slice(networkStart)
    .filter((url) => /\/(?:agent-trade\/)?exchange(?:\?|$)/u.test(new URL(url).pathname));
  assert(exchangeCalls.length === 0, `Paper flow called exchange endpoints: ${exchangeCalls.join(", ")}`);

  const terminalScreenshot = await capture(page, "agent-trade-e2e-terminal.png");

  await navigate(page, routeUrl("/portfolio"));
  await waitFor(page, "document.body.innerText.toLowerCase().includes('portfolio risk')", 20_000);
  await waitFor(page, "Boolean(document.querySelector('.paper-ledger-badge'))", 20_000);
  const portfolioText = await visibleText(page, ".portfolio-page");
  assert(/Paper/i.test(portfolioText), "Portfolio did not show paper ledger rows");
  assert(/Paper positions are simulated and do not imply live Hyperliquid exposure/i.test(portfolioText), "Portfolio paper-risk copy missing");
  const portfolioScreenshot = await capture(page, "agent-trade-e2e-portfolio.png");

  const browser = await createBrowserClient();
  const { browserContextId } = await browser.send("Target.createBrowserContext");
  const privateTarget = await browser.send("Target.createTarget", {
    browserContextId,
    url: routeUrl("/terminal"),
  });
  const privateInfo = await waitForTarget(privateTarget.targetId);
  const privatePage = await createCdpClient(privateInfo.webSocketDebuggerUrl);
  await privatePage.send("Runtime.enable");
  await privatePage.send("Page.enable");
  await waitFor(privatePage, "document.body.innerText.includes('Ask Agent.trade') && localStorage.getItem('agent-trade-paper-session-id')", 20_000);
  const privateSessionId = await evaluate(privatePage, "localStorage.getItem('agent-trade-paper-session-id')");
  assert(privateSessionId !== sessionId, "Second browser context reused the first paper session id");
  const privatePaperRows = await evaluate(privatePage, "document.querySelectorAll('.paper-ledger-badge').length");
  assert(privatePaperRows === 0, "Second browser context showed the first paper ledger");
  const privateAccount = await fetch(`${API_URL}/agent-trade/paper-account`, {
    headers: { "x-agent-trade-session-id": privateSessionId },
  });
  const privateAccountBody = await privateAccount.json();
  assert(privateAccountBody.positions.length === 0, "Second browser context shared paper positions");
  assert(privateAccountBody.fills.length === 0, "Second browser context shared paper fills");
  const privateScreenshot = await capture(privatePage, "agent-trade-e2e-private-terminal.png");
  await browser.send("Target.disposeBrowserContext", { browserContextId });
  privatePage.close();
  browser.close();

  return {
    sessionId,
    terminalScreenshot,
    shortProposalScreenshot,
    portfolioScreenshot,
    privateScreenshot,
    hypeSupported,
  };
}

function extractFirstPaperPositionSize(text) {
  const match = text.match(/Paper\s+long\s+([0-9.]+)\s+BTC|Paper\s+short\s+([0-9.]+)\s+BTC/u);
  if (!match) {
    throw new Error(`Could not parse first paper position from: ${text}`);
  }
  return Number(match[1] ?? match[2]);
}

async function legacyFailClosed(page) {
  const networkUrls = [];
  page.on("Network.requestWillBeSent", (params) => {
    networkUrls.push(params.request.url);
  });

  await navigate(page, routeUrl("/approve"));
  await waitFor(page, "document.body.innerText.includes('Legacy wallet approvals are disabled')", 20_000);
  const approveText = await visibleText(page);
  assert(/Compatibility approvals unavailable/i.test(approveText), "/approve did not show compatibility disabled state");
  assert(!/Approve builder-fee ceiling/i.test(approveText), "/approve exposed builder-fee approval CTA");
  assert(!/Revoke approval/i.test(approveText), "/approve exposed revoke CTA");
  assert(!/Sends to Hyperliquid Bridge2/i.test(approveText), "/approve exposed Bridge2 deposit copy");
  assert(!/Get USDC on Arbitrum/i.test(approveText), "/approve exposed Get USDC CTA");

  await navigate(page, routeUrl("/oauth/authorize"));
  await waitFor(page, "document.body.innerText.includes('Compatibility approvals disabled')", 20_000);
  const oauthText = await visibleText(page);
  assert(/OAuth compatibility unavailable/i.test(oauthText), "/oauth/authorize did not show compatibility disabled copy");
  assert(!/Sign compatibility approval/i.test(oauthText), "/oauth/authorize exposed compatibility signature CTA");
  assert(!/approveAgent|approveBuilderFee/u.test(oauthText), "/oauth/authorize exposed raw approval action copy");

  const exchangeCalls = networkUrls.filter((url) => /\/exchange(?:\?|$)/u.test(new URL(url).pathname));
  assert(exchangeCalls.length === 0, `Legacy fail-closed pages called /exchange: ${exchangeCalls.join(", ")}`);
}

async function main() {
  console.log(`Agent.trade E2E QA gate`);
  console.log(`WEB_URL=${WEB_URL}`);
  console.log(`API_URL=${API_URL}`);

  await check("API health", async () => {
    const res = await fetch(`${API_URL}/agent-trade/eligibility`);
    assert(res.ok, `/agent-trade/eligibility returned ${res.status}`);
    const body = await res.json();
    return `eligibility=${body.state}`;
  });

  let chromeHandle;
  let pageHandle;
  try {
    chromeHandle = await launchChrome();
    pageHandle = await createPage(routeUrl("/terminal"));
    const { page } = pageHandle;

    await check("Route health", async () => {
      await routeHealth(page);
      return `${ROUTES.length} routes rendered`;
    });

    await check("Terminal default safety state", async () => {
      await terminalDefaultSafety(page);
      return "paper mode and agent panel visible";
    });

    await check("Manual, repeat, opposite-side, and agent paper loop", async () => {
      const artifacts = await paperLoop(page);
      return `session=${artifacts.sessionId}; hypeSupported=${artifacts.hypeSupported}; screenshots=${artifacts.terminalScreenshot}, ${artifacts.shortProposalScreenshot}, ${artifacts.portfolioScreenshot}, ${artifacts.privateScreenshot}`;
    });

    await check("Legacy approval/OAuth fail closed", async () => {
      await legacyFailClosed(page);
      return "no approval CTAs or /exchange calls";
    });

    await check("API guarded/live and paper safety", async () => {
      await apiSafetyChecks();
      return "guarded live mutations rejected; paper ledger scoped";
    });
  } finally {
    pageHandle?.page?.close();
    pageHandle?.browser?.close();
    await chromeHandle?.close();
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    process.exitCode = 1;
    console.error(JSON.stringify({ failures }, null, 2));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});

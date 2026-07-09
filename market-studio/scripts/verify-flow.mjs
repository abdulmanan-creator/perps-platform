import { setTimeout as delay } from "node:timers/promises";

const endpoint = process.env.CDP_ENDPOINT ?? "http://127.0.0.1:9223";
const appUrl = process.env.APP_URL ?? "http://127.0.0.1:5173/";

const targets = await fetch(`${endpoint}/json`).then((response) => response.json());
const pageTarget = targets.find((target) => target.type === "page");

if (!pageTarget?.webSocketDebuggerUrl) {
  throw new Error(`No Chrome page target found at ${endpoint}`);
}

const socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data.toString());
  if (!message.id) {
    return;
  }

  const callbacks = pending.get(message.id);
  if (!callbacks) {
    return;
  }

  pending.delete(message.id);
  if (message.error) {
    callbacks.reject(new Error(message.error.message));
    return;
  }

  callbacks.resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

function send(method, params = {}) {
  const id = nextId;
  nextId += 1;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

async function evaluate(expression) {
  const response = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text);
  }

  return response.result.value;
}

async function clickButton(text) {
  const didClick = await evaluate(`(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)});
    if (!button) {
      return false;
    }
    button.click();
    return true;
  })()`);

  if (!didClick) {
    throw new Error(`Button not found: ${text}`);
  }
}

async function clickFirstApply() {
  const didClick = await evaluate(`(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === "Apply" && !candidate.disabled);
    if (!button) {
      return false;
    }
    button.click();
    return true;
  })()`);

  if (!didClick) {
    throw new Error("No enabled Apply button found");
  }
}

async function screen() {
  return await evaluate(`document.querySelector(".debug-label")?.textContent ?? ""`);
}

async function waitForScreen(expected) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const current = await screen();
    if (current === `screen=${expected}`) {
      return;
    }
    await delay(100);
  }

  throw new Error(`Expected screen=${expected}, saw ${await screen()}`);
}

async function assertBodyIncludes(text) {
  const hasText = await evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
  if (!hasText) {
    throw new Error(`Expected page text not found: ${text}`);
  }
}

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: appUrl });
await delay(600);

await waitForScreen("studio");
await clickButton("Public companies");
await assertBodyIncludes("Will Meta do more large-scale layoffs by end of year?");
await clickButton("Use as template");
await waitForScreen("form");
await assertBodyIncludes("AI warning");
await clickButton("Review with Agent.trade");
await waitForScreen("review");
await clickFirstApply();
await clickFirstApply();
await clickFirstApply();
await assertBodyIncludes("1,000+ employees");
await assertBodyIncludes("Role-specific reductions count only if the same action affects 1,000+ direct Meta employees.");
await clickButton("Preview proposal");
await waitForScreen("preview");
await clickButton("Submit proposal");
await waitForScreen("success");
await clickButton("Back to Market Studio");
await waitForScreen("studio");

socket.close();
console.log("Verified studio -> form -> review -> preview -> success -> studio");

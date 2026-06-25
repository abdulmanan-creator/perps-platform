import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";

import { loadConfig } from "./config.js";
import { ApiException, sendError } from "./errors.js";
import { geoDecision, isGlobalGeoExemptPath } from "./helpers/geo.js";
import { metrics } from "./helpers/metrics.js";
import { registerRoutes } from "./routes/index.js";

// Load .env from the monorepo root if present. Optional — on Render env vars
// come from the service config, not a file. dotenv silently no-ops if the
// path doesn't exist, so we just nudge the user once.
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../../../.env");
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else if (process.env.NODE_ENV !== "production") {
  // eslint-disable-next-line no-console
  console.warn(
    `[api] No .env file at ${envPath}.\n` +
      `      Copy the template:  cp .env.example .env  (from the repo root)\n` +
      `      Then edit it with your real builder address + Privy app id.\n`,
  );
}

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(
    `[api] Failed to load config:\n  ${(err as Error).message}\n\n` +
      `Quick fix from the repo root:\n` +
      `  cp .env.example .env\n` +
      `Then edit .env with your real ALCHEMY_BUILDER_ADDRESS + NEXT_PUBLIC_PRIVY_APP_ID.\n` +
      `The placeholder zero address works for booting the UI; you need a real one to sign anything.\n`,
  );
  process.exit(1);
}

const app = Fastify({
  logger: {
    level: config.LOG_LEVEL,
    transport:
      config.NODE_ENV === "development"
        ? { target: "pino-pretty", options: { translateTime: "HH:MM:ss.l" } }
        : undefined,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.privateKey",
        "*.secret",
      ],
      censor: "[redacted]",
    },
  },
  trustProxy: true,
});

// Decorate so route handlers can pull config without re-importing.
app.decorate("config", config);
declare module "fastify" {
  interface FastifyInstance {
    config: ReturnType<typeof loadConfig>;
  }
}

await app.register(cors, {
  origin: config.WEB_ORIGIN.split(",").map((o) => o.trim()),
  credentials: false,
});

await app.register(rateLimit, {
  max: 30,
  timeWindow: "1 second",
  // Per-IP. Behind Render's proxy `trustProxy: true` gets us the real client IP.
  // Write paths (/exchange, /agent/exchange) carry their own tighter bucket —
  // see WRITE_RATE_LIMIT in routes/exchange.ts.
});

// Jurisdiction gate. Runs before route handlers for legacy/live mutation
// surfaces. Agent.trade paper/read-only endpoints stay open so restricted or
// unknown users can enter the app in paper-only mode; live order submission is
// still enforced by /agent-trade/exchange's own eligibility guard.
app.addHook("onRequest", async (req, reply) => {
  if (config.NODE_ENV === "test" || process.env.VITEST === "true") return;
  if (isGlobalGeoExemptPath(req.routeOptions?.url ?? req.url)) return;
  const decision = geoDecision(req, config);
  if (decision.allowed) return;
  metrics.geoBlocked.inc({ country: decision.country ?? "none", reason: decision.reason });
  req.log.warn(
    { country: decision.country, reason: decision.reason, path: req.url },
    "geo_blocked",
  );
  return sendError(
    reply,
    new ApiException(
      "REGION_BLOCKED",
      "This service is not available in your region.",
      "Access to perpetuals, spot, and prediction-market trading is restricted " +
        "in the United States and sanctioned jurisdictions. If you believe this " +
        "is an error, contact support — do not attempt to bypass this restriction.",
    ),
  );
});

// Request counts by route template (not raw URL — keeps label cardinality
// bounded), method, and status. Excludes /metrics itself to avoid the
// scraper inflating its own numbers.
app.addHook("onResponse", async (req, reply) => {
  const route = req.routeOptions?.url ?? "unmatched";
  if (route === "/metrics") return;
  metrics.httpRequests.inc({
    route,
    method: req.method,
    status: reply.statusCode,
  });
});

app.setErrorHandler((err, req, reply) => {
  if (err instanceof ApiException) {
    req.log.warn({ code: err.code, msg: err.message }, "api_exception");
    return sendError(reply, err);
  }
  req.log.error({ err }, "unhandled_error");
  return sendError(
    reply,
    new ApiException(
      "INTERNAL_ERROR",
      "Something went wrong on our end.",
      "Retry the request. If it keeps failing, the API is down — check status.",
    ),
  );
});

app.get("/healthz", async () => ({ ok: true, builder: config.ALCHEMY_BUILDER_ADDRESS }));

// Privy JWT verification is wired per-route inside the agent-signing path
// (apps/api/src/routes/agent.ts → POST /agent/exchange). The verifier lives
// in apps/api/src/helpers/privyAuth.ts and reads PRIVY_APP_ID +
// PRIVY_APP_SECRET from config. Other routes remain public and stateless.
// If we add more authenticated surfaces, prefer the same per-route pattern
// over a global preHandler so unauth'd endpoints stay fast.

await registerRoutes(app);

// Graceful shutdown: Render sends SIGTERM on deploys/restarts. fastify.close()
// stops accepting new connections and waits for in-flight requests (an order
// mid-forward to HL completes instead of dying with a socket reset). The
// 10s force-exit covers a hung upstream holding a request open past Render's
// kill window.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutdown_start");
    const force = setTimeout(() => {
      app.log.warn("shutdown_forced");
      process.exit(1);
    }, 10_000);
    force.unref();
    void app.close().then(() => {
      app.log.info("shutdown_complete");
      process.exit(0);
    });
  });
}

try {
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
  app.log.info(
    { builder: config.ALCHEMY_BUILDER_ADDRESS, hl: config.HYPERLIQUID_API_URL },
    "api_listening",
  );
} catch (err) {
  app.log.fatal({ err }, "api_failed_to_start");
  process.exit(1);
}

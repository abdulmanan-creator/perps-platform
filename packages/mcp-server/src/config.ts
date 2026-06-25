/**
 * MCP server config. Loaded from env at process start.
 *
 * The server runs in one of two transport modes — stdio (default, for Claude
 * desktop) or http (for Claude Web + ChatGPT + any hosted MCP host). Pick via
 * MCP_TRANSPORT.
 *
 * Auth:
 *   - stdio mode: ALCHEMY_HL_TRADE_KEY is a hot private key on this process.
 *     One key = one user. Suitable for single-user power-user setups.
 *   - http mode:  per-request auth via Authorization: Bearer <privy-jwt> from
 *     the calling host (Claude/ChatGPT). MCP server forwards the JWT to the
 *     backend's /agent/exchange path; backend signs with the user's per-user
 *     agent key. Multi-tenant. No keys on this process.
 *
 * Env vars:
 *   ALCHEMY_HL_API_URL    URL of our backend's /exchange API (default localhost:8080)
 *   MCP_TRANSPORT         "stdio" | "http"  (default "stdio")
 *   MCP_TOOL_MODE         "draft" | "legacy-execution" (default "draft")
 *   MCP_PORT              http listen port  (default 3001, only used when http)
 *   ALCHEMY_HL_TRADE_KEY  hot key for stdio mode (32 bytes hex, optional → read-only mode)
 *   LOG_LEVEL             "debug" | "info" | "warn" | "error" (default "info")
 *                         logs go to stderr only in stdio mode (protocol owns stdout);
 *                         http mode logs may also go to stdout.
 */

import { z } from "zod";

/**
 * Normalize a URL-ish string into a full URL with scheme.
 *
 * Render's `fromService.property: hostport` substitution returns a bare
 * hostname like `alchemy-hl-api.onrender.com` — no `https://`. Our config used
 * to require `z.string().url()` and would fail validation on those values. So
 * we accept bare hostnames + URLs both, and prepend `https://` when no scheme
 * is present. Localhost / 127.0.0.1 / a literal port get `http://` instead so
 * dev still works.
 *
 * Examples:
 *   "alchemy-hl-mcp.onrender.com"      → "https://alchemy-hl-mcp.onrender.com"
 *   "localhost:8080"                   → "http://localhost:8080"
 *   "https://alchemy-hl-mcp.onrender.com" (no change)
 *   "http://localhost:8080" (no change)
 */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(trimmed);
  return `${isLocal ? "http" : "https"}://${trimmed}`;
}

const ConfigSchema = z.object({
  // URL-ish: bare hostname accepted (Render fromService:hostport returns
  // bare hostnames). Normalized to full URL via normalizeUrl in loadConfig.
  ALCHEMY_HL_API_URL: z.string().min(1).default("http://localhost:8080"),
  MCP_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  MCP_TOOL_MODE: z.enum(["draft", "legacy-execution"]).default("draft"),
  // HTTP listen port. Render / Fly / Heroku inject PORT; MCP_PORT is the
  // explicit local-dev override. PORT wins when both are set.
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  MCP_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  ALCHEMY_HL_TRADE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x + 64 hex chars (32 bytes)")
    .optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  // ---- OAuth (Path B) -----------------------------------------------------
  // Public URL of this MCP server. Used as `issuer` in OAuth metadata + as
  // the base for token/registration endpoint advertisements. For local dev
  // default to http://localhost:<port>; in production set to the real URL.
  // URL-ish (bare hostname OK); normalized in loadConfig.
  MCP_PUBLIC_URL: z.string().min(1).optional(),
  // Public URL of the web app — where users land for the /oauth/authorize UI.
  // Default to localhost:3000 for dev. URL-ish (bare hostname OK).
  WEB_PUBLIC_URL: z.string().min(1).default("http://localhost:3000"),
  // HS256 secret for our OAuth JWTs. Shared with the api service. Optional;
  // without it the OAuth endpoints return 503-style errors.
  OAUTH_SIGNING_SECRET: z
    .string()
    .regex(/^[0-9a-fA-F]{32,}$/, "must be at least 16 bytes hex")
    .optional(),
});

export type Config = Omit<
  z.infer<typeof ConfigSchema>,
  "PORT" | "MCP_PORT" | "MCP_PUBLIC_URL"
> & {
  hasSigner: boolean;
  /** Effective HTTP port: PORT (host-injected) wins, falls back to MCP_PORT. */
  httpPort: number;
  /** Always resolved by loadConfig (env value or localhost fallback). */
  MCP_PUBLIC_URL: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.parse(env);
  const httpPort = parsed.PORT ?? parsed.MCP_PORT;
  return {
    ALCHEMY_HL_API_URL: normalizeUrl(parsed.ALCHEMY_HL_API_URL),
    MCP_TRANSPORT: parsed.MCP_TRANSPORT,
    MCP_TOOL_MODE: parsed.MCP_TOOL_MODE,
    ALCHEMY_HL_TRADE_KEY: parsed.ALCHEMY_HL_TRADE_KEY,
    LOG_LEVEL: parsed.LOG_LEVEL,
    hasSigner: !!parsed.ALCHEMY_HL_TRADE_KEY,
    httpPort,
    MCP_PUBLIC_URL: normalizeUrl(parsed.MCP_PUBLIC_URL ?? `http://localhost:${httpPort}`),
    WEB_PUBLIC_URL: normalizeUrl(parsed.WEB_PUBLIC_URL),
    OAUTH_SIGNING_SECRET: parsed.OAUTH_SIGNING_SECRET,
  };
}

const LEVELS: Record<Config["LOG_LEVEL"], number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Logger that writes to stderr. CRITICAL in stdio mode: MCP protocol uses
 * stdout for JSON-RPC frames; anything we write to stdout breaks the
 * transport. In http mode logging to stderr is still fine and matches the
 * stdio mode's behavior for log consistency.
 */
export function makeLogger(cfg: Config) {
  const threshold = LEVELS[cfg.LOG_LEVEL];
  function log(level: Config["LOG_LEVEL"], msg: string, meta?: unknown) {
    if (LEVELS[level] < threshold) return;
    const line = meta !== undefined ? `[${level}] ${msg} ${JSON.stringify(meta)}` : `[${level}] ${msg}`;
    process.stderr.write(line + "\n");
  }
  return {
    debug: (m: string, x?: unknown) => log("debug", m, x),
    info: (m: string, x?: unknown) => log("info", m, x),
    warn: (m: string, x?: unknown) => log("warn", m, x),
    error: (m: string, x?: unknown) => log("error", m, x),
  };
}

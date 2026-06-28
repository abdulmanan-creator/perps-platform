/**
 * Typed, validated config loaded once at process start.
 *
 * Reads from process.env (which is populated by dotenv via --env-file in dev,
 * or by Render/host in prod). Crashes early on bad config — better than
 * silently injecting a zero-address builder code into someone's order.
 */

import { getAddress } from "viem";
import { z } from "zod";

const HEX_ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX_PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

const emptyToUndefined = (value: unknown) => value === "" ? undefined : value;

function parseAddressSet(input: string): ReadonlySet<string> {
  return new Set(
    input
      .split(",")
      .map((address) => address.trim())
      .filter((address) => address.length > 0)
      .map((address) => getAddress(address).toLowerCase()),
  );
}

/**
 * Normalize a URL-ish string into a full URL with scheme.
 *
 * Render's `fromService.property: hostport` substitution returns a bare
 * hostname (no `https://`). We accept that and prepend the right scheme
 * (`http://` for localhost, `https://` otherwise) so things downstream
 * (CORS origin match, fetch URLs, etc.) work without a scheme footgun.
 *
 * Comma-separated origin lists (multiple allowed origins) are preserved —
 * normalize each entry independently.
 */
function normalizeOrigins(input: string): string {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const noTrailing = s.replace(/\/+$/, "");
      if (/^https?:\/\//i.test(noTrailing)) return noTrailing;
      const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(
        noTrailing,
      );
      return `${isLocal ? "http" : "https"}://${noTrailing}`;
    })
    .join(",");
}

const ConfigSchema = z.object({
  ALCHEMY_BUILDER_ADDRESS: z
    .string()
    .regex(HEX_ADDR, "must be a 0x-prefixed 20-byte address"),
  HYPERLIQUID_API_URL: z.string().url(),
  PERPS_BUILDER_FEE_BPS: z.coerce.number().int().min(0),
  SPOT_BUILDER_FEE_BPS: z.coerce.number().int().min(0),
  MAX_BUILDER_FEE_BPS_PERPS: z.coerce.number().int().min(0).default(10),
  MAX_BUILDER_FEE_BPS_SPOT: z.coerce.number().int().min(0).default(100),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  /**
   * 32-byte hex master seed used to deterministically derive per-user agent
   * keys for HL approveAgent / unattended trading (Layer 2). Optional — if
   * unset, /exchange will refuse to build approveAgent actions and the
   * /agent/* endpoints return INVALID_PARAMS. Generate with:
   *   openssl rand -hex 32
   * Keep this secret. Anyone with this seed can derive every user's agent
   * key (which can trade their HL account but not withdraw).
   */
  AGENT_MASTER_SEED: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x + 64 hex chars (32 bytes)")
      .optional(),
  ),
  /**
   * Privy app credentials, server-side. Both required to verify the JWT a
   * client sends in `Authorization: Bearer <token>` for /agent/exchange.
   * Without these, the agent-signing path is disabled. APP_ID is the same
   * public string as NEXT_PUBLIC_PRIVY_APP_ID; APP_SECRET is secret.
   */
  PRIVY_APP_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  PRIVY_APP_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  /**
   * HS256 signing secret for the OAuth tokens our MCP server issues to
   * Claude Web / ChatGPT Apps. Shared between api + mcp + (web app for code
   * issuance). 32 bytes hex. Generate via `openssl rand -hex 32`.
   * Optional — if absent, OAuth endpoints return INVALID_PARAMS and only
   * the Privy-JWT auth path works.
   */
  OAUTH_SIGNING_SECRET: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^[0-9a-fA-F]{32,}$/, "must be at least 16 bytes hex")
      .optional(),
  ),
  /**
   * Bearer token guarding GET /metrics (Prometheus exposition — includes
   * estimated fee revenue). Optional: unset leaves the endpoint open, which
   * is fine locally but set it in production.
   */
  METRICS_TOKEN: z.preprocess(emptyToUndefined, z.string().min(16).optional()),
  /**
   * Optional Postgres connection string for Agent.trade DB-1 audit logging.
   * If absent, audit logging no-ops so local development and tests stay
   * database-free.
   */
  DATABASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  /**
   * Hard server-side cap on leverage when the agent path signs an
   * updateLeverage action. Users can still set higher leverage via /exchange
   * with their primary wallet signature. Default 10 — conservative for AI
   * agents acting unattended. Raise if your traders need more headroom.
   */
  MAX_AGENT_LEVERAGE_PERPS: z.coerce.number().int().min(1).max(50).default(10),
  /**
   * Geo-restriction master switch. When true (default), requests originating
   * from a restricted jurisdiction are rejected with REGION_BLOCKED (HTTP 451)
   * before they reach any trading route. Set to "false" only for local dev or
   * a jurisdiction-neutral deployment you've cleared with counsel.
   */
  GEO_BLOCK_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /**
   * Comma-separated ISO 3166-1 alpha-2 country codes to block. Defaults to the
   * US plus the OFAC-embargoed set, mirroring the venues we route into
   * (Hyperliquid restricts the same list). Cloudflare's CF-IPCountry is
   * country-granular only, so subdivision bans (e.g. Ontario, CA-ON) can't be
   * enforced here — handle those at the CF WAF / edge if required.
   */
  RESTRICTED_COUNTRIES: z
    .string()
    .default("US,CU,IR,KP,SY,RU"),
  /**
   * Header carrying the client's resolved country. Default is Cloudflare's
   * `cf-ipcountry` (CF sits in front of the relay). Override for other edges
   * (e.g. `x-vercel-ip-country`, `fly-client-country`).
   */
  GEO_COUNTRY_HEADER: z.string().default("cf-ipcountry"),
  /**
   * When true, requests whose country cannot be determined (header missing or
   * "XX"/unknown — e.g. someone hitting the Render origin directly, bypassing
   * Cloudflare) are blocked rather than allowed. Recommended `true` in prod;
   * defaults `false` so local dev and health checks aren't blackholed.
   */
  GEO_FAIL_CLOSED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  AGENT_TRADE_MAINNET_EXECUTION_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  AGENT_TRADE_LIVE_TRADING_KILL_SWITCH: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  AGENT_TRADE_MIN_ORDER_NOTIONAL_USD: z.coerce.number().positive().default(10),
  AGENT_TRADE_HIP4_MIN_ORDER_COST_USD: z.coerce.number().positive().default(10),
  AGENT_TRADE_HIP4_EFFECTIVE_MIN_ORDER_COST_USD: z.coerce.number().positive().default(11),
  AGENT_TRADE_ORDER_NOTIONAL_CAP_USD: z.coerce.number().nonnegative().default(250),
  AGENT_TRADE_DAILY_NOTIONAL_CAP_USD: z.coerce.number().nonnegative().default(1000),
  AGENT_TRADE_INTERNAL_ALLOWLIST: z.string().default(""),
  AGENT_TRADE_REQUIRE_RISK_ACK: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  AGENT_TRADE_REQUIRE_GEO_ELIGIBILITY: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  AGENT_TRADE_ENABLE_GASLESS_HL_DEPOSIT: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  AGENT_TRADE_ENABLE_HIP4_LIVE_TRADING: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  AGENT_TRADE_GASLESS_DEPOSIT_ALLOWED_WALLETS: z.string().default(""),
  AGENT_TRADE_DEPOSIT_RELAYER_PRIVATE_KEY: z.preprocess(
    emptyToUndefined,
    z.string().regex(HEX_PRIVATE_KEY, "must be a 0x-prefixed 32-byte private key").optional(),
  ),
  AGENT_TRADE_ARBITRUM_RPC_URL: z.string().url().default("https://arb1.arbitrum.io/rpc"),
  AGENT_TRADE_HL_BRIDGE_ARBITRUM: z
    .string()
    .regex(HEX_ADDR, "must be a 0x-prefixed 20-byte address")
    .default("0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7"),
  AGENT_TRADE_USDC_ARBITRUM: z
    .string()
    .regex(HEX_ADDR, "must be a 0x-prefixed 20-byte address")
    .default("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
});

export type Config = Omit<
  z.infer<typeof ConfigSchema>,
  "ALCHEMY_BUILDER_ADDRESS"
> & {
  ALCHEMY_BUILDER_ADDRESS: `0x${string}`;
  /** Lowercased copy of the builder address for case-insensitive compares. */
  builderAddressLower: string;
  /** True iff HYPERLIQUID_API_URL points at testnet (best-effort heuristic). */
  isTestnet: boolean;
  /** Parsed RESTRICTED_COUNTRIES as an uppercased Set for O(1) lookups. */
  restrictedCountries: ReadonlySet<string>;
  /** Lowercased addresses allowed to exercise mainnet execution. */
  agentTradeAllowlist: ReadonlySet<string>;
  /** Lowercased wallets allowed to use the gasless deposit relayer. */
  gaslessDepositAllowedWallets: ReadonlySet<string>;
  /** Checksummed Hyperliquid Bridge2 contract on Arbitrum. */
  AGENT_TRADE_HL_BRIDGE_ARBITRUM: `0x${string}`;
  /** Checksummed native Circle USDC contract on Arbitrum. */
  AGENT_TRADE_USDC_ARBITRUM: `0x${string}`;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.parse(env);

  // Cap-check the configured fees against protocol maxima. Crash on misconfig.
  if (parsed.PERPS_BUILDER_FEE_BPS > parsed.MAX_BUILDER_FEE_BPS_PERPS) {
    throw new Error(
      `PERPS_BUILDER_FEE_BPS (${parsed.PERPS_BUILDER_FEE_BPS}) > MAX_BUILDER_FEE_BPS_PERPS (${parsed.MAX_BUILDER_FEE_BPS_PERPS})`,
    );
  }
  if (parsed.SPOT_BUILDER_FEE_BPS > parsed.MAX_BUILDER_FEE_BPS_SPOT) {
    throw new Error(
      `SPOT_BUILDER_FEE_BPS (${parsed.SPOT_BUILDER_FEE_BPS}) > MAX_BUILDER_FEE_BPS_SPOT (${parsed.MAX_BUILDER_FEE_BPS_SPOT})`,
    );
  }

  // viem's typed-data hashing rejects non-EIP-55-checksummed mixed-case
  // addresses, so we normalize at load time. getAddress also validates the
  // address shape (length + hex).
  const checksummed = getAddress(parsed.ALCHEMY_BUILDER_ADDRESS);
  const hlBridgeArbitrum = getAddress(parsed.AGENT_TRADE_HL_BRIDGE_ARBITRUM);
  const usdcArbitrum = getAddress(parsed.AGENT_TRADE_USDC_ARBITRUM);

  const restrictedCountries = new Set(
    parsed.RESTRICTED_COUNTRIES.split(",")
      .map((c) => c.trim().toUpperCase())
      .filter((c) => c.length > 0),
  );
  const agentTradeAllowlist = new Set(
    parsed.AGENT_TRADE_INTERNAL_ALLOWLIST.split(",")
      .map((address) => address.trim().toLowerCase())
      .filter((address) => address.length > 0),
  );
  const gaslessDepositAllowedWallets = parseAddressSet(
    parsed.AGENT_TRADE_GASLESS_DEPOSIT_ALLOWED_WALLETS,
  );

  return {
    ...parsed,
    ALCHEMY_BUILDER_ADDRESS: checksummed,
    AGENT_TRADE_HL_BRIDGE_ARBITRUM: hlBridgeArbitrum,
    AGENT_TRADE_USDC_ARBITRUM: usdcArbitrum,
    builderAddressLower: checksummed.toLowerCase(),
    isTestnet: parsed.HYPERLIQUID_API_URL.includes("testnet"),
    restrictedCountries,
    agentTradeAllowlist,
    gaslessDepositAllowedWallets,
    WEB_ORIGIN: normalizeOrigins(parsed.WEB_ORIGIN),
  };
}

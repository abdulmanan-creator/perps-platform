export interface AgentRouteAuthEnv {
  PRIVY_APP_ID?: string;
  PRIVY_APP_SECRET?: string;
}

export type AgentRouteAuthFailureReason =
  | "missing_auth"
  | "malformed_auth"
  | "privy_env_missing"
  | "privy_verification_failed";

export interface AgentRouteAuthenticated {
  authenticated: true;
  privyUserId: string;
  walletAddress?: string;
  rateLimitKey: string;
}

export interface AgentRouteAuthRejected {
  authenticated: false;
  reason: AgentRouteAuthFailureReason;
  rateLimitKey: string;
}

export type AgentRouteAuthResult = AgentRouteAuthenticated | AgentRouteAuthRejected;

export type AgentRouteAuthVerifier = (args: {
  request: Request;
  env: AgentRouteAuthEnv;
}) => Promise<AgentRouteAuthResult>;

interface PrivyAuthClaims {
  userId: string;
}

interface PrivyUser {
  linkedAccounts?: {
    type?: string;
    address?: string;
    walletClientType?: string;
    walletClient?: string;
  }[];
  wallet?: { address?: string };
}

interface PrivyAuthClient {
  verifyAuthToken(token: string): Promise<PrivyAuthClaims>;
  getUser(userId: string): Promise<PrivyUser>;
}

interface PrivyServerAuthModule {
  PrivyClient: new (appId: string, appSecret: string) => PrivyAuthClient;
}

let cachedPrivyClient: PrivyAuthClient | undefined;

const tokenCache = new Map<string, { expiresAt: number; result: AgentRouteAuthenticated }>();
const TOKEN_CACHE_TTL_MS = 60_000;

export async function verifyAgentRoutePrivyAuth(args: {
  request: Request;
  env?: AgentRouteAuthEnv;
  now?: number;
}): Promise<AgentRouteAuthResult> {
  const env = args.env ?? readAgentRouteAuthEnv();
  const now = args.now ?? Date.now();
  const ipKey = ipRateLimitKey(args.request);
  const authHeader = args.request.headers.get("authorization");
  if (!authHeader) {
    return { authenticated: false, reason: "missing_auth", rateLimitKey: ipKey };
  }

  const token = bearerToken(authHeader);
  if (!token) {
    return { authenticated: false, reason: "malformed_auth", rateLimitKey: ipKey };
  }

  if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) {
    return { authenticated: false, reason: "privy_env_missing", rateLimitKey: ipKey };
  }

  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  try {
    const client = await getPrivyClient(env);
    const claims = await client.verifyAuthToken(token);
    const user = await client.getUser(claims.userId);
    const walletAddress = walletAddressFromUser(user);
    const result: AgentRouteAuthenticated = {
      authenticated: true,
      privyUserId: claims.userId,
      walletAddress,
      rateLimitKey: walletAddress
        ? `privy:${claims.userId}:${walletAddress.toLowerCase()}`
        : `privy:${claims.userId}`,
    };
    tokenCache.set(token, { expiresAt: now + TOKEN_CACHE_TTL_MS, result });
    return result;
  } catch {
    return { authenticated: false, reason: "privy_verification_failed", rateLimitKey: ipKey };
  }
}

export function ipRateLimitKey(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();
  const ip = forwardedFor || realIp || "unknown";
  return `ip:${ip}`;
}

function bearerToken(authHeader: string): string | undefined {
  const match = authHeader.match(/^Bearer\s+(.+)$/iu);
  return match?.[1]?.trim();
}

async function getPrivyClient(env: AgentRouteAuthEnv): Promise<PrivyAuthClient> {
  if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) {
    throw new Error("Missing Privy server credentials.");
  }
  if (!cachedPrivyClient) {
    const mod = await loadPrivyServerAuth();
    cachedPrivyClient = new mod.PrivyClient(env.PRIVY_APP_ID, env.PRIVY_APP_SECRET);
  }
  return cachedPrivyClient;
}

async function loadPrivyServerAuth(): Promise<PrivyServerAuthModule> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<PrivyServerAuthModule>;
  return await dynamicImport("@privy-io/server-auth");
}

function walletAddressFromUser(user: PrivyUser): string | undefined {
  const linked = user.linkedAccounts ?? [];
  const wallets = linked.filter((account) => account.type === "wallet" && account.address);
  const embedded = wallets.find(
    (account) => account.walletClientType === "privy" || account.walletClient === "privy",
  );
  const address = embedded?.address ?? wallets[0]?.address ?? (user.wallet as { address?: string } | undefined)?.address;
  return address && /^0x[a-fA-F0-9]{40}$/u.test(address) ? address : undefined;
}

function readAgentRouteAuthEnv(): AgentRouteAuthEnv {
  return {
    PRIVY_APP_ID: process.env.PRIVY_APP_ID,
    PRIVY_APP_SECRET: process.env.PRIVY_APP_SECRET,
  };
}

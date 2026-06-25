import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Optional UI-side jurisdiction hard block.
 *
 * The default Agent.trade behavior is UI accessible + paper-only for
 * restricted or unknown users. Live trading remains blocked server-side by the
 * API exchange guards. This middleware is reserved for a stricter legal mode
 * where the product must hide app surfaces entirely.
 *
 * Country comes from the edge: Cloudflare's `cf-ipcountry` (the web app sits
 * behind the same CF zone as the relay), with a Vercel fallback. Unknown
 * country fails open — the API is the backstop.
 */

const DEFAULT_RESTRICTED = "US,CU,IR,KP,SY,RU";

function restrictedSet(): Set<string> {
  const raw = process.env.RESTRICTED_COUNTRIES ?? DEFAULT_RESTRICTED;
  return new Set(
    raw
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean),
  );
}

export function middleware(req: NextRequest): NextResponse {
  if (process.env.AGENT_TRADE_HARD_BLOCK_RESTRICTED_UI !== "true") {
    return NextResponse.next();
  }
  if (process.env.GEO_BLOCK_ENABLED === "false") return NextResponse.next();

  const country = (
    req.headers.get("cf-ipcountry") ??
    req.headers.get("x-vercel-ip-country") ??
    ""
  )
    .trim()
    .toUpperCase();

  const blocked = country === "T1" || (country !== "" && restrictedSet().has(country));
  if (!blocked) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/restricted";
  url.search = "";
  return NextResponse.rewrite(url);
}

// Run on everything except Next internals, the restricted page itself, and
// static assets — so the gate can't accidentally loop or block its own page.
export const config = {
  matcher: ["/((?!_next/|restricted|favicon|robots.txt|.*\\.(?:svg|png|jpg|jpeg|ico|webp|woff2?)$).*)"],
};

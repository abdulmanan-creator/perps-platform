/**
 * Jurisdiction gating.
 *
 * The relay is the surface that actually forwards signed orders to the
 * exchange, so it's where US/sanctioned-jurisdiction exclusion has to be
 * enforced — a frontend banner alone doesn't stop a direct API caller.
 *
 * Country resolution leans on the edge (Cloudflare's `cf-ipcountry`), which
 * sets a trustworthy country from the real client IP that a caller can't spoof
 * past — provided the origin is only reachable through the edge. If the origin
 * is also exposed directly (e.g. the raw *.onrender.com URL), set
 * GEO_FAIL_CLOSED=true so requests arriving without an edge-stamped country are
 * refused rather than waved through.
 */

import type { FastifyRequest } from "fastify";
import type { Config } from "../config.js";

/** Cloudflare's code for a Tor exit node — no verifiable jurisdiction. */
const TOR_COUNTRY = "T1";
/** Cloudflare's code for "couldn't determine the country". */
const UNKNOWN_COUNTRY = "XX";

export type GeoOutcome =
  | { allowed: true; country: string | null }
  | { allowed: false; country: string | null; reason: "restricted" | "tor" | "unknown" };

const GLOBAL_GEO_EXEMPT_PATHS = new Set([
  "/healthz",
  "/metrics",
  "/markets",
  "/marketStats",
  "/l2Book",
  "/markPrice",
  "/agent-trade/candles",
  "/agent-trade/eligibility",
  "/agent-trade/paper-account",
  "/agent-trade/paper-orders",
]);

export function isGlobalGeoExemptPath(path: string): boolean {
  const pathname = path.split("?")[0] ?? path;
  return GLOBAL_GEO_EXEMPT_PATHS.has(pathname);
}

/**
 * Read the resolved country from the configured edge header. Returns an
 * uppercased ISO alpha-2 code, or null if the header is absent/empty. Fastify
 * lowercases header names; header values may arrive as string[] on repeats.
 */
export function resolveCountry(req: FastifyRequest, config: Config): string | null {
  const raw = req.headers[config.GEO_COUNTRY_HEADER.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const code = value.trim().toUpperCase();
  return code.length > 0 ? code : null;
}

/**
 * Decide whether a request may proceed. Pure given (country, config) so it's
 * trivially unit-testable; the Fastify hook does the I/O and the reply.
 */
export function geoDecision(req: FastifyRequest, config: Config): GeoOutcome {
  if (!config.GEO_BLOCK_ENABLED) return { allowed: true, country: resolveCountry(req, config) };

  const country = resolveCountry(req, config);

  // Anonymizing networks can't be attributed to a permitted jurisdiction, and
  // the venues we route into forbid evading geo controls — refuse outright.
  if (country === TOR_COUNTRY) return { allowed: false, country, reason: "tor" };

  if (country === null || country === UNKNOWN_COUNTRY) {
    return config.GEO_FAIL_CLOSED
      ? { allowed: false, country, reason: "unknown" }
      : { allowed: true, country };
  }

  if (config.restrictedCountries.has(country)) {
    return { allowed: false, country, reason: "restricted" };
  }

  return { allowed: true, country };
}

/**
 * Thin wrapper around the Agent.trade API for use in the web app.
 *
 * Uses @alchemy-hl/sdk-preview for typing + transport. Reads the API base URL
 * from NEXT_PUBLIC_API_URL at build time, falls back to localhost in dev.
 *
 * NEXT_PUBLIC_API_URL is allowed to be a bare hostname (Render's
 * `fromService.property: hostport` returns no scheme). We prepend `https://`
 * unless it's already a URL or looks like localhost.
 */

import { AlchemyHyperliquid } from "@alchemy-hl/sdk-preview";

/**
 * Normalize a URL-ish string into a full URL with scheme. Render's
 * `fromService.property: hostport` returns a bare hostname; we prepend
 * `https://` (or `http://` for localhost) so fetch URLs are valid.
 */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(trimmed);
  return `${isLocal ? "http" : "https"}://${trimmed}`;
}

const RAW_API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const API_URL = normalizeUrl(RAW_API_URL);

export const api = new AlchemyHyperliquid({ baseUrl: API_URL });
export const API_BASE_URL = API_URL;

export const BUILDER_ADDR = (process.env.NEXT_PUBLIC_BUILDER_ADDR ?? "") as
  | `0x${string}`
  | "";

/**
 * Venue registry — the single place the platform resolves a VenueId to its
 * adapter. The app/API layer talks to venues only through this, so adding a
 * venue is a one-line registration here plus its adapter file.
 */

import { HyperliquidVenue } from "./hyperliquid.js";
import { LighterVenue } from "./lighter.js";
import { OstiumVenue } from "./ostium.js";
import type { Venue, VenueId } from "./types.js";

export function createRegistry(): Map<VenueId, Venue> {
  const venues: Venue[] = [new HyperliquidVenue(), new LighterVenue(), new OstiumVenue()];
  return new Map(venues.map((v) => [v.id, v]));
}

const registry = createRegistry();

export function getVenue(id: VenueId): Venue {
  const v = registry.get(id);
  if (!v) throw new Error(`unknown venue: ${id}`);
  return v;
}

export function listVenues(): Venue[] {
  return [...registry.values()];
}

/** Parse a fully-qualified market id ("hyperliquid:BTC") into its parts. */
export function parseMarketId(marketId: string): { venue: VenueId; symbol: string } {
  const idx = marketId.indexOf(":");
  if (idx === -1) throw new Error(`market id must be "<venue>:<symbol>": ${marketId}`);
  return { venue: marketId.slice(0, idx) as VenueId, symbol: marketId.slice(idx + 1) };
}

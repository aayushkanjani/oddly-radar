// Whale trades from every venue, merged newest first.
// Used by both /api/whales (the website) and bot/whale-alerts.js (Telegram).
// If one venue is down, the other still shows; the failure is reported in `errors`.

import { getWhaleTrades as getPolymarketWhales } from "./polymarket.js";
import { getKalshiWhaleTrades } from "./kalshi.js";

export const VENUES = ["polymarket", "kalshi"];

export async function getAllWhaleTrades({ minUsd = 10000, venue = "all", limit = 60, sources } = {}) {
  const fetchers = sources || {
    polymarket: () => getPolymarketWhales({ minUsd, limit: 100 }),
    kalshi: () => getKalshiWhaleTrades({ minUsd, limit: 100 }),
  };
  const wanted = venue === "all" ? VENUES : VENUES.filter((v) => v === venue);
  const results = await Promise.allSettled(wanted.map((v) => fetchers[v]()));

  const trades = [];
  const errors = {};
  results.forEach((r, i) => {
    if (r.status === "fulfilled") trades.push(...r.value);
    else errors[wanted[i]] = String(r.reason?.message || r.reason);
  });

  if (!trades.length && Object.keys(errors).length === wanted.length) {
    const err = new Error(Object.values(errors).join("; "));
    err.status = 502;
    throw err;
  }
  trades.sort((a, b) => b.ts - a.ts);
  return { trades: trades.slice(0, limit), errors };
}

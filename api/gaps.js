// GET /api/gaps
// Price gaps between Kalshi and Polymarket for the hand-matched pairs in lib/pairs.js.
import { PAIRS } from "../lib/pairs.js";
import { getMarketBySlug } from "../lib/polymarket.js";
import { getKalshiMarket } from "../lib/kalshi.js";
import { send, fail } from "../lib/respond.js";

export async function buildGaps(pairs = PAIRS, { poly = getMarketBySlug, kalshi = getKalshiMarket } = {}) {
  const results = await Promise.allSettled(
    pairs.map(async (pair) => {
      const [p, k] = await Promise.all([poly(pair.polymarket), kalshi(pair.kalshi)]);
      if (!p || !k) return null;
      const gap = Math.abs(p.yes - k.yes);
      const cheaper = p.yes <= k.yes ? "Polymarket" : "Kalshi";
      return {
        label: pair.label || p.question,
        category: pair.category || "",
        ruleNote: pair.ruleNote || "",
        polymarket: p,
        kalshi: k,
        gap,
        cheaper,
      };
    }),
  );
  return results
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r) => r.value)
    .sort((a, b) => b.gap - a.gap);
}

export default async function handler(req, res) {
  try {
    const gaps = await buildGaps();
    send(res, 200, { gaps, pairsConfigured: PAIRS.length, updatedAt: Date.now() }, { cacheSeconds: 30 });
  } catch (err) {
    fail(res, err);
  }
}

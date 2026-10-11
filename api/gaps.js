// GET /api/gaps            price gaps between Kalshi and Polymarket on the same question
// GET /api/gaps?debug=1    also returns near-miss matches, to tune the matcher against live data
//
// Two sources, merged:
//   - hand-checked pairs from lib/pairs.js, shown as "verified"
//   - automatic matches from lib/match.js, shown as "auto-matched" with a match score
import { PAIRS } from "../lib/pairs.js";
import { getMarketBySlug } from "../lib/polymarket.js";
import { getKalshiMarket } from "../lib/kalshi.js";
import { getAutoGaps, toGap } from "../lib/match.js";
import { query, send, fail } from "../lib/respond.js";

export async function buildGaps(pairs = PAIRS, { poly = getMarketBySlug, kalshi = getKalshiMarket } = {}) {
  const results = await Promise.allSettled(
    pairs.map(async (pair) => {
      const [p, k] = await Promise.all([poly(pair.polymarket), kalshi(pair.kalshi)]);
      if (!p || !k) return null;
      const g = toGap({ polymarket: { venue: "Polymarket", ...p }, kalshi: { venue: "Kalshi", ...k }, match: 1 });
      return { ...g, label: pair.label || g.label, category: pair.category || "", ruleNote: pair.ruleNote || g.ruleNote, verified: true };
    }),
  );
  return results
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r) => r.value)
    .sort((a, b) => b.gap - a.gap);
}

export function mergeGaps(manual, auto) {
  const seenK = new Set(manual.map((g) => g.kalshi.id));
  const seenP = new Set(manual.map((g) => g.polymarket.id));
  const extra = auto.filter((g) => !seenK.has(g.kalshi.id) && !seenP.has(g.polymarket.id));
  return [...manual, ...extra].sort((a, b) => b.gap - a.gap);
}

export default async function handler(req, res) {
  const debug = query(req).get("debug") === "1";
  try {
    const [manualR, autoR] = await Promise.allSettled([buildGaps(), getAutoGaps({ debug })]);
    const manual = manualR.status === "fulfilled" ? manualR.value : [];
    const auto = autoR.status === "fulfilled" ? autoR.value : { gaps: [], scanned: {} };
    const errors = {};
    if (manualR.status === "rejected") errors.manual = String(manualR.reason?.message || manualR.reason);
    if (autoR.status === "rejected") errors.auto = String(autoR.reason?.message || autoR.reason);
    if (!manual.length && autoR.status === "rejected") {
      const err = new Error(errors.auto);
      err.status = 502;
      throw err;
    }
    const gaps = mergeGaps(manual, auto.gaps).slice(0, 40);
    send(
      res,
      200,
      {
        gaps,
        pairsConfigured: PAIRS.length,
        autoMatched: auto.gaps.length,
        scanned: auto.scanned,
        errors,
        ...(debug ? { nearMisses: auto.nearMisses || [] } : {}),
        updatedAt: Date.now(),
      },
      { cacheSeconds: debug ? 0 : 120 },
    );
  } catch (err) {
    fail(res, err);
  }
}

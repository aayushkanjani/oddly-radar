// GET /api/history?pairs=TICKER|slug,TICKER|slug   last 24 hours of each gap (up to 40 pairs)
// GET /api/history?widest=7                          the widest gaps of the last 7 days
// Both answer { enabled: false } until storage is set up (see lib/store.js).
import { historyEnabled, readSeries, readWidest } from "../lib/history.js";
import { query, send, fail, clampInt } from "../lib/respond.js";

const PAIR_RE = /^[A-Za-z0-9._-]{2,80}\|[a-z0-9-]{2,200}$/;

export default async function handler(req, res) {
  if (!historyEnabled()) {
    send(res, 200, { enabled: false }, { cacheSeconds: 300 });
    return;
  }
  const q = query(req);
  try {
    if (q.has("widest")) {
      const days = clampInt(q.get("widest"), 1, 7, 7);
      send(res, 200, { enabled: true, days, items: await readWidest({ days }) }, { cacheSeconds: 300 });
      return;
    }
    const pairs = [...new Set((q.get("pairs") || "").split(",").map((s) => s.trim()).filter((s) => PAIR_RE.test(s)))].slice(0, 40);
    if (!pairs.length) {
      send(res, 400, { error: "Ask for at least one pair, as KALSHI_TICKER|polymarket-slug." });
      return;
    }
    send(res, 200, { enabled: true, hours: 24, series: await readSeries(pairs, { hours: 24 }) }, { cacheSeconds: 120 });
  } catch (err) {
    fail(res, err);
  }
}

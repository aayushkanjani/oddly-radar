// GET /api/whales?min=1000..1000000&venue=all|polymarket|kalshi&limit=1..150
// Recent large trades on Polymarket and Kalshi, merged newest first.
import { getAllWhaleTrades, VENUES } from "../lib/whales.js";
import { query, send, fail, clampInt } from "../lib/respond.js";

export default async function handler(req, res) {
  const q = query(req);
  const minUsd = clampInt(q.get("min"), 1000, 1000000, 10000);
  const limit = clampInt(q.get("limit"), 1, 150, 80);
  const venue = VENUES.includes(q.get("venue")) ? q.get("venue") : "all";
  try {
    const { trades, errors } = await getAllWhaleTrades({ minUsd, venue, limit });
    // A 5-second edge cache keeps the feed close to live while visitors share one upstream call.
    send(res, 200, { minUsd, venue, trades, errors, updatedAt: Date.now() }, { cacheSeconds: 5 });
  } catch (err) {
    fail(res, err);
  }
}

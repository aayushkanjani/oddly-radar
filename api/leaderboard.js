// GET /api/leaderboard?period=day|week|month&sort=pnl|volume&limit=1..100
import { getLeaderboard, PERIODS, SORTS } from "../lib/polymarket.js";
import { query, send, fail, clampInt } from "../lib/respond.js";

export default async function handler(req, res) {
  const q = query(req);
  const period = PERIODS.includes(q.get("period")) ? q.get("period") : "week";
  const sort = q.get("sort") in SORTS ? q.get("sort") : "pnl";
  const limit = clampInt(q.get("limit"), 1, 100, 50);
  try {
    const traders = await getLeaderboard({ period, sort, limit });
    send(res, 200, { period, sort, traders, updatedAt: Date.now() }, { cacheSeconds: 120 });
  } catch (err) {
    fail(res, err);
  }
}

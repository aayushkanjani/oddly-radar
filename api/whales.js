// GET /api/whales?min=1000..1000000&limit=1..100
// Recent large trades across all Polymarket markets.
import { getWhaleTrades } from "../lib/polymarket.js";
import { query, send, fail, clampInt } from "../lib/respond.js";

export default async function handler(req, res) {
  const q = query(req);
  const minUsd = clampInt(q.get("min"), 1000, 1000000, 10000);
  const limit = clampInt(q.get("limit"), 1, 100, 40);
  try {
    const trades = await getWhaleTrades({ minUsd, limit });
    send(res, 200, { minUsd, trades, updatedAt: Date.now() }, { cacheSeconds: 30 });
  } catch (err) {
    fail(res, err);
  }
}

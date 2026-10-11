// GET /api/smart?period=day|week|month&hours=6|24|72&n=10..50
// Markets the most profitable Polymarket traders are buying together.
import { getSmartMoney } from "../lib/smart.js";
import { PERIODS } from "../lib/polymarket.js";
import { query, send, fail, clampInt } from "../lib/respond.js";

const WINDOWS = [6, 24, 72];

export default async function handler(req, res) {
  const q = query(req);
  const period = PERIODS.includes(q.get("period")) ? q.get("period") : "week";
  const hours = WINDOWS.includes(Number(q.get("hours"))) ? Number(q.get("hours")) : 24;
  const topN = clampInt(q.get("n"), 10, 50, 30);
  try {
    const data = await getSmartMoney({ period, hours, topN });
    // Reading 30 wallets is the heaviest call on the site; a 3-minute edge cache keeps it cheap.
    send(res, 200, data, { cacheSeconds: 180 });
  } catch (err) {
    fail(res, err);
  }
}

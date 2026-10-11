// GET /api/wallet?addr=0x...
// One wallet's open positions, recent trades, leaderboard standing and simple stats.
import { getLeaderboard, getWalletPositions, getWalletTrades } from "../lib/polymarket.js";
import { WALLET_RE } from "../lib/http.js";
import { query, send, fail } from "../lib/respond.js";

// Positions worth under $1 are settled losers or dust; they aren't "open bets".
const MIN_OPEN_VALUE = 1;

export function walletStats(positions, trades) {
  const openValue = positions.reduce((s, p) => s + p.currentValue, 0);
  const openPnl = positions.reduce((s, p) => s + p.cashPnl, 0);
  const winning = positions.filter((p) => p.cashPnl > 0).length;
  const volume = trades.reduce((s, t) => s + t.usd, 0);
  const lastTradeAt = trades.length ? trades[0].ts : null;
  return {
    openPositions: positions.length,
    openValue,
    openPnl,
    winningShare: positions.length ? winning / positions.length : null,
    recentVolume: volume,
    lastTradeAt,
  };
}

// The leaderboard is the only public source of a wallet's overall profit.
// Check this week first, then this month, then today; the first match wins.
export async function findStanding(addr, getBoard = getLeaderboard) {
  const periods = ["week", "month", "day"];
  const boards = await Promise.allSettled(periods.map((period) => getBoard({ period, sort: "pnl", limit: 100 })));
  for (let i = 0; i < periods.length; i++) {
    if (boards[i].status !== "fulfilled") continue;
    const hit = boards[i].value.find((t) => t.wallet === addr);
    if (hit) return { period: periods[i], rank: hit.rank, pnl: hit.pnl, volume: hit.volume, name: hit.name, xUsername: hit.xUsername };
  }
  return null;
}

export default async function handler(req, res) {
  const addr = (query(req).get("addr") || "").trim().toLowerCase();
  if (!WALLET_RE.test(addr)) {
    send(res, 400, { error: "Enter a full wallet address: 0x followed by 40 letters or digits." });
    return;
  }
  try {
    const [allPositions, trades, standing] = await Promise.all([
      getWalletPositions(addr),
      getWalletTrades(addr),
      findStanding(addr).catch(() => null),
    ]);
    const positions = allPositions.filter((p) => p.currentValue >= MIN_OPEN_VALUE);
    const name = standing?.name || trades.find((t) => t.name)?.name || "";
    send(
      res,
      200,
      { wallet: addr, name, standing, stats: walletStats(positions, trades), positions, trades, updatedAt: Date.now() },
      { cacheSeconds: 60 },
    );
  } catch (err) {
    fail(res, err);
  }
}

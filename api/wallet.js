// GET /api/wallet?addr=0x...
// One wallet's open positions and recent trades, plus simple stats.
import { getWalletPositions, getWalletTrades } from "../lib/polymarket.js";
import { WALLET_RE } from "../lib/http.js";
import { query, send, fail } from "../lib/respond.js";

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

export default async function handler(req, res) {
  const addr = (query(req).get("addr") || "").trim();
  if (!WALLET_RE.test(addr)) {
    send(res, 400, { error: "Enter a full wallet address: 0x followed by 40 letters or digits." });
    return;
  }
  try {
    const [positions, trades] = await Promise.all([getWalletPositions(addr), getWalletTrades(addr)]);
    const name = trades.find((t) => t.name)?.name || "";
    send(
      res,
      200,
      { wallet: addr.toLowerCase(), name, stats: walletStats(positions, trades), positions, trades, updatedAt: Date.now() },
      { cacheSeconds: 60 },
    );
  } catch (err) {
    fail(res, err);
  }
}

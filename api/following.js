// GET /api/following?wallets=0xa,0xb,...  (up to 20 Polymarket wallets)
// The latest trades from the traders a visitor follows, merged newest first.
// The list of wallets lives in the visitor's browser; nothing is stored on the server.
import { getWalletTrades } from "../lib/polymarket.js";
import { mapLimit } from "../lib/smart.js";
import { WALLET_RE } from "../lib/http.js";
import { query, send, fail } from "../lib/respond.js";

export const MAX_WALLETS = 20;

export async function followingFeed(wallets, { perWallet = 15, limit = 40, getTrades = getWalletTrades } = {}) {
  const results = await mapLimit(wallets, 6, (w) => getTrades(w, { limit: perWallet }));
  const trades = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const failed = results.filter((r) => r.status === "rejected").length;
  trades.sort((a, b) => b.ts - a.ts);
  return { trades: trades.slice(0, limit), failed };
}

export default async function handler(req, res) {
  const raw = (query(req).get("wallets") || "").split(",").map((w) => w.trim().toLowerCase());
  const wallets = [...new Set(raw.filter((w) => WALLET_RE.test(w)))].slice(0, MAX_WALLETS);
  if (!wallets.length) {
    send(res, 400, { error: "Add at least one wallet address to follow." });
    return;
  }
  try {
    const { trades, failed } = await followingFeed(wallets);
    send(res, 200, { wallets: wallets.length, trades, failed, updatedAt: Date.now() }, { cacheSeconds: 15 });
  } catch (err) {
    fail(res, err);
  }
}

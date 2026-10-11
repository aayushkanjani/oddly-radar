// Smart Money Flow: what the most profitable Polymarket traders are buying together.
//
// 1. Take the top N wallets on the profit leaderboard (this week by default).
// 2. Read each wallet's recent trades (v1 /trades?user=, confirmed working).
// 3. Group trades from the last `hours` by market and outcome; buys count as +$, sells as −$.
// 4. Rank markets by how many top traders are net buyers, then by net dollars bought.
//
// Kalshi isn't included: its trades are anonymous, so there's no "top trader" to follow there.

import { getLeaderboard, getWalletTrades } from "./polymarket.js";

// Runs `fn` over `items` with at most `limit` calls in flight, so we don't hammer the API.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function aggregateFlow(board, tradesByWallet, { since, maxMarkets = 12 } = {}) {
  const markets = new Map();
  board.forEach((trader, i) => {
    for (const t of tradesByWallet[i] || []) {
      if (t.ts < since || !t.title) continue;
      const key = `${t.conditionId || t.slug || t.title}|${t.outcome}`;
      let m = markets.get(key);
      if (!m) {
        m = {
          title: t.title, outcome: t.outcome, url: t.url, icon: t.icon, slug: t.slug, eventSlug: t.eventSlug,
          buyUsd: 0, sellUsd: 0, buySize: 0, lastPrice: t.price, lastTs: 0, wallets: new Map(),
        };
        markets.set(key, m);
      }
      const signed = t.side === "SELL" ? -t.usd : t.usd;
      if (t.side === "SELL") m.sellUsd += t.usd;
      else {
        m.buyUsd += t.usd;
        m.buySize += t.size;
      }
      if (t.ts > m.lastTs) {
        m.lastTs = t.ts;
        m.lastPrice = t.price;
      }
      const w = m.wallets.get(trader.wallet) || { wallet: trader.wallet, name: trader.name, rank: trader.rank, image: trader.image, net: 0 };
      w.net += signed;
      m.wallets.set(trader.wallet, w);
    }
  });

  return [...markets.values()]
    .map((m) => {
      const buyers = [...m.wallets.values()].filter((w) => w.net > 0).sort((a, b) => a.rank - b.rank);
      const sellers = [...m.wallets.values()].filter((w) => w.net < 0).length;
      return {
        title: m.title, outcome: m.outcome, url: m.url, icon: m.icon, slug: m.slug, eventSlug: m.eventSlug,
        netUsd: m.buyUsd - m.sellUsd,
        buyUsd: m.buyUsd,
        avgEntry: m.buySize ? m.buyUsd / m.buySize : null,
        lastPrice: m.lastPrice,
        lastTs: m.lastTs,
        buyerCount: buyers.length,
        sellerCount: sellers,
        buyers: buyers.slice(0, 6),
      };
    })
    .filter((m) => m.netUsd > 0 && m.buyerCount > 0)
    .sort((a, b) => b.buyerCount - a.buyerCount || b.netUsd - a.netUsd)
    .slice(0, maxMarkets);
}

export async function getSmartMoney({
  period = "week",
  topN = 30,
  hours = 24,
  maxMarkets = 12,
  getBoard = getLeaderboard,
  getTrades = getWalletTrades,
  concurrency = 8,
} = {}) {
  const board = await getBoard({ period, sort: "pnl", limit: topN });
  const results = await mapLimit(board, concurrency, (t) => getTrades(t.wallet, { limit: 60 }));
  const tradesByWallet = results.map((r) => (r.status === "fulfilled" ? r.value : []));
  const failed = results.filter((r) => r.status === "rejected").length;
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  return {
    period,
    topN: board.length,
    hours,
    failed,
    markets: aggregateFlow(board, tradesByWallet, { since, maxMarkets }),
    updatedAt: Date.now(),
  };
}

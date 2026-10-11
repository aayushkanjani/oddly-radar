// Kalshi public market data. No API key needed for reading markets.
// Confirmed on 2026-10-11: GET /trade-api/v2/markets returns { cursor, markets }.
// Prices are dollar strings such as "0.4300" (yes_bid_dollars, yes_ask_dollars, last_price_dollars).

import { fetchJson, num, str } from "./http.js";

const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";

export function normalizeKalshiMarket(m) {
  const bid = num(m.yes_bid_dollars, NaN);
  const ask = num(m.yes_ask_dollars, NaN);
  const last = num(m.last_price_dollars, NaN);
  const hasBook = Number.isFinite(bid) && Number.isFinite(ask) && ask > 0;
  const yes = hasBook ? (bid + ask) / 2 : Number.isFinite(last) ? last : 0;
  return {
    venue: "Kalshi",
    id: str(m.ticker),
    question: str(m.title) + (m.yes_sub_title ? ` (${m.yes_sub_title})` : ""),
    yes,
    bid: Number.isFinite(bid) ? bid : null,
    ask: Number.isFinite(ask) ? ask : null,
    volume24h: num(m.volume_24h_fp),
    endDate: str(m.close_time),
    rules: [str(m.rules_primary), str(m.rules_secondary)].filter(Boolean).join("\n\n"),
    url: m.event_ticker ? `https://kalshi.com/markets/${String(m.event_ticker).toLowerCase()}` : "",
  };
}

export async function getKalshiMarket(ticker) {
  const body = await fetchJson(`${KALSHI_API}/markets/${encodeURIComponent(ticker)}`);
  const m = body?.market;
  return m ? normalizeKalshiMarket(m) : null;
}

// ---------- whale trades ----------
// Confirmed on 2026-10-11: GET /markets/trades returns { cursor, trades }, newest first, up to 1000 per page.
// Rows carry count_fp, yes_price_dollars, no_price_dollars, taker_outcome_side ("yes"/"no"),
// created_time (ISO, microseconds) and trade_id. Kalshi trades are anonymous: no trader is attached.

export function normalizeKalshiTrade(t) {
  const outcomeSide = String(t.taker_outcome_side || t.taker_side || "yes").toLowerCase();
  const size = num(t.count_fp, num(t.count));
  const price = outcomeSide === "no" ? num(t.no_price_dollars) : num(t.yes_price_dollars);
  return {
    id: str(t.trade_id),
    ticker: str(t.ticker),
    outcomeSide,
    size,
    price,
    usd: size * price,
    createdTime: str(t.created_time),
    ts: Math.floor(Date.parse(t.created_time) / 1000) || 0,
  };
}

// One large order often fills against many resting orders, producing several rows with the
// same market, side and exact timestamp. Merge those so a $50k order isn't missed as ten $5k fills.
export function mergeFills(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.ticker}|${r.outcomeSide}|${r.createdTime}`;
    const g = groups.get(key);
    if (g) {
      g.size += r.size;
      g.usd += r.usd;
      g.fills += 1;
    } else {
      groups.set(key, { ...r, fills: 1 });
    }
  }
  return [...groups.values()].map((g) => ({ ...g, price: g.size ? g.usd / g.size : g.price }));
}

// Market titles rarely change, so keep them while the function instance stays warm.
const marketCache = new Map();
const MARKET_TTL_MS = 10 * 60 * 1000;
async function marketFor(ticker) {
  const hit = marketCache.get(ticker);
  if (hit && hit.expires > Date.now()) return hit.market;
  const market = await getKalshiMarket(ticker);
  marketCache.set(ticker, { market, expires: Date.now() + MARKET_TTL_MS });
  return market;
}

export async function getKalshiWhaleTrades({ minUsd = 10000, limit = 60, pages = 3, windowSec = 3600, fetchPage, lookup = marketFor } = {}) {
  const getPage = fetchPage || ((cursor) => fetchJson(`${KALSHI_API}/markets/trades?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
  const cutoff = Math.floor(Date.now() / 1000) - windowSec;
  const rows = [];
  let cursor = "";
  for (let i = 0; i < pages; i++) {
    const body = await getPage(cursor);
    const batch = (body?.trades || []).map(normalizeKalshiTrade);
    rows.push(...batch);
    cursor = body?.cursor || "";
    if (!cursor || !batch.length || batch[batch.length - 1].ts < cutoff) break;
  }
  const whales = mergeFills(rows)
    .filter((t) => t.usd >= minUsd)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);

  const tickers = [...new Set(whales.map((t) => t.ticker))];
  const markets = new Map();
  await Promise.allSettled(tickers.map(async (tk) => markets.set(tk, await lookup(tk))));

  return whales.map((t) => {
    const m = markets.get(t.ticker);
    return {
      venue: "Kalshi",
      wallet: "",
      name: "",
      side: "BUY",
      outcome: t.outcomeSide === "no" ? "No" : "Yes",
      size: t.size,
      price: t.price,
      usd: t.usd,
      title: m?.question || t.ticker,
      slug: "",
      eventSlug: "",
      icon: "",
      url: m?.url || "https://kalshi.com/markets",
      conditionId: t.ticker,
      fills: t.fills,
      ts: t.ts,
      tx: `kalshi:${t.id}`,
    };
  });
}

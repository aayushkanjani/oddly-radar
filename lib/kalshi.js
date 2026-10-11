// Kalshi public market data. No API key needed for reading markets.
// Confirmed on 2026-10-11: GET /trade-api/v2/markets returns { cursor, markets }.
// Prices are dollar strings such as "0.4300" (yes_bid_dollars, yes_ask_dollars, last_price_dollars).

import { fetchJson, num, str } from "./http.js";

const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";

// Kalshi's site links by series: kalshi.com/markets/kxfeddecision works, the event code
// (kxfeddecision-27dec) does not. The series code is the event code up to its first dash.
export function kalshiUrl(eventTicker, seriesTicker) {
  const series = String(seriesTicker || String(eventTicker || "").split("-")[0] || "").toLowerCase();
  return series ? `https://kalshi.com/markets/${encodeURIComponent(series)}` : "https://kalshi.com/markets";
}

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
    url: kalshiUrl(m.event_ticker, m.series_ticker),
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

// Kalshi prints thousands of small trades a minute, so a few pages cover only about a minute.
// To keep big trades visible for an hour, remember every merged trade over KEEP_USD while the
// function instance stays warm, and on each call fetch only what's new since the last one.
const KEEP_USD = 1000;
const buffer = new Map(); // order key -> merged trade
let newestSeen = 0;
export function resetKalshiBuffer() {
  buffer.clear();
  newestSeen = 0;
}
const orderKey = (t) => `${t.ticker}|${t.outcomeSide}|${t.createdTime}`;

export async function getKalshiWhaleTrades({ minUsd = 10000, limit = 60, pages = 8, windowSec = 3600, fetchPage, lookup = marketFor } = {}) {
  const getPage = fetchPage || ((cursor) => fetchJson(`${KALSHI_API}/markets/trades?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
  const cutoff = Math.floor(Date.now() / 1000) - windowSec;
  // Re-read a few seconds past what we've already seen so an order's fills are never split across calls.
  const stopAt = Math.max(cutoff, newestSeen - 5);
  const rows = [];
  let cursor = "";
  for (let i = 0; i < pages; i++) {
    const body = await getPage(cursor);
    const batch = (body?.trades || []).map(normalizeKalshiTrade);
    rows.push(...batch);
    cursor = body?.cursor || "";
    if (!cursor || !batch.length || batch[batch.length - 1].ts < stopAt) break;
  }
  for (const t of mergeFills(rows)) {
    if (t.usd < KEEP_USD || t.ts < cutoff) continue;
    const prev = buffer.get(orderKey(t));
    if (!prev || t.usd > prev.usd) buffer.set(orderKey(t), t);
    if (t.ts > newestSeen) newestSeen = t.ts;
  }
  for (const [k, t] of buffer) if (t.ts < cutoff) buffer.delete(k);

  const whales = [...buffer.values()]
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

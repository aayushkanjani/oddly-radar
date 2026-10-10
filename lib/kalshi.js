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

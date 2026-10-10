// Polymarket public data. No API key needed.
//
// Endpoints confirmed against live responses on 2026-10-11:
//   v2 leaderboard   GET data-api /v2/leaderboard?time_period&sort_by      -> { data: [snake_case rows], pagination }
//   v1 trades        GET data-api /trades?user | filterType=CASH&filterAmount -> [camelCase rows]
//   v1 positions     GET data-api /positions?user&sortBy                  -> [camelCase rows]
//   gamma markets    GET gamma-api /markets?slug                          -> [markets]; outcomePrices is a JSON string
// The v2 trades endpoint ignores the `user` filter, so per-wallet data uses v1.
// Field names differ between versions (proxy_wallet vs proxyWallet); normalize* accepts both.

import { fetchJson, num, str, WALLET_RE } from "./http.js";

const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

export const PERIODS = ["day", "week", "month"];
export const SORTS = { pnl: "PNL", volume: "VOLUME" };

const pick = (row, ...keys) => {
  for (const k of keys) if (row[k] !== undefined && row[k] !== null) return row[k];
  return undefined;
};

export function normalizeTrader(row) {
  return {
    rank: num(pick(row, "rank")),
    wallet: str(pick(row, "user_id", "proxyWallet", "proxy_wallet")).toLowerCase(),
    name: str(pick(row, "user_name", "userName", "name")),
    xUsername: str(pick(row, "x_username", "xUsername")),
    verified: Boolean(pick(row, "verified")),
    image: str(pick(row, "profile_image", "profileImage")),
    pnl: num(pick(row, "pnl")),
    volume: num(pick(row, "volume", "vol")),
  };
}

export function normalizeTrade(row) {
  const size = num(pick(row, "size"));
  const price = num(pick(row, "price"));
  let ts = num(pick(row, "timestamp"));
  if (ts > 1e12) ts = Math.floor(ts / 1000); // tolerate milliseconds
  return {
    wallet: str(pick(row, "proxyWallet", "proxy_wallet")).toLowerCase(),
    name: str(pick(row, "name")) || str(pick(row, "pseudonym")),
    side: str(pick(row, "side")).toUpperCase(),
    outcome: str(pick(row, "outcome")),
    size,
    price,
    usd: size * price,
    title: str(pick(row, "title")),
    slug: str(pick(row, "slug")),
    eventSlug: str(pick(row, "eventSlug", "event_slug")),
    icon: str(pick(row, "icon")),
    conditionId: str(pick(row, "conditionId", "condition_id")),
    ts,
    tx: str(pick(row, "transactionHash", "transaction_hash")),
  };
}

export function normalizePosition(row) {
  return {
    title: str(row.title),
    slug: str(row.slug),
    eventSlug: str(row.eventSlug),
    icon: str(row.icon),
    outcome: str(row.outcome),
    size: num(row.size),
    avgPrice: num(row.avgPrice),
    curPrice: num(row.curPrice),
    initialValue: num(row.initialValue),
    currentValue: num(row.currentValue),
    cashPnl: num(row.cashPnl),
    percentPnl: num(row.percentPnl),
    realizedPnl: num(row.realizedPnl),
    endDate: str(row.endDate),
    redeemable: Boolean(row.redeemable),
  };
}

const rowsOf = (body) => (Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []);

export async function getLeaderboard({ period = "week", sort = "pnl", limit = 50 } = {}) {
  const p = PERIODS.includes(period) ? period : "week";
  const s = SORTS[sort] ?? "PNL";
  const url = `${DATA_API}/v2/leaderboard?time_period=${p}&sort_by=${s}&limit=${limit}`;
  const rows = rowsOf(await fetchJson(url)).map(normalizeTrader).filter((t) => WALLET_RE.test(t.wallet));
  // The API may return more rows than asked for; keep the order it gives and cap here.
  return rows.slice(0, limit).map((t, i) => ({ ...t, rank: t.rank || i + 1 }));
}

export async function getWhaleTrades({ minUsd = 10000, limit = 50 } = {}) {
  const url = `${DATA_API}/trades?filterType=CASH&filterAmount=${minUsd}&limit=${limit}&takerOnly=true`;
  return rowsOf(await fetchJson(url))
    .map(normalizeTrade)
    .filter((t) => t.usd >= minUsd)
    .sort((a, b) => b.ts - a.ts);
}

export async function getWalletTrades(wallet, { limit = 50 } = {}) {
  if (!WALLET_RE.test(wallet)) throw new Error("Not a wallet address");
  const url = `${DATA_API}/trades?user=${wallet}&limit=${limit}`;
  return rowsOf(await fetchJson(url))
    .map(normalizeTrade)
    .filter((t) => t.wallet === wallet.toLowerCase())
    .sort((a, b) => b.ts - a.ts);
}

export async function getWalletPositions(wallet, { limit = 50 } = {}) {
  if (!WALLET_RE.test(wallet)) throw new Error("Not a wallet address");
  const url = `${DATA_API}/positions?user=${wallet}&limit=${limit}&sortBy=CURRENT&sizeThreshold=1`;
  return rowsOf(await fetchJson(url))
    .map(normalizePosition)
    .sort((a, b) => b.currentValue - a.currentValue);
}

function parseMaybeJson(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function normalizeMarket(m) {
  const outcomes = parseMaybeJson(m.outcomes);
  const prices = parseMaybeJson(m.outcomePrices).map((p) => num(p));
  const yesIndex = Math.max(0, outcomes.findIndex((o) => String(o).toLowerCase() === "yes"));
  const bid = num(m.bestBid, NaN);
  const ask = num(m.bestAsk, NaN);
  const mid = Number.isFinite(bid) && Number.isFinite(ask) && ask > 0 ? (bid + ask) / 2 : NaN;
  return {
    venue: "Polymarket",
    id: str(m.slug),
    question: str(m.question),
    yes: Number.isFinite(mid) ? mid : num(prices[yesIndex], num(m.lastTradePrice)),
    bid: Number.isFinite(bid) ? bid : null,
    ask: Number.isFinite(ask) ? ask : null,
    volume24h: num(m.volume24hr),
    endDate: str(m.endDate),
    rules: str(m.description),
    url: m.slug ? `https://polymarket.com/market/${m.slug}` : "",
  };
}

export async function getMarketBySlug(slug) {
  const url = `${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`;
  const rows = rowsOf(await fetchJson(url));
  if (!rows.length) return null;
  return normalizeMarket(rows[0]);
}

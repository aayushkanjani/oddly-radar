// Offline tests: `npm test`. Fixtures mirror the live response shapes confirmed on 2026-10-11.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  normalizeTrader, normalizeTrade, normalizeMarket,
  getLeaderboard, getWalletTrades, getWhaleTrades,
} from "../lib/polymarket.js";
import { normalizeKalshiMarket } from "../lib/kalshi.js";
import { buildGaps } from "../api/gaps.js";
import walletHandler, { walletStats } from "../api/wallet.js";
import leaderboardHandler from "../api/leaderboard.js";
import { run, selectNew, formatAlert, tradeKey } from "../bot/whale-alerts.js";

const W1 = "0x5268527977f700f9bf9b6d5cd843859e4e70135d";
const W2 = "0x1111111111111111111111111111111111111111";

const v2Trader = (rank, wallet) => ({ rank, user_id: wallet, user_name: "sharp" + rank, pnl: 1000 * rank, volume: 5000, profile_image: "", x_username: "", verified: rank === 1 });
const v1Trade = (o) => ({ proxyWallet: W1, side: "BUY", asset: "1", conditionId: "c1", size: 20000, price: 0.5, timestamp: 1790979000, title: "Will it rain?", slug: "rain", icon: "", eventSlug: "rain-event", outcome: "Yes", outcomeIndex: 0, name: "sharp1", pseudonym: "Sharp", transactionHash: "0xabc", ...o });

// ---- fake fetch ----
const realFetch = globalThis.fetch;
let routes;
beforeEach(() => {
  routes = [];
  globalThis.fetch = async (url) => {
    const hit = routes.find(([re]) => re.test(String(url)));
    if (!hit) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(hit[1]), { status: 200, headers: { "content-type": "application/json" } });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

function fakeRes() {
  return {
    statusCode: 0, headers: {}, body: "",
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = b; },
  };
}

// ---- normalizers ----
test("normalizeTrader reads v2 snake_case rows", () => {
  const t = normalizeTrader(v2Trader(1, W1.toUpperCase().replace("0X", "0x")));
  assert.equal(t.wallet, W1);
  assert.equal(t.name, "sharp1");
  assert.equal(t.pnl, 1000);
  assert.equal(t.verified, true);
});

test("normalizeTrade accepts v1 camelCase and v2 snake_case", () => {
  const a = normalizeTrade(v1Trade());
  const b = normalizeTrade({ proxy_wallet: W1, side: "buy", size: 20000, price: 0.5, timestamp: 1790979000, title: "Will it rain?", event_slug: "rain-event", outcome: "Yes", transaction_hash: "0xabc" });
  for (const t of [a, b]) {
    assert.equal(t.wallet, W1);
    assert.equal(t.usd, 10000);
    assert.equal(t.eventSlug, "rain-event");
    assert.equal(t.tx, "0xabc");
  }
  assert.equal(b.side, "BUY");
});

test("normalizeTrade converts millisecond timestamps to seconds", () => {
  assert.equal(normalizeTrade(v1Trade({ timestamp: 1790979000123 })).ts, 1790979000);
});

test("normalizeMarket parses Gamma's JSON-string prices and uses the bid/ask mid", () => {
  const m = normalizeMarket({ slug: "s", question: "Q?", outcomes: '["Yes","No"]', outcomePrices: '["0.115","0.885"]', bestBid: 0.11, bestAsk: 0.12, volume24hr: 5, description: "rules" });
  assert.equal(m.yes.toFixed(3), "0.115");
  assert.equal(m.rules, "rules");
  const noBook = normalizeMarket({ slug: "s", outcomes: '["Yes","No"]', outcomePrices: '["0.3","0.7"]' });
  assert.equal(noBook.yes, 0.3);
});

test("normalizeKalshiMarket reads dollar-string prices", () => {
  const k = normalizeKalshiMarket({ ticker: "T", title: "Q?", yes_bid_dollars: "0.4200", yes_ask_dollars: "0.4400", last_price_dollars: "0.4300", rules_primary: "R1", event_ticker: "EV" });
  assert.equal(k.yes.toFixed(2), "0.43");
  assert.equal(k.url, "https://kalshi.com/markets/ev");
  const empty = normalizeKalshiMarket({ ticker: "T", yes_bid_dollars: "0.0000", yes_ask_dollars: "0.0000", last_price_dollars: "0.2500" });
  assert.equal(empty.yes, 0.25);
});

// ---- data functions ----
test("getLeaderboard caps rows even when the API returns more than asked", async () => {
  routes.push([/\/v2\/leaderboard/, { data: Array.from({ length: 100 }, (_, i) => v2Trader(i + 1, W1)), pagination: {} }]);
  const rows = await getLeaderboard({ period: "week", limit: 10 });
  assert.equal(rows.length, 10);
  assert.equal(rows[0].rank, 1);
});

test("getWalletTrades drops rows from other wallets", async () => {
  routes.push([/\/trades\?user=/, [v1Trade(), v1Trade({ proxyWallet: W2 })]]);
  const rows = await getWalletTrades(W1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].wallet, W1);
});

test("getWhaleTrades keeps only trades at or above the minimum, newest first", async () => {
  routes.push([/filterType=CASH/, [v1Trade({ size: 100, timestamp: 1 }), v1Trade({ timestamp: 5 }), v1Trade({ timestamp: 9 })]]);
  const rows = await getWhaleTrades({ minUsd: 10000 });
  assert.deepEqual(rows.map((r) => r.ts), [9, 5]);
});

test("buildGaps sorts by gap and skips pairs that can't be loaded", async () => {
  const poly = async (slug) => (slug === "missing" ? null : { yes: slug === "a" ? 0.4 : 0.5, url: "" });
  const kalshi = async () => ({ yes: 0.45, url: "" });
  const gaps = await buildGaps(
    [{ polymarket: "a", kalshi: "K" }, { polymarket: "b", kalshi: "K" }, { polymarket: "missing", kalshi: "K" }],
    { poly, kalshi },
  );
  assert.equal(gaps.length, 2);
  assert.equal(gaps[0].cheaper, "Polymarket");
  assert.ok(Math.abs(gaps[0].gap - 0.05) < 1e-9);
});

test("walletStats adds up positions and trades", () => {
  const s = walletStats(
    [{ currentValue: 100, cashPnl: 20 }, { currentValue: 50, cashPnl: -10 }],
    [{ usd: 300, ts: 99 }, { usd: 200, ts: 50 }],
  );
  assert.equal(s.openValue, 150);
  assert.equal(s.openPnl, 10);
  assert.equal(s.winningShare, 0.5);
  assert.equal(s.recentVolume, 500);
  assert.equal(s.lastTradeAt, 99);
});

// ---- API handlers ----
test("wallet API rejects a bad address with 400", async () => {
  const res = fakeRes();
  await walletHandler({ url: "/api/wallet?addr=0x123" }, res);
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /full wallet address/);
});

test("leaderboard API returns JSON with an edge-cache header", async () => {
  routes.push([/\/v2\/leaderboard/, { data: [v2Trader(1, W1)] }]);
  const res = fakeRes();
  await leaderboardHandler({ url: "/api/leaderboard?period=day&sort=volume&limit=5" }, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["cache-control"], /s-maxage=120/);
  const body = JSON.parse(res.body);
  assert.equal(body.period, "day");
  assert.equal(body.traders[0].wallet, W1);
});

test("leaderboard API answers 502 when Polymarket is down", async () => {
  const res = fakeRes();
  await leaderboardHandler({ url: "/api/leaderboard" }, res); // no route -> 404 upstream
  assert.equal(res.statusCode, 502);
});

// ---- bot ----
test("formatAlert escapes HTML in market titles and names", () => {
  const t = normalizeTrade(v1Trade({ title: "A <b>bold</b> & risky bet", name: "<script>" }));
  const text = formatAlert(t, "https://radar.example/");
  assert.ok(text.includes("A &lt;b&gt;bold&lt;/b&gt; &amp; risky bet"));
  assert.ok(text.includes("&lt;script&gt;"));
  assert.ok(text.includes("https://radar.example/wallet?addr=" + W1));
  assert.ok(text.startsWith("🐋 <b>$10.0k</b> BOUGHT <b>Yes</b> at 50¢"));
});

test("selectNew skips seen trades and returns oldest first", () => {
  const a = normalizeTrade(v1Trade({ transactionHash: "0x1", timestamp: 100 }));
  const b = normalizeTrade(v1Trade({ transactionHash: "0x2", timestamp: 300 }));
  const c = normalizeTrade(v1Trade({ transactionHash: "0x3", timestamp: 200 }));
  const picked = selectNew([b, a, c], { lastTs: 150, seen: [tradeKey(a)] });
  assert.deepEqual(picked.map((t) => t.tx), ["0x3", "0x2"]);
});

test("bot: first run records trades without posting, next run posts only new ones", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "radar-"));
  const env = { STATE_FILE: path.join(dir, "seen.json"), MIN_USD: "10000", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "@c" };
  const sent = [];
  const send = async (_tok, _chat, text) => { sent.push(text); };
  const log = () => {};
  const old = normalizeTrade(v1Trade({ transactionHash: "0xold", timestamp: 1000 }));
  const fresh = normalizeTrade(v1Trade({ transactionHash: "0xnew", timestamp: 2000, title: "New market" }));

  const r1 = await run(env, { fetchTrades: async () => [old], send, log });
  assert.equal(r1.firstRun, true);
  assert.equal(sent.length, 0);

  const r2 = await run(env, { fetchTrades: async () => [fresh, old], send, log });
  assert.equal(r2.posted, 1);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes("New market"));

  const r3 = await run(env, { fetchTrades: async () => [fresh, old], send, log });
  assert.equal(r3.posted, 0, "never posts the same trade twice");
});

// ---- v2: names, standings, settled bets ----
import { cleanName } from "../lib/polymarket.js";
import { findStanding } from "../api/wallet.js";

test("cleanName skips wallet-address names, including ones with a numeric suffix", () => {
  assert.equal(cleanName("0x2c335066FE58fe9237c3d3Dc7b275C2a034a0563-1759935795465", "Brave-Otter"), "Brave-Otter");
  assert.equal(cleanName(W1, ""), "");
  assert.equal(cleanName("ethanaz", "Ignored"), "ethanaz");
  const t = normalizeTrade(v1Trade({ name: W1 + "-123", pseudonym: "Quiet-Fox" }));
  assert.equal(t.name, "Quiet-Fox");
});

test("findStanding prefers this week, then month, then day", async () => {
  const boards = {
    week: [{ wallet: W2, rank: 1, pnl: 5 }],
    month: [{ wallet: W1, rank: 7, pnl: 900, volume: 10, name: "sharp" }],
    day: [{ wallet: W1, rank: 2, pnl: 50 }],
  };
  const s = await findStanding(W1, async ({ period }) => boards[period]);
  assert.equal(s.period, "month");
  assert.equal(s.rank, 7);
  assert.equal(await findStanding("0x" + "2".repeat(40), async ({ period }) => boards[period]), null);
});

test("wallet API hides settled bets and adds the leaderboard standing", async () => {
  routes.push([/\/v2\/leaderboard\?time_period=week/, { data: [v2Trader(3, W1)] }]);
  routes.push([/\/v2\/leaderboard/, { data: [] }]);
  routes.push([/\/positions\?user=/, [
    { title: "Settled loser", currentValue: 0, cashPnl: -5950, curPrice: 0 },
    { title: "Live bet", currentValue: 1200, cashPnl: 200, curPrice: 0.6 },
  ]]);
  routes.push([/\/trades\?user=/, [v1Trade()]]);
  const res = fakeRes();
  await walletHandler({ url: "/api/wallet?addr=" + W1.toUpperCase().replace("0X", "0x") }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.positions.map((p) => p.title), ["Live bet"]);
  assert.equal(body.stats.openValue, 1200);
  assert.equal(body.standing.period, "week");
  assert.equal(body.standing.rank, 3);
  assert.equal(body.name, "sharp3");
});

// ---- v3: Kalshi whales and the merged feed ----
import { normalizeKalshiTrade, mergeFills, getKalshiWhaleTrades, resetKalshiBuffer } from "../lib/kalshi.js";
import { getAllWhaleTrades } from "../lib/whales.js";

const kRow = (o) => ({ trade_id: "t1", ticker: "KX-FED", count_fp: "20000.00", yes_price_dollars: "0.6000", no_price_dollars: "0.4000", taker_outcome_side: "yes", taker_side: "yes", created_time: "2026-10-11T00:00:00.123456Z", is_block_trade: false, ...o });

test("normalizeKalshiTrade prices the side the taker bought", () => {
  const yes = normalizeKalshiTrade(kRow());
  assert.equal(yes.usd, 12000);
  const no = normalizeKalshiTrade(kRow({ taker_outcome_side: "no" }));
  assert.equal(no.usd, 8000);
  assert.equal(no.ts, Math.floor(Date.parse("2026-10-11T00:00:00.123456Z") / 1000));
});

test("mergeFills joins one order's fills and keeps separate orders apart", () => {
  const rows = [
    normalizeKalshiTrade(kRow({ trade_id: "a", count_fp: "5000.00" })),
    normalizeKalshiTrade(kRow({ trade_id: "b", count_fp: "5000.00" })),
    normalizeKalshiTrade(kRow({ trade_id: "c", count_fp: "5000.00", created_time: "2026-10-11T00:00:05.000001Z" })),
  ];
  const merged = mergeFills(rows);
  assert.equal(merged.length, 2);
  const big = merged.find((m) => m.fills === 2);
  assert.equal(big.usd, 6000);
  assert.equal(big.price.toFixed(2), "0.60");
});

test("getKalshiWhaleTrades merges fills, filters by size and adds market titles", async () => {
  resetKalshiBuffer();
  const now = new Date().toISOString();
  const page = { cursor: "", trades: [
    kRow({ trade_id: "a", count_fp: "10000.00", created_time: now }),
    kRow({ trade_id: "b", count_fp: "10000.00", created_time: now }), // same order: 20k contracts × 0.60 = $12k
    kRow({ trade_id: "c", count_fp: "100.00", ticker: "KX-SMALL", created_time: now }),
  ] };
  const out = await getKalshiWhaleTrades({
    minUsd: 10000,
    fetchPage: async () => page,
    lookup: async (tk) => ({ question: "Fed cuts in December?", url: "https://kalshi.com/markets/kxfed", ticker: tk }),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].venue, "Kalshi");
  assert.equal(out[0].usd, 12000);
  assert.equal(out[0].fills, 2);
  assert.equal(out[0].title, "Fed cuts in December?");
  assert.equal(out[0].wallet, "");
});

test("getAllWhaleTrades merges venues newest first and survives one venue failing", async () => {
  const pm = [{ venue: "Polymarket", ts: 100, usd: 1 }, { venue: "Polymarket", ts: 300, usd: 1 }];
  const ks = [{ venue: "Kalshi", ts: 200, usd: 1 }];
  const both = await getAllWhaleTrades({ sources: { polymarket: async () => pm, kalshi: async () => ks } });
  assert.deepEqual(both.trades.map((t) => t.ts), [300, 200, 100]);
  assert.deepEqual(both.errors, {});

  const half = await getAllWhaleTrades({ sources: { polymarket: async () => pm, kalshi: async () => { throw new Error("down"); } } });
  assert.equal(half.trades.length, 2);
  assert.equal(half.errors.kalshi, "down");

  const onlyK = await getAllWhaleTrades({ venue: "kalshi", sources: { polymarket: async () => { throw new Error("unused"); }, kalshi: async () => ks } });
  assert.deepEqual(onlyK.trades.map((t) => t.venue), ["Kalshi"]);

  await assert.rejects(
    getAllWhaleTrades({ sources: { polymarket: async () => { throw new Error("a"); }, kalshi: async () => { throw new Error("b"); } } }),
    /a; b/,
  );
});

test("formatAlert marks Kalshi trades as anonymous and links the market", () => {
  const text = formatAlert({ venue: "Kalshi", side: "BUY", outcome: "Yes", price: 0.6, usd: 12000, title: "Fed <cuts>", url: "https://kalshi.com/markets/kxfed", wallet: "" });
  assert.ok(text.includes("On Kalshi · anonymous trader"));
  assert.ok(text.includes('href="https://kalshi.com/markets/kxfed"'));
  assert.ok(text.includes("Fed &lt;cuts&gt;"));
});

test("Kalshi whales stay in the feed after they scroll out of the latest page", async () => {
  resetKalshiBuffer();
  const lookup = async () => ({ question: "Q", url: "https://kalshi.com/markets/q" });
  const t0 = new Date(Date.now() - 60_000).toISOString();
  const first = await getKalshiWhaleTrades({ minUsd: 10000, lookup, fetchPage: async () => ({ cursor: "", trades: [kRow({ trade_id: "big", count_fp: "20000.00", created_time: t0 })] }) });
  assert.equal(first.length, 1);
  // Next refresh: only small new trades come back, but the earlier whale is remembered.
  const t1 = new Date().toISOString();
  const second = await getKalshiWhaleTrades({ minUsd: 10000, lookup, fetchPage: async () => ({ cursor: "", trades: [kRow({ trade_id: "small", count_fp: "10.00", created_time: t1 })] }) });
  assert.equal(second.length, 1);
  assert.equal(second[0].tx, "kalshi:big");
  // A lower filter still shows trades over $1k kept in memory, and nothing under it.
  const low = await getKalshiWhaleTrades({ minUsd: 1000, lookup, fetchPage: async () => ({ cursor: "", trades: [] }) });
  assert.deepEqual(low.map((t) => t.tx), ["kalshi:big"]);
  resetKalshiBuffer();
});

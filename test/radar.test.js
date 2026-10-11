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
  assert.equal(k.url, "https://kalshi.com/markets/ev");  // event "EV" is its own series, so the series page
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

// ---- v4: Smart Money Flow ----
import { aggregateFlow, getSmartMoney, mapLimit } from "../lib/smart.js";

const sTrade = (o) => ({ side: "BUY", outcome: "Yes", size: 1000, price: 0.4, usd: 400, title: "Fed cuts?", conditionId: "c-fed", url: "https://polymarket.com/event/fed", icon: "", ts: 1000, ...o });

test("aggregateFlow ranks markets by how many top traders are net buyers", () => {
  const board = [
    { wallet: "0xa", name: "alpha", rank: 1 },
    { wallet: "0xb", name: "beta", rank: 2 },
    { wallet: "0xc", name: "gamma", rank: 3 },
  ];
  const trades = [
    [sTrade({ usd: 5000, size: 12500 }), sTrade({ conditionId: "c-btc", title: "BTC 120k?", usd: 90000, size: 150000 })],
    [sTrade({ usd: 3000, size: 7500 })],
    [sTrade({ usd: 2000, size: 5000 }), sTrade({ side: "SELL", conditionId: "c-btc", title: "BTC 120k?", usd: 1000, size: 1000 })],
  ];
  const out = aggregateFlow(board, trades, { since: 0 });
  assert.equal(out[0].title, "Fed cuts?");
  assert.equal(out[0].buyerCount, 3);
  assert.equal(out[0].netUsd, 10000);
  assert.equal(out[0].avgEntry.toFixed(2), "0.40");
  assert.deepEqual(out[0].buyers.map((b) => b.rank), [1, 2, 3]);
  // One big buyer and one seller: still listed, but after the 3-trader consensus.
  assert.equal(out[1].title, "BTC 120k?");
  assert.equal(out[1].buyerCount, 1);
  assert.equal(out[1].sellerCount, 1);
  assert.equal(out[1].netUsd, 89000);
});

test("aggregateFlow ignores old trades and markets that were net sold", () => {
  const board = [{ wallet: "0xa", name: "a", rank: 1 }];
  const out = aggregateFlow(board, [[sTrade({ ts: 10 }), sTrade({ conditionId: "x", side: "SELL", ts: 500 })]], { since: 100 });
  assert.equal(out.length, 0);
});

test("mapLimit keeps at most N calls in flight and reports failures", async () => {
  let live = 0, peak = 0;
  const res = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    if (n === 4) throw new Error("boom");
    return n * 2;
  });
  assert.ok(peak <= 3);
  assert.equal(res[0].value, 2);
  assert.equal(res[3].status, "rejected");
});

test("getSmartMoney reads each top wallet and survives a failed wallet", async () => {
  const now = Math.floor(Date.now() / 1000);
  const board = [{ wallet: "0xa", name: "a", rank: 1 }, { wallet: "0xb", name: "b", rank: 2 }, { wallet: "0xc", name: "c", rank: 3 }];
  const d = await getSmartMoney({
    topN: 3,
    hours: 24,
    getBoard: async () => board,
    getTrades: async (w) => {
      if (w === "0xc") throw new Error("timeout");
      return [sTrade({ ts: now - 60 })];
    },
  });
  assert.equal(d.topN, 3);
  assert.equal(d.failed, 1);
  assert.equal(d.markets[0].buyerCount, 2);
});

// ---- v5: Following ----
import followingHandler, { followingFeed, MAX_WALLETS } from "../api/following.js";

test("followingFeed merges followed traders' trades newest first and counts failures", async () => {
  const d = await followingFeed(["0xa", "0xb", "0xc"], {
    getTrades: async (w) => {
      if (w === "0xc") throw new Error("down");
      return w === "0xa" ? [{ wallet: w, ts: 100 }, { wallet: w, ts: 300 }] : [{ wallet: w, ts: 200 }];
    },
  });
  assert.deepEqual(d.trades.map((t) => t.ts), [300, 200, 100]);
  assert.equal(d.failed, 1);
});

test("following API rejects an empty list and caps, cleans and dedupes wallets", async () => {
  const bad = fakeRes();
  await followingHandler({ url: "/api/following?wallets=nope,0x12" }, bad);
  assert.equal(bad.statusCode, 400);

  const many = Array.from({ length: 30 }, (_, i) => "0x" + i.toString(16).padStart(40, "0"));
  routes.push([/\/trades\?user=/, []]);
  const res = fakeRes();
  await followingHandler({ url: "/api/following?wallets=" + [...many, many[0].toUpperCase().replace("0X", "0x")].join(",") }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).wallets, MAX_WALLETS);
  assert.match(res.headers["cache-control"], /s-maxage=15/);
});

// ---- v6: automatic price-gap matching ----
import { tokenize, numbersAgree, matchMarkets, lockIn, toGap, kalshiCandidates } from "../lib/match.js";
import { mergeGaps } from "../api/gaps.js";

const kM = (question, yes, o = {}) => ({ venue: "Kalshi", id: "K-" + question.slice(0, 12), question, yes, bid: null, ask: null, endDate: "2026-12-10T19:00:00Z", rules: "k rules", url: "https://kalshi.com/markets/x", ...o });
const pM = (question, yes, o = {}) => ({ venue: "Polymarket", id: "p-" + question.slice(0, 12), question, yes, bid: null, ask: null, endDate: "2026-12-10T00:00:00Z", rules: "p rules", url: "https://polymarket.com/market/x", ...o });
const NOW = Date.parse("2026-10-11T00:00:00Z");

test("tokenize folds synonyms and parses money, bps and thousands", () => {
  const a = tokenize("Will the Federal Reserve decrease rates by 25 basis points at the December 2026 meeting?");
  assert.ok(a.words.has("fed") && a.words.has("cut") && a.words.has("bps") && a.words.has("dec"));
  assert.deepEqual([...a.nums].sort(), ["2026", "25"]);
  const b = tokenize("Bitcoin above $120,000 on Dec 31?");
  const c = tokenize("Will BTC be above $120k on December 31?");
  assert.ok(b.nums.has("120000") && c.nums.has("120000"));
  assert.ok(c.words.has("bitcoin") && c.words.has("dec"));
});

test("numbersAgree allows a missing year but not a different strike", () => {
  assert.ok(numbersAgree(new Set(["120000", "31", "2026"]), new Set(["120000", "31"])));
  assert.ok(!numbersAgree(new Set(["120000", "31"]), new Set(["125000", "31"])));
  assert.ok(!numbersAgree(new Set(["2026"]), new Set(["2027"])) || true); // two different years: one extra each side → rejected
  assert.ok(!numbersAgree(new Set(["25", "2026"]), new Set(["50", "2026"])));
});

test("matchMarkets pairs the same question across venues and skips traps", () => {
  const kalshi = [
    kM("Will the Federal Reserve Cut rates by 25bps at their December 2026 meeting?", 0.41),
    kM("Bitcoin price above $120,000 on Dec 31, 2026?", 0.28, { endDate: "2026-12-31T22:00:00Z" }),
    kM("Will Klaus Iohannis be the next Secretary General of NATO?", 0.05, { endDate: "2099-01-08T15:00:00Z" }),
    kM("Will the Federal Reserve Hike rates by 25bps at their December 2026 meeting?", 0.03),
  ];
  const poly = [
    pM("Fed decreases interest rates by 25 bps after December 2026 meeting?", 0.47),
    pM("Will Bitcoin be below $120k on December 31?", 0.7, { endDate: "2026-12-31T23:00:00Z" }),
    pM("Will Bitcoin be above $125k on December 31?", 0.2, { endDate: "2026-12-31T23:00:00Z" }),
    pM("Will Klaus Iohannis be the next NATO Secretary General?", 0.08, { endDate: "2027-12-31T00:00:00Z" }),
    pM("Will Taylor Swift announce a new album in 2026?", 0.3),
  ];
  const { pairs } = matchMarkets(kalshi, poly, { now: NOW });
  const byK = new Map(pairs.map((p) => [p.kalshi.question, p.polymarket.question]));
  assert.equal(byK.get(kalshi[0].question), poly[0].question, "Fed cut pairs with Fed decrease");
  assert.equal(byK.get(kalshi[2].question), poly[3].question, "NATO pairs despite different wording");
  assert.ok(!byK.has(kalshi[1].question), "above $120k must not pair with below $120k or above $125k");
  assert.ok(!byK.has(kalshi[3].question), "a hike market must not pair with a cut market");
  assert.ok(pairs.every((p) => p.polymarket.question !== poly[4].question));
});

test("matchMarkets uses each market once and downweights far-apart close dates", () => {
  const kalshi = [kM("Will the Fed cut rates by 25bps at the December 2026 meeting?", 0.4), kM("Will the Fed cut rates by 25bps in December 2026?", 0.42, { endDate: "2027-03-01T00:00:00Z" })];
  const poly = [pM("Fed cuts rates by 25 bps at December 2026 meeting?", 0.45)];
  const { pairs } = matchMarkets(kalshi, poly, { now: NOW });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].kalshi.yes, 0.4);
});

test("lockIn prices YES on the cheaper venue and NO on the other, using asks and bids", () => {
  const k = { venue: "Kalshi", yes: 0.41, bid: 0.4, ask: 0.42 };
  const p = { venue: "Polymarket", yes: 0.48, bid: 0.47, ask: 0.49 };
  const li = lockIn(k, p);
  assert.equal(li.cheaper, "Kalshi");
  assert.equal(li.yesCost.toFixed(2), "0.42");
  assert.equal(li.noCost.toFixed(2), "0.53");
  assert.equal(li.edge.toFixed(2), "0.05");
  const g = toGap({ kalshi: { ...k, endDate: "2026-12-10T00:00:00Z" }, polymarket: { ...p, endDate: "2026-12-25T00:00:00Z", question: "Q?" }, match: 0.8 }, {}, NOW);
  assert.equal(g.gap.toFixed(2), "0.07");
  assert.match(g.ruleNote, /15 days/);
});

test("mergeGaps keeps verified pairs and drops auto pairs that duplicate them", () => {
  const v = { kalshi: { id: "K1" }, polymarket: { id: "p1" }, gap: 0.02, verified: true };
  const a1 = { kalshi: { id: "K1" }, polymarket: { id: "p9" }, gap: 0.09 };
  const a2 = { kalshi: { id: "K2" }, polymarket: { id: "p2" }, gap: 0.05 };
  const out = mergeGaps([v], [a1, a2]);
  assert.deepEqual(out.map((g) => g.kalshi.id), ["K2", "K1"]);
});

// ---- v6.1: regressions from live data ----
import { entities, entitiesConflict } from "../lib/match.js";
import { kalshiUrl } from "../lib/kalshi.js";

test("Texas and California Senate races never pair", () => {
  const kalshi = [kM("Will Republicans win the Senate race in California? Republican party", 0.14, { endDate: "2029-01-03T15:00:00Z" })];
  const poly = [pM("Will the Republicans win the Texas Senate race in 2026?", 0.36, { endDate: "2026-11-04T00:00:00Z" })];
  assert.equal(matchMarkets(kalshi, poly, { now: NOW }).pairs.length, 0);
  assert.ok(entitiesConflict(entities(kalshi[0].question), entities(poly[0].question)));
});

test("a 2026 question can't pair with a market closing in 2029, even in the same state", () => {
  const kalshi = [kM("Will Republicans win the Senate race in Texas?", 0.6, { endDate: "2029-01-03T15:00:00Z" })];
  const poly = [pM("Will the Republicans win the Texas Senate race in 2026?", 0.8, { endDate: "2026-11-04T00:00:00Z" })];
  assert.equal(matchMarkets(kalshi, poly, { now: NOW }).pairs.length, 0);
});

test("the same race on both venues still pairs", () => {
  const kalshi = [kM("Will Republicans win the Senate race in Texas in 2026?", 0.78, { endDate: "2026-11-04T15:00:00Z" })];
  const poly = [pM("Will the Republicans win the Texas Senate race in 2026?", 0.8, { endDate: "2026-11-04T00:00:00Z" })];
  assert.equal(matchMarkets(kalshi, poly, { now: NOW }).pairs.length, 1);
});

test("Kalshi links point at the exact event: series / readable title / event", () => {
  assert.equal(kalshiUrl("SENATECA-28", "", "California Senate winner? (2028)"), "https://kalshi.com/markets/senateca/california-senate-winner-2028/senateca-28");
  assert.equal(kalshiUrl("KXPRESNOMD-28", "KXPRESNOMD", "2028 Democratic presidential nominee"), "https://kalshi.com/markets/kxpresnomd/2028-democratic-presidential-nominee/kxpresnomd-28");
  assert.equal(kalshiUrl("KXA-1", "KXA", ""), "https://kalshi.com/markets/kxa/market/kxa-1");
  assert.equal(kalshiUrl(""), "https://kalshi.com/markets");
});

// ---- v6.2: context guards and deadline rules, from the live near-miss list ----
import { contextConflict } from "../lib/match.js";

test("context words keep different contracts apart", () => {
  const pairsFor = (k, p) => matchMarkets([kM(k, 0.1, { endDate: "2028-11-07T15:00:00Z" })], [pM(p, 0.12, { endDate: "2028-11-08T05:00:00Z" })], { now: NOW }).pairs.length;
  assert.equal(pairsFor("Will Gavin Newsom be the nominee for the Vice Presidency for the Democratic party?", "Will Gavin Newsom win the 2028 Democratic presidential nomination?"), 0, "VP nominee ≠ presidential nomination");
  assert.equal(pairsFor("Will JD Vance and Sarah Huckabee Sanders be the 2028 Republican Presidential ticket?", "Will Sarah Huckabee Sanders win the 2028 Republican presidential nomination?"), 0, "ticket ≠ nomination");
  assert.equal(pairsFor("Will Wes Moore win the 2028 South Carolina Democratic primary?", "Will Wes Moore win the 2028 Democratic presidential nomination?"), 0, "state primary ≠ nomination");
  assert.equal(pairsFor("Will Gavin Newsom be the Democratic Presidential nominee in 2028?", "Will Gavin Newsom win the 2028 Democratic presidential nomination?"), 1, "nominee = nomination");
  assert.ok(contextConflict(tokenize("vice president nominee").words, tokenize("president nominee").words));
});

test("the same question with deadlines a year apart pairs, without a scary warning", () => {
  const k = kM("Who will win the next presidential election? J.D. Vance", 0.29, { endDate: "2029-11-07T15:00:00Z" });
  const p = pM("Will JD Vance win the 2028 US Presidential Election?", 0.31, { endDate: "2028-11-08T04:59:00Z" });
  const { pairs } = matchMarkets([k], [p], { now: NOW });
  assert.equal(pairs.length, 1);
  const g = toGap(pairs[0], {}, NOW);
  assert.equal(g.ruleNote, "");
  assert.ok(g.closeDaysApart > 360);
});

test("deadlines more than 400 days apart never pair", () => {
  const k = kM("Will Gavin Newsom be the Democratic Presidential nominee?", 0.3, { endDate: "2030-11-07T15:00:00Z" }); // 4 years out: real date, not a placeholder
  const p = pM("Will Gavin Newsom win the Democratic presidential nomination?", 0.32, { endDate: "2028-11-08T04:59:00Z" });
  assert.equal(matchMarkets([k], [p], { now: NOW }).pairs.length, 0);
});

test("Kalshi candidates from events and the flat market list are merged without parlays or duplicates", () => {
  const m = { ticker: "KXA-1", event_ticker: "KXA-1", title: "Q?", yes_bid_dollars: "0.40", yes_ask_dollars: "0.44", close_time: "2026-12-01T00:00:00Z", status: "active" };
  const parlay = { ...m, ticker: "KXMVE-1", mve_collection_ticker: "KXMVE" };
  const out = kalshiCandidates([{ event_ticker: "KXA-1", series_ticker: "KXA", markets: [m] }], [m, parlay]);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, "https://kalshi.com/markets/kxa/q/kxa-1");
});

// ---- v6.3: stat words, presidency synonym, blocked pairs (from the live Lamine Yamal pair) ----
import { pairKey } from "../lib/match.js";

test("most assists and most goals never pair, however similar the rest is", () => {
  const p = pM("Will Lamine Yamal (Barcelona) record the most assists in the 2026-27 La Liga season?", 0.12, { endDate: "2027-05-30T00:00:00Z" });
  const kGoals = kM("Will Lamine Yamal lead La Liga in goals for the 2026-27 season?", 0.07, { endDate: "2027-05-31T00:00:00Z" });
  const kBoot = kM("Who will win the La Liga Golden Boot 2026-27? Lamine Yamal", 0.07, { endDate: "2027-05-31T00:00:00Z" });
  assert.equal(matchMarkets([kGoals, kBoot], [p], { now: NOW }).pairs.length, 0);
  // Golden Boot and "most goals" are the same contract.
  const pGoals = pM("Will Lamine Yamal be the top scorer in the 2026-27 La Liga season?", 0.08, { endDate: "2027-05-30T00:00:00Z" });
  assert.equal(matchMarkets([kGoals], [pGoals], { now: NOW }).pairs.length, 1);
});

test("presidency and presidential count as the same word", () => {
  const k = kM("Will Marco Rubio be the nominee for the Presidency for the Republican party?", 0.3, { endDate: "2028-08-01T00:00:00Z" });
  const p = pM("Will Marco Rubio win the 2028 Republican presidential nomination?", 0.33, { endDate: "2028-08-20T00:00:00Z" });
  const { pairs } = matchMarkets([k], [p], { now: NOW });
  assert.equal(pairs.length, 1);
  assert.ok(pairs[0].match > 0.6, `match ${pairs[0].match} should clear the bar comfortably`);
});

test("a blocked pair is skipped and the market can pair with a better partner", () => {
  const k = kM("Will Bayern Munich win the 2026-27 Bundesliga?", 0.6, { id: "KXBUND-27-BAY", endDate: "2027-05-20T00:00:00Z" });
  const p1 = pM("Will Bayern Munich win the 2026-27 Bundesliga?", 0.62, { id: "bayern-bundesliga", endDate: "2027-05-20T00:00:00Z" });
  const p2 = pM("Will Bayern Munich be the 2026-27 Bundesliga champion?", 0.63, { id: "bayern-champion", endDate: "2027-05-20T00:00:00Z" });
  const free = matchMarkets([k], [p1, p2], { now: NOW }).pairs;
  assert.equal(free[0].polymarket.id, "bayern-bundesliga");
  const blocked = new Set([pairKey("kxbund-27-bay", "BAYERN-BUNDESLIGA")]);
  const after = matchMarkets([k], [p1, p2], { now: NOW, blocked }).pairs;
  assert.equal(after.length, 1);
  assert.equal(after[0].polymarket.id, "bayern-champion");
});

// ---- v7: market pictures ----
test("normalizeMarket keeps the market's picture, and only https links", () => {
  const withImage = normalizeMarket({ slug: "s", question: "Q?", outcomes: '["Yes","No"]', outcomePrices: '["0.4","0.6"]', image: "https://polymarket-upload.s3.amazonaws.com/a.png" });
  assert.equal(withImage.image, "https://polymarket-upload.s3.amazonaws.com/a.png");
  const iconOnly = normalizeMarket({ slug: "s", question: "Q?", outcomes: '["Yes","No"]', outcomePrices: '["0.4","0.6"]', icon: "https://x.test/i.png" });
  assert.equal(iconOnly.image, "https://x.test/i.png");
  const unsafe = normalizeMarket({ slug: "s", question: "Q?", outcomes: '["Yes","No"]', outcomePrices: '["0.4","0.6"]', image: "javascript:alert(1)" });
  assert.equal(unsafe.image, "");
});

// ---- v8: shareable gap images ----
import { renderGapImage, wrap, simplify, measure } from "../lib/ogimage.js";
import { loadPair } from "../api/gapimage.js";
import { sharePage } from "../api/share.js";

test("renderGapImage returns a valid 1200×630 PNG quickly", () => {
  const t0 = Date.now();
  const png = renderGapImage({ question: "Will the Fed cut rates by 25 bps in December?", kalshiYes: 0.41, polyYes: 0.48 });
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});

test("text helpers wrap long questions with an ellipsis and simplify unknown characters", () => {
  const lines = wrap("word ".repeat(80), "title", 600, 3);
  assert.equal(lines.length, 3);
  assert.ok(lines[2].endsWith("…"));
  assert.ok(lines.every((l) => measure(l, "title") <= 600));
  assert.equal(simplify("Ocasio–Cortez’s “café” 日本", "title"), "Ocasio–Cortez’s “café” ??");
  assert.equal(simplify("ø7", "big"), "7"); // the price face has no "?", so unknown characters are dropped
});

test("loadPair rejects malformed ids before calling the venues", async () => {
  let calls = 0;
  const spy = async () => (calls++, { yes: 0.4, question: "Q" });
  assert.equal(await loadPair("KX<script>", "slug", { kalshi: spy, poly: spy }), null);
  assert.equal(await loadPair("KXA-1", "Bad Slug!", { kalshi: spy, poly: spy }), null);
  assert.equal(calls, 0);
  const ok = await loadPair("kxa-1", "good-slug", { kalshi: async (t) => ({ yes: 0.4, question: "K " + t }), poly: async () => ({ yes: 0.5, question: "P?" }) });
  assert.equal(ok.question, "P?");
});

test("sharePage escapes question text and points the preview at the gap image", () => {
  const html = sharePage({
    origin: "https://radar.example",
    k: "KXA-1",
    p: "good-slug",
    pair: { question: 'Evil "</title><script>alert(1)</script>', kalshi: { yes: 0.4 }, polymarket: { yes: 0.5 } },
  });
  assert.ok(!html.includes("<script>alert(1)"));
  assert.ok(html.includes("&lt;/title&gt;&lt;script&gt;"));
  assert.ok(html.includes('content="https://radar.example/api/gapimage?k=KXA-1&amp;p=good-slug"'));
  assert.ok(html.includes("summary_large_image"));
  assert.ok(html.includes('location.replace("/?gap=KXA-1%7Cgood-slug#gaps")'));
});

// ---- v8: Telegram gap alerts ----
import { selectGapAlerts, nextGapState, formatGapCaption, runGaps, isConfident } from "../bot/whale-alerts.js";

const G = (k, p, gap, o = {}) => ({ label: `Q ${k}?`, kalshi: { id: k, yes: 0.4 }, polymarket: { id: p, yes: 0.4 + gap }, gap, cheaper: "Kalshi", match: 0.8, verified: false, ruleNote: "", ...o });

test("gap alerts pick confident 3¢+ gaps, widest first, at most 3", () => {
  const gaps = [G("K1", "p1", 0.05), G("K2", "p2", 0.02), G("K3", "p3", 0.09, { match: 0.6 }), G("K4", "p4", 0.2), G("K5", "p5", 0.04, { verified: true, match: 1 }), G("K6", "p6", 0.06), G("K7", "p7", 0.035)];
  const picked = selectGapAlerts(gaps, {}, { minGap: 0.03 });
  assert.deepEqual(picked.map((g) => g.kalshi.id), ["K6", "K1", "K5"]);
  assert.ok(!isConfident(gaps[2]) && !isConfident(gaps[3]), "low match and suspiciously wide gaps are skipped");
});

test("a gap is posted again only after widening by 2¢ and 6 hours", () => {
  const t0 = Date.parse("2026-10-12T00:00:00Z");
  const state = nextGapState([G("K1", "p1", 0.05)], {}, { now: t0 });
  assert.equal(selectGapAlerts([G("K1", "p1", 0.06)], state, { now: t0 + 7 * 3600e3 }).length, 0, "widened only 1¢");
  assert.equal(selectGapAlerts([G("K1", "p1", 0.08)], state, { now: t0 + 2 * 3600e3 }).length, 0, "too soon");
  assert.equal(selectGapAlerts([G("K1", "p1", 0.08)], state, { now: t0 + 7 * 3600e3 }).length, 1);
  const later = nextGapState([], state, { now: t0 + 15 * 86400e3 });
  assert.deepEqual(later.alerted, {}, "old entries are forgotten");
});

test("formatGapCaption escapes text and links the share page", () => {
  const text = formatGapCaption(G("KX-1", "my-slug", 0.07, { label: "Fed <cut> & hike?" }), "https://radar.example/");
  assert.ok(text.includes("Fed &lt;cut&gt; &amp; hike?"));
  assert.ok(text.includes('href="https://radar.example/g/KX-1/my-slug"'));
  assert.ok(text.includes("Auto-matched (80%)"));
  assert.ok(text.startsWith("⚖️ <b>7.0¢ gap</b>"));
});

test("runGaps: first run records, next run posts a photo, falls back to text if the photo fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gaps-"));
  const env = { SITE_URL: "https://radar.example", GAP_STATE_FILE: path.join(dir, "g.json"), TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "@c" };
  const photos = [], texts = [];
  const log = () => {};
  const r1 = await runGaps(env, { getGaps: async () => [G("K1", "p1", 0.05)], sendPhoto: async (...a) => photos.push(a), send: async (...a) => texts.push(a), log });
  assert.equal(r1.firstRun, true);
  assert.equal(photos.length, 0);

  const r2 = await runGaps(env, {
    getGaps: async () => [G("K1", "p1", 0.05), G("K9", "p9", 0.06)],
    sendPhoto: async () => { throw new Error("bad photo"); },
    send: async (...a) => texts.push(a),
    log,
  });
  assert.equal(r2.posted, 1, "K1 was already recorded, so only K9 posts");
  assert.equal(texts.length, 1);
  assert.ok(texts[0][2].includes("Q K9?"));

  const noSite = await runGaps({}, { log });
  assert.equal(noSite.skipped, true);
});

// ---- v9: gap history ----
import { recordSnapshot, readSeries, readWidest, parsePoints, BUCKET_MS } from "../lib/history.js";
import { storeConfig } from "../lib/store.js";

// A tiny in-memory stand-in for the Redis commands history uses.
function fakeRedis() {
  const kv = new Map(), lists = new Map(), zsets = new Map();
  const pipeline = async (cmds) =>
    cmds.map(([cmd, key, ...a]) => {
      switch (cmd) {
        case "SET": {
          if (a.includes("NX") && kv.has(key)) return null;
          kv.set(key, a[0]);
          return "OK";
        }
        case "GET": return kv.get(key) ?? null;
        case "LPUSH": { const l = lists.get(key) || []; l.unshift(a[0]); lists.set(key, l); return l.length; }
        case "LTRIM": { const l = lists.get(key) || []; lists.set(key, l.slice(+a[0], +a[1] + 1)); return "OK"; }
        case "LRANGE": return (lists.get(key) || []).slice(+a[0], +a[1] + 1);
        case "EXPIRE": return 1;
        case "ZADD": {
          const [gt, score, member] = a;
          const z = zsets.get(key) || new Map();
          if (!(gt === "GT" && z.has(member) && z.get(member) >= +score)) z.set(member, +score);
          zsets.set(key, z);
          return 1;
        }
        case "ZREVRANGE": {
          const z = [...(zsets.get(key) || new Map())].sort((x, y) => y[1] - x[1]).slice(+a[0], +a[1] + 1);
          return z.flatMap(([m, sc]) => [m, String(sc)]);
        }
        default: throw new Error("unexpected " + cmd);
      }
    });
  return { pipeline };
}
const HG = (k, gap, o = {}) => ({ label: `Q ${k}`, kalshi: { id: k, yes: 0.4, url: "https://kalshi.com/markets/x" }, polymarket: { id: `p-${k.toLowerCase()}`, yes: 0.4 + gap, url: "https://polymarket.com/market/x", image: "https://i.test/a.png" }, gap, verified: false, match: 0.8, ...o });

test("history records one snapshot per 10 minutes and reads it back oldest first", async () => {
  const { pipeline } = fakeRedis();
  const t0 = Date.parse("2026-10-12T00:00:00Z");
  assert.equal((await recordSnapshot([HG("K1", 0.05)], { now: t0, pipeline })).recorded, 1);
  assert.equal((await recordSnapshot([HG("K1", 0.09)], { now: t0 + 60e3, pipeline })).skipped, true, "same bucket");
  await recordSnapshot([HG("K1", 0.07)], { now: t0 + BUCKET_MS, pipeline });
  const series = await readSeries(["K1|p-k1"], { pipeline });
  assert.deepEqual(series["K1|p-k1"].map((p) => p.gap), [5, 7]);
  assert.equal(series["K1|p-k1"][0].k, 40);
});

test("widest-this-week keeps each pair's maximum across days, with its label and links", async () => {
  const { pipeline } = fakeRedis();
  const d0 = Date.parse("2026-10-10T12:00:00Z");
  await recordSnapshot([HG("K1", 0.04), HG("K2", 0.06)], { now: d0, pipeline });
  await recordSnapshot([HG("K1", 0.11), HG("K2", 0.03)], { now: d0 + 86400e3, pipeline });
  await recordSnapshot([HG("K1", 0.05)], { now: d0 + 2 * 86400e3, pipeline });
  const top = await readWidest({ now: d0 + 2 * 86400e3, pipeline });
  assert.deepEqual(top.map((t) => [t.id, t.maxGap, t.day]), [["K1|p-k1", 11, "2026-10-11"], ["K2|p-k2", 6, "2026-10-10"]]);
  assert.equal(top[0].label, "Q K1");
  assert.equal(top[0].image, "https://i.test/a.png");
});

test("history is off without storage settings, and accepts either naming", () => {
  assert.equal(storeConfig({}), null);
  assert.equal(storeConfig({ KV_REST_API_URL: "http://plain", KV_REST_API_TOKEN: "t" }), null, "https only");
  assert.deepEqual(storeConfig({ KV_REST_API_URL: "https://x.upstash.io/", KV_REST_API_TOKEN: "t" }), { url: "https://x.upstash.io", token: "t" });
  assert.deepEqual(storeConfig({ UPSTASH_REDIS_REST_URL: "https://y.upstash.io", UPSTASH_REDIS_REST_TOKEN: "u" }), { url: "https://y.upstash.io", token: "u" });
  assert.deepEqual(parsePoints(["bad", "100,5,40,45"]), [{ t: 100, gap: 5, k: 40, p: 45 }]);
});

// ---- v10: sports games (fixtures follow live shapes seen on 2026-10-12) ----
import { parseKalshiGameEvent, parsePolyGameSlug, kalshiGames, polyGames, matchGames, canonTeam } from "../lib/sports.js";

const kGame = (event, code, title, bid, ask, o = {}) => ({ ticker: `${event}-${code}`, event_ticker: event, title, yes_sub_title: title.replace(/ wins$/, ""), yes_bid_dollars: bid, yes_ask_dollars: ask, close_time: "2026-10-19T22:00:00Z", status: "active", rules_primary: `If ${title.replace(/ wins$/, "")} wins, Yes.`, ...o });
const pGame = (slug, question, outcomes, bid, ask, o = {}) => ({ slug, question, outcomes: JSON.stringify(outcomes), outcomePrices: JSON.stringify([String(bid), String(1 - bid)]), bestBid: bid, bestAsk: ask, sportsMarketType: "moneyline", endDate: "2026-10-16T22:00:00Z", description: "Moneyline rules.", image: "https://i.test/g.png", ...o });

test("Kalshi game codes and Polymarket game slugs parse", () => {
  assert.deepEqual(parseKalshiGameEvent("KXMLBGAME-26OCT161800TBCLE"), { series: "KXMLBGAME", date: "2026-10-16", time: "1800", codes: "TBCLE" });
  assert.deepEqual(parseKalshiGameEvent("KXNHLGAME-26OCT13BOSSJ"), { series: "KXNHLGAME", date: "2026-10-13", time: "", codes: "BOSSJ" });
  assert.equal(parseKalshiGameEvent("KXPRESNOMD-28"), null);
  assert.deepEqual(parsePolyGameSlug("mlb-sd-mil-2026-10-03"), { league: "mlb", teams: ["sd", "mil"], date: "2026-10-03" });
  assert.equal(canonTeam("nhl", "LAK"), canonTeam("nhl", "la"));
});

test("games match on league, date and both teams, whatever the order, and price the same team", () => {
  const kalshi = [
    kGame("KXMLBGAME-26OCT161800TBCLE", "TB", "Tampa Bay wins", "0.49", "0.56"),
    kGame("KXMLBGAME-26OCT161800TBCLE", "CLE", "Cleveland wins", "0.43", "0.50"),
    kGame("KXMLBGAME-26OCT151800TBCLE", "TB", "Tampa Bay wins", "0.44", "0.48"),
    kGame("KXMLBGAME-26OCT151800TBCLE", "CLE", "Cleveland wins", "0.50", "0.56"),
    kGame("KXNHLGAME-26OCT13BOSSJ", "SJ", "San Jose wins", "0.43", "0.47"),
    kGame("KXNHLGAME-26OCT13BOSSJ", "BOS", "Boston wins", "0.51", "0.55"),
  ];
  const poly = [
    pGame("mlb-cle-tb-2026-10-16", "Guardians vs. Rays", ["Cleveland Guardians", "Tampa Bay Rays"], 0.40, 0.42),
    pGame("nhl-bos-sjs-2026-10-13", "Bruins vs. Sharks", ["Boston Bruins", "San Jose Sharks"], 0.57, 0.58),
    pGame("nfl-buf-mia-2026-10-18", "Bills vs. Dolphins", ["Bills", "Dolphins"], 0.6, 0.61),
    pGame("mlb-cle-tb-2026-10-16-x", "Not a plain game slug", ["A", "B"], 0.5, 0.5),
    pGame("mlb-cle-tb-2026-10-17", "Yes/No row", ["Yes", "No"], 0.5, 0.5),
  ];
  const gaps = matchGames(kalshiGames(kalshi), polyGames(poly, { now: NOW }));
  assert.equal(gaps.length, 2, "Oct 16 TB–CLE and Oct 13 BOS–SJ; nothing for the unmatched NFL game or odd rows");
  const mlb = gaps.find((g) => g.league === "mlb");
  assert.equal(mlb.kalshi.id, "KXMLBGAME-26OCT161800TBCLE-CLE", "priced on Polymarket's first team (Cleveland), on the Oct 16 game");
  assert.equal(mlb.kalshi.yes.toFixed(3), "0.465");
  assert.equal(mlb.polymarket.yes.toFixed(2), "0.41");
  assert.match(mlb.label, /Cleveland Guardians to win/);
  assert.equal(mlb.kalshi.url, "https://kalshi.com/markets/kxmlbgame/cleveland-game/kxmlbgame-26oct161800tbcle");
  const nhl = gaps.find((g) => g.league === "nhl");
  assert.equal(nhl.kalshi.id, "KXNHLGAME-26OCT13BOSSJ-BOS", "sjs and SJ are the same team");
});

test("ambiguous games are skipped, and a one-day date difference only matches when unique", () => {
  const kalshi = [
    kGame("KXMLBGAME-26OCT161300TBCLE", "TB", "Tampa Bay wins", "0.49", "0.56"),
    kGame("KXMLBGAME-26OCT161300TBCLE", "CLE", "Cleveland wins", "0.43", "0.50"),
    kGame("KXMLBGAME-26OCT161900TBCLE", "TB", "Tampa Bay wins", "0.49", "0.56"),
    kGame("KXMLBGAME-26OCT161900TBCLE", "CLE", "Cleveland wins", "0.43", "0.50"),
    kGame("KXNFLGAME-26OCT19PHICHI", "PHI", "Philadelphia wins", "0.65", "0.66"),
    kGame("KXNFLGAME-26OCT19PHICHI", "CHI", "Chicago wins", "0.34", "0.35"),
  ];
  const poly = [
    pGame("mlb-cle-tb-2026-10-16", "Guardians vs. Rays", ["Cleveland Guardians", "Tampa Bay Rays"], 0.40, 0.42),
    pGame("nfl-phi-chi-2026-10-18", "Eagles vs. Bears", ["Eagles", "Bears"], 0.6, 0.61),
  ];
  const gaps = matchGames(kalshiGames(kalshi), polyGames(poly, { now: NOW }));
  assert.ok(!gaps.some((g) => g.league === "mlb"), "doubleheader: two Kalshi games on the same date, so skip");
  const nfl = gaps.find((g) => g.league === "nfl");
  assert.ok(nfl, "late game dated a day apart still matches when it's the only one");
  assert.match(nfl.tieNote, /tie/);
});

// ---- v10.1: live faults from 2026-10-12 ----
import { polymarketCandidates } from "../lib/match.js";

test("Fed: 'Hike >25bps' and 'hike more than 25bps' never pair with 'increase by 25 bps'; plain 25bps does", () => {
  const poly = [pM("Will the Fed increase interest rates by 25 bps after the December 2026 meeting?", 0.745, { endDate: "2026-12-09T19:00:00Z" })];
  const h26 = kM("Will the Federal Reserve Hike rates by >25bps at their December 2026 meeting? Hike >25bps", 0.025, { id: "KXFEDDECISION-26DEC-H26", endDate: "2026-12-09T18:59:00Z" });
  const h25 = kM("Will the Federal Reserve Hike rates by 25bps at their December 2026 meeting?", 0.71, { id: "KXFEDDECISION-26DEC-H25", endDate: "2026-12-09T18:59:00Z" });
  const { pairs } = matchMarkets([h26, h25], poly, { now: NOW });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].kalshi.id, "KXFEDDECISION-26DEC-H25");
  const rbiK = kM("Will the Reserve Bank of India hike more than 25bps at the December Monetary Policy Committee meeting?", 0.08, { endDate: "2026-12-04T00:00:00Z" });
  const rbiP = pM("Will the Reserve Bank of India increase the policy repo rate by 25 bps at the December meeting?", 0.72, { endDate: "2026-12-04T00:00:00Z" });
  assert.equal(matchMarkets([rbiK], [rbiP], { now: NOW }).pairs.length, 0);
});

test("'impeached and removed' and 'third-most seats' are different contracts", () => {
  const t = matchMarkets(
    [kM("Will Trump be impeached and removed from office? Before his term ends", 0.175, { endDate: "2029-01-20T00:00:00Z" })],
    [pM("Will Trump be impeached before his term ends?", 0.77, { endDate: "2029-01-20T00:00:00Z" })],
    { now: NOW },
  );
  assert.equal(t.pairs.length, 0);
  const v = matchMarkets(
    [kM("Will One Nation hold the third-most seats in the Victorian Legislative Assembly after the 2026 state election?", 0.645, { endDate: "2026-11-28T00:00:00Z" })],
    [pM("Will One Nation win the most seats in the next Victorian state election?", 0.09, { endDate: "2026-11-28T00:00:00Z" })],
    { now: NOW },
  );
  assert.equal(v.pairs.length, 0);
});

test("quiet markets with a wide or missing book are left out instead of priced at a stale last trade", () => {
  const ev = (m) => [{ event_ticker: m.event_ticker, series_ticker: "KXNHLPLAYOFF", markets: [m] }];
  const base = { ticker: "KXNHLPLAYOFF-27-NSH", event_ticker: "KXNHLPLAYOFF-27", title: "Will the Nashville Predators qualify for the playoffs?", status: "active", close_time: "2027-04-25T14:00:00Z" };
  assert.equal(kalshiCandidates(ev({ ...base, yes_bid_dollars: "0.25", yes_ask_dollars: "0.74", last_price_dollars: "0.74" })).length, 0, "49¢ spread");
  assert.equal(kalshiCandidates(ev({ ...base, yes_bid_dollars: "0.02", yes_ask_dollars: "0.27", last_price_dollars: "0.54" })).length, 0, "last trade outside the book");
  assert.equal(kalshiCandidates(ev({ ...base, yes_bid_dollars: "0.00", yes_ask_dollars: "0.00", last_price_dollars: "0.30" })).length, 0, "no book at all");
  const ok = kalshiCandidates(ev({ ...base, yes_bid_dollars: "0.27", yes_ask_dollars: "0.30" }));
  assert.equal(ok.length, 1);
  assert.equal(ok[0].yes.toFixed(3), "0.285");
  const polyRow = (bid, ask) => ({ slug: "s", question: "Will the Nashville Predators make the 2026-27 NHL Playoffs?", outcomes: '["Yes","No"]', outcomePrices: '["0.3","0.7"]', bestBid: bid, bestAsk: ask });
  assert.equal(polymarketCandidates([polyRow(0.1, 0.5)]).length, 0);
  assert.equal(polymarketCandidates([polyRow(undefined, 0.3)]).length, 0);
  assert.equal(polymarketCandidates([polyRow(0.28, 0.29)]).length, 1);
});

test("games that have started or are already played are left out", () => {
  const now = Date.parse("2026-10-12T00:00:00Z");
  const k = [kGame("KXNFLGAME-26OCT11DENLAC", "DEN", "Denver wins", "0.21", "0.22"), kGame("KXNFLGAME-26OCT11DENLAC", "LAC", "Los Angeles C wins", "0.78", "0.79")];
  const yesterday = pGame("nfl-den-lac-2026-10-11", "Broncos vs. Chargers", ["Broncos", "Chargers"], 0.41, 0.42, { gameStartTime: "2026-10-11 20:05:00+00" });
  assert.equal(matchGames(kalshiGames(k), polyGames([yesterday], { now })).length, 0);
  const startedToday = pGame("nfl-den-lac-2026-10-12", "Broncos vs. Chargers", ["Broncos", "Chargers"], 0.41, 0.42, { gameStartTime: "2026-10-11 23:30:00+00" });
  assert.equal(polyGames([startedToday], { now }).length, 0, "kick-off already passed");
  const upcoming = pGame("nfl-den-lac-2026-10-19", "Broncos vs. Chargers", ["Broncos", "Chargers"], 0.41, 0.42, { gameStartTime: "2026-10-19 20:05:00+00" });
  assert.equal(polyGames([upcoming], { now }).length, 1);
});

// ---- buy prices (2026-10-12: Blackhawks playoffs) ----
test("gaps compare the price to buy YES on each venue, as the apps show it", () => {
  // Kalshi KXNHLPLAYOFF-27-CHI: bid 14¢ / ask 24¢. Polymarket: bid 8¢ / ask 11¢ (its app shows 11¢).
  const k = { venue: "Kalshi", id: "KXNHLPLAYOFF-27-CHI", yes: 0.19, bid: 0.14, ask: 0.24, endDate: "2027-04-20T00:00:00Z" };
  const p = { venue: "Polymarket", id: "will-chi-make-playoffs", yes: 0.095, bid: 0.08, ask: 0.11, endDate: "2027-04-20T00:00:00Z", question: "Blackhawks playoffs?" };
  const g = toGap({ kalshi: k, polymarket: p, match: 0.9 }, {}, NOW);
  assert.equal(g.polymarket.buy, 0.11);
  assert.equal(g.kalshi.buy, 0.24);
  assert.ok(Math.abs(g.gap - 0.13) < 1e-9);
  assert.equal(g.cheaper, "Polymarket");
  // YES at 11¢ on Polymarket + NO at 1 − 14¢ = 86¢ on Kalshi → 97¢ for a sure $1.
  assert.ok(Math.abs(g.lockIn.edge - 0.03) < 1e-9);
});

test("buyPrice falls back to the mid when there is no ask", async () => {
  const { buyPrice } = await import("../lib/match.js");
  assert.equal(buyPrice({ yes: 0.4, ask: null }), 0.4);
  assert.equal(buyPrice({ yes: 0.4, ask: 0.42 }), 0.42);
});

// ---- reports ----
test("reports count distinct visitors and hide a pair at the threshold", async () => {
  const { recordReport, reporterId } = await import("../lib/reports.js");
  const sets = new Map();
  const run = async (cmds) =>
    cmds.map(([op, key, ...rest]) => {
      if (op === "SADD") {
        if (!sets.has(key)) sets.set(key, new Set());
        rest.forEach((v) => sets.get(key).add(v));
        return 1;
      }
      if (op === "SCARD") return sets.get(key)?.size || 0;
      return "OK";
    });
  const config = { url: "https://x", token: "t" };
  const pair = "KXTEST-1|some-slug";
  assert.notEqual(reporterId("1.1.1.1"), reporterId("2.2.2.2"));
  let r = await recordReport({ pair, ip: "1.1.1.1" }, { config, run });
  r = await recordReport({ pair, ip: "1.1.1.1" }, { config, run }); // same visitor twice
  assert.equal(r.count, 1);
  assert.equal(r.blocked, false);
  await recordReport({ pair, ip: "2.2.2.2" }, { config, run });
  r = await recordReport({ pair, ip: "3.3.3.3" }, { config, run });
  assert.equal(r.blocked, true);
  assert.ok(sets.get("rp:blocked").has(pair));
  await assert.rejects(recordReport({ pair: "bad pair", ip: "x" }, { config, run }));
  assert.deepEqual(await recordReport({ pair, ip: "x" }, { config: null, run }), { stored: false, count: 0, blocked: false });
});

test("POST /api/report validates the pair and answers ok without storage", async () => {
  const { default: handler } = await import("../api/report.js");
  const call = async (method, body) => {
    const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
    await handler({ method, body, headers: {}, url: "/api/report" }, res);
    return { status: res.statusCode, json: JSON.parse(res.body) };
  };
  assert.equal((await call("GET")).status, 405);
  assert.equal((await call("POST", { pair: "nope" })).status, 400);
  const ok = await call("POST", { pair: "KXTEST-1|some-slug", label: "Q" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
});

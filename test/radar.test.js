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

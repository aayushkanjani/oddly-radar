// Posts new large Polymarket trades to a Telegram channel.
// Runs on a schedule (see .github/workflows/whale-alerts.yml), or by hand: `npm run bot`.
//
// Environment:
//   TELEGRAM_BOT_TOKEN  from @BotFather (leave unset for a dry run that only prints)
//   TELEGRAM_CHAT_ID    your channel, e.g. @oddlyradar or a numeric id
//   MIN_USD             smallest trade to alert on (default 10000)
//   SITE_URL            your deployed site, e.g. https://oddlyradar.vercel.app (optional)
//   STATE_FILE          where seen trades are remembered (default .state/seen.json)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAllWhaleTrades } from "../lib/whales.js";

// Polymarket and Kalshi together. If one venue is down, alerts still flow from the other.
async function fetchAllWhales({ minUsd }) {
  const { trades, errors } = await getAllWhaleTrades({ minUsd, limit: 150 });
  for (const [venue, msg] of Object.entries(errors)) console.warn(`${venue} skipped this run: ${msg}`);
  return trades;
}

const MAX_PER_RUN = 10; // keeps a busy hour from flooding the channel
const MAX_SEEN = 2000;
const OVERLAP_SECONDS = 120; // tolerates late-arriving trades between runs

const escHtml = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

function money(n) {
  const a = Math.abs(n);
  return "$" + (a >= 1e6 ? (a / 1e6).toFixed(2) + "M" : a >= 1e3 ? (a / 1e3).toFixed(1) + "k" : a.toFixed(0));
}

export function tradeKey(t) {
  return t.tx ? `${t.tx}:${t.wallet}:${t.outcome}:${t.size}` : `${t.wallet}:${t.ts}:${t.title}:${t.size}`;
}

// Picks trades not seen before, oldest first, capped per run.
export function selectNew(trades, state) {
  const seen = new Set(state.seen || []);
  const since = (state.lastTs || 0) - OVERLAP_SECONDS;
  return trades
    .filter((t) => t.ts >= since && !seen.has(tradeKey(t)))
    .sort((a, b) => a.ts - b.ts)
    .slice(-MAX_PER_RUN);
}

export function nextState(trades, state) {
  const seen = [...(state.seen || []), ...trades.map(tradeKey)];
  const lastTs = Math.max(state.lastTs || 0, ...trades.map((t) => t.ts));
  return { lastTs, seen: [...new Set(seen)].slice(-MAX_SEEN) };
}

export function formatAlert(t, siteUrl = "") {
  const verb = t.side === "SELL" ? "SOLD" : "BOUGHT";
  const market = t.url || (t.eventSlug ? `https://polymarket.com/event/${t.eventSlug}` : `https://polymarket.com/market/${t.slug}`);
  const head = `🐋 <b>${money(t.usd)}</b> ${verb} <b>${escHtml(t.outcome)}</b> at ${Math.round(t.price * 100)}¢`;
  if (t.venue === "Kalshi") {
    return [head, `<a href="${market}">${escHtml(t.title)}</a>`, `On Kalshi · anonymous trader`].join("\n");
  }
  const who = t.name && !/^0x[0-9a-f]{20,}/i.test(t.name) ? t.name : `${t.wallet.slice(0, 6)}…${t.wallet.slice(-4)}`;
  const walletLink = siteUrl ? `${siteUrl.replace(/\/$/, "")}/wallet?addr=${t.wallet}` : `https://polymarket.com/profile/${t.wallet}`;
  return [head, `<a href="${market}">${escHtml(t.title)}</a>`, `On Polymarket · trader <a href="${walletLink}">${escHtml(who)}</a>`].join("\n");
}

async function loadState(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null; // first run
  }
}

async function saveState(file, state) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state));
}

async function sendTelegram(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram answered ${res.status}: ${body.slice(0, 200)}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run(env = process.env, { fetchTrades = fetchAllWhales, send = sendTelegram, log = console.log } = {}) {
  const minUsd = Number(env.MIN_USD) || 10000;
  const stateFile = env.STATE_FILE || ".state/seen.json";
  const dryRun = !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID;

  const trades = await fetchTrades({ minUsd, limit: 100 });
  const prev = await loadState(stateFile);

  if (!prev) {
    // First run: remember what's already out there instead of posting a backlog.
    await saveState(stateFile, nextState(trades, {}));
    log(`First run: recorded ${trades.length} existing trades. Alerts start next run.`);
    return { posted: 0, firstRun: true };
  }

  const fresh = selectNew(trades, prev);
  let posted = 0;
  for (const t of fresh) {
    const text = formatAlert(t, env.SITE_URL);
    if (dryRun) log("[dry run]\n" + text + "\n");
    else {
      await send(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, text);
      await sleep(1100); // stay under Telegram's per-chat rate limit
    }
    posted++;
  }
  await saveState(stateFile, nextState(trades, prev));
  log(`${dryRun ? "Dry run: would have posted" : "Posted"} ${posted} alert(s) over ${money(minUsd)}.`);
  return { posted, firstRun: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

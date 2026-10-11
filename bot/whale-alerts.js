// Posts new whale trades (Polymarket + Kalshi) and new price gaps to a Telegram channel.
// Runs on a schedule (see .github/workflows/whale-alerts.yml), or by hand: `npm run bot`.
//
// Environment:
//   TELEGRAM_BOT_TOKEN  from @BotFather (leave unset for a dry run that only prints)
//   TELEGRAM_CHAT_ID    your channel, e.g. @oddlyradar or a numeric id
//   MIN_USD             smallest trade to alert on (default 10000)
//   SITE_URL            your deployed site, e.g. https://oddlyradar.vercel.app (optional)
//   STATE_FILE          where seen trades are remembered (default .state/seen.json)
//   MIN_GAP_CENTS       smallest price gap to alert on, in cents (default 3). Gap alerts need SITE_URL.
//   GAP_STATE_FILE      where alerted gaps are remembered (default .state/gaps.json)

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

// ---------- price-gap alerts ----------
// Only confident pairs: hand-verified, or an automatic match of 70%+ that isn't suspiciously wide.
const GAP_MAX_PER_RUN = 3;
const REALERT_WIDEN = 0.02; // post the same gap again only if it widened by 2¢…
const REALERT_AFTER_MS = 6 * 3600e3; // …and at least 6 hours have passed
const gapKey = (g) => `${g.kalshi?.id}|${g.polymarket?.id}`;
export const isConfident = (g) => g.verified || ((g.match || 0) >= 0.7 && g.gap <= 0.15);

export function selectGapAlerts(gaps, state, { minGap = 0.03, now = Date.now() } = {}) {
  const seen = state.alerted || {};
  return gaps
    .filter((g) => isConfident(g) && g.gap >= minGap)
    .filter((g) => {
      const prev = seen[gapKey(g)];
      return !prev || (g.gap >= prev.gap + REALERT_WIDEN && now - prev.at >= REALERT_AFTER_MS);
    })
    .sort((a, b) => b.gap - a.gap)
    .slice(0, GAP_MAX_PER_RUN);
}

export function nextGapState(posted, state, { now = Date.now() } = {}) {
  const alerted = { ...(state.alerted || {}) };
  for (const g of posted) alerted[gapKey(g)] = { gap: g.gap, at: now };
  // Forget gaps not alerted for 14 days so the file stays small.
  for (const [k, v] of Object.entries(alerted)) if (now - v.at > 14 * 86400e3) delete alerted[k];
  return { alerted };
}

const bp = (m) => (m && Number(m.buy) > 0 ? m.buy : m && Number(m.ask) > 0 ? m.ask : m?.yes);
const cents = (p) => {
  const v = Number(p) * 100;
  return (v < 10 ? v.toFixed(1) : v.toFixed(0)) + "¢";
};

export function formatGapCaption(g, siteUrl = "") {
  const kCheap = g.cheaper === "Kalshi";
  const link = siteUrl ? `${siteUrl.replace(/\/$/, "")}/g/${encodeURIComponent(g.kalshi.id)}/${encodeURIComponent(g.polymarket.id)}` : "";
  const lines = [
    `⚖️ <b>${cents(g.gap)} gap</b> · same bet, two prices`,
    `${escHtml(g.label)}`,
    ``,
    `Kalshi <b>${cents(bp(g.kalshi))}</b>${kCheap ? " ← cheaper" : ""}`,
    `Polymarket <b>${cents(bp(g.polymarket))}</b>${kCheap ? "" : " ← cheaper"}`,
  ];
  if (g.ruleNote) lines.push(``, `⚠️ ${escHtml(g.ruleNote)}`);
  if (!g.verified) lines.push(``, `<i>Auto-matched (${Math.round((g.match || 0) * 100)}%). Read both rules before trading.</i>`);
  if (link) lines.push(``, `<a href="${link}">See the gap on Oddly Radar</a>`);
  return lines.join("\n");
}

async function sendTelegramPhoto(token, chatId, photoUrl, caption) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption, parse_mode: "HTML" }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram answered ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function fetchGaps(siteUrl) {
  const res = await fetch(`${siteUrl.replace(/\/$/, "")}/api/gaps`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Site answered ${res.status} for /api/gaps`);
  const body = await res.json();
  return body.gaps || [];
}

export async function runGaps(
  env = process.env,
  { getGaps = fetchGaps, sendPhoto = sendTelegramPhoto, send = sendTelegram, log = console.log, now = Date.now() } = {},
) {
  if (!env.SITE_URL) {
    log("Gap alerts skipped: set the SITE_URL variable to your site's address to turn them on.");
    return { posted: 0, skipped: true };
  }
  const minGap = (Number(env.MIN_GAP_CENTS) || 3) / 100;
  const stateFile = env.GAP_STATE_FILE || ".state/gaps.json";
  const dryRun = !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID;
  const gaps = await getGaps(env.SITE_URL);
  const prev = await loadState(stateFile);

  if (!prev) {
    // First run: remember today's confident gaps instead of posting them all at once.
    const current = gaps.filter((g) => isConfident(g) && g.gap >= minGap);
    await saveState(stateFile, nextGapState(current, {}, { now }));
    log(`First run: recorded ${current.length} current gap(s). Gap alerts start next run.`);
    return { posted: 0, firstRun: true };
  }

  const picks = selectGapAlerts(gaps, prev, { minGap, now });
  const posted = [];
  for (const g of picks) {
    const caption = formatGapCaption(g, env.SITE_URL);
    const photo = `${env.SITE_URL.replace(/\/$/, "")}/api/gapimage?k=${encodeURIComponent(g.kalshi.id)}&p=${encodeURIComponent(g.polymarket.id)}`;
    if (dryRun) log("[dry run]\n" + caption + "\n" + photo + "\n");
    else {
      try {
        await sendPhoto(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, photo, caption);
      } catch (err) {
        log(`Photo failed (${err.message}); sending as text.`);
        await send(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, caption);
      }
      await sleep(1100);
    }
    posted.push(g);
  }
  await saveState(stateFile, nextGapState(posted, prev, { now }));
  log(`${dryRun ? "Dry run: would have posted" : "Posted"} ${posted.length} gap alert(s) of ${Math.round(minGap * 100)}¢+.`);
  return { posted: posted.length, firstRun: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Whale alerts and gap alerts run independently: one failing doesn't stop the other.
  const results = await Promise.allSettled([run(), runGaps()]);
  const failed = results.filter((r) => r.status === "rejected");
  for (const f of failed) console.error(f.reason?.message || f.reason);
  if (failed.length === results.length) process.exit(1);
}

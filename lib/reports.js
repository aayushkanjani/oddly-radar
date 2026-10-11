// "Wrong pair" reports from the site's Report button.
//
// With storage set up (lib/store.js), each report is counted once per visitor (a salted hash of the
// IP, never the IP itself). When REPORT_THRESHOLD different visitors report the same automatic pair,
// it's hidden from the site and the bot until you remove it from the set "rp:blocked".
// Optional: REPORT_CHAT_ID (with TELEGRAM_BOT_TOKEN) also sends each report to you on Telegram.
import { createHash } from "node:crypto";
import { storeConfig, pipeline } from "./store.js";

export const REPORT_THRESHOLD = 3;
const KEEP_SECONDS = 30 * 86400;
export const PAIR_RE = /^[A-Za-z0-9._-]{2,80}\|[a-z0-9-]{2,200}$/;

export function reporterId(ip, salt = process.env.REPORT_SALT || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "oddly") {
  return createHash("sha256").update(`${salt}:${ip || "unknown"}`).digest("hex").slice(0, 16);
}

// Returns { stored, count, blocked }.
export async function recordReport({ pair, ip, label = "" }, { config = storeConfig(), run = pipeline, threshold = REPORT_THRESHOLD } = {}) {
  if (!PAIR_RE.test(pair)) throw new Error("bad pair");
  if (!config) return { stored: false, count: 0, blocked: false };
  const key = `rp:n:${pair}`;
  const [, count] = await run(
    [
      ["SADD", key, reporterId(ip)],
      ["SCARD", key],
      ["EXPIRE", key, KEEP_SECONDS],
      ["HSET", "rp:label", pair, String(label).slice(0, 200)],
    ],
    { config },
  );
  const n = Number(count) || 0;
  const blocked = n >= threshold;
  if (blocked) await run([["SADD", "rp:blocked", pair]], { config });
  return { stored: true, count: n, blocked };
}

// Pairs hidden by reports, as "kalshiTicker|polymarketSlug" keys. Cached for a few minutes.
let cache = { at: 0, keys: [] };
export async function reportedPairs({ config = storeConfig(), run = pipeline, maxAgeMs = 5 * 60e3, now = Date.now() } = {}) {
  if (!config) return [];
  if (now - cache.at < maxAgeMs) return cache.keys;
  try {
    const [members] = await run([["SMEMBERS", "rp:blocked"]], { config });
    cache = { at: now, keys: Array.isArray(members) ? members.filter((m) => PAIR_RE.test(m)) : [] };
  } catch {
    cache = { at: now, keys: cache.keys };
  }
  return cache.keys;
}
export const resetReportCache = () => (cache = { at: 0, keys: [] });

export async function notifyOwner({ pair, label, count, blocked }, env = process.env, doFetch = fetch) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.REPORT_CHAT_ID) return false;
  const [k, p] = pair.split("|");
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const text = [
    `🚩 <b>Wrong pair reported</b>${count ? ` (${count})` : ""}${blocked ? " · now hidden" : ""}`,
    esc(label || pair),
    `Kalshi: <code>${esc(k)}</code>`,
    `Polymarket: <code>${esc(p)}</code>`,
    `To block for good, add to BLOCKED in lib/pairs.js:`,
    `<code>{ kalshi: "${esc(k)}", polymarket: "${esc(p)}", why: "" },</code>`,
  ].join("\n");
  const res = await doFetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.REPORT_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  return res.ok;
}

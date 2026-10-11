// GET /g/KALSHI_TICKER/polymarket-slug  (rewritten to /api/share?k=…&p=…)
// A tiny page whose link preview is that gap's own image. People who open it are sent to the
// home page with that gap highlighted; link-preview crawlers read the tags and stop there.
import { loadPair, TICKER_RE, SLUG_RE } from "./gapimage.js";
import { query } from "../lib/respond.js";
import { buyPrice } from "../lib/match.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cents = (v) => Math.round(Number(v) * 100) + "¢";

export function sharePage({ origin, k, p, pair }) {
  const target = `/?gap=${encodeURIComponent(`${k}|${p}`)}#gaps`;
  const img = `${origin}/api/gapimage?k=${encodeURIComponent(k)}&p=${encodeURIComponent(p)}`;
  const title = pair ? `Same bet. Two prices. ${pair.question}` : "Oddly Radar · Same bet. Two prices.";
  const desc = pair
    ? `${cents(buyPrice(pair.kalshi))} on Kalshi, ${cents(buyPrice(pair.polymarket))} on Polymarket. Live price gaps on Oddly Radar.`
    : "Live price gaps between Kalshi and Polymarket.";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(pair ? img : origin + "/og.png")}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(pair ? img : origin + "/og.png")}">
<meta http-equiv="refresh" content="0;url=${esc(target)}">
<style>body{background:#0b0d12;color:#f1f2f5;font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}a{color:#2dd4bf}</style>
</head><body><p>Opening the gap on <a href="${esc(target)}">Oddly Radar</a>…</p>
<script>location.replace(${JSON.stringify(target)})</script>
</body></html>`;
}

export default async function handler(req, res) {
  const q = query(req);
  const k = (q.get("k") || "").trim();
  const p = (q.get("p") || "").trim().toLowerCase();
  const host = req.headers?.host && /^[a-z0-9.-]+(:\d+)?$/i.test(req.headers.host) ? req.headers.host : "oddly-radar.vercel.app";
  const proto = host.startsWith("localhost") ? "http" : "https";
  let pair = null;
  if (TICKER_RE.test(k) && SLUG_RE.test(p)) {
    try {
      pair = await loadPair(k, p);
    } catch {
      pair = null;
    }
  }
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "public, s-maxage=300, stale-while-revalidate=900");
  res.end(sharePage({ origin: `${proto}://${host}`, k: TICKER_RE.test(k) ? k : "", p: SLUG_RE.test(p) ? p : "", pair }));
}

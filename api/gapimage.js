// GET /api/gapimage?k=KALSHI_TICKER&p=polymarket-slug
// A 1200×630 PNG of one price gap, used as the link preview for shared gaps and for Telegram alerts.
// Prices are read live from both venues, so the image can't be made to show made-up numbers.
import { getKalshiMarket } from "../lib/kalshi.js";
import { getMarketBySlug } from "../lib/polymarket.js";
import { renderGapImage } from "../lib/ogimage.js";
import { query } from "../lib/respond.js";

export const TICKER_RE = /^[A-Za-z0-9._-]{2,80}$/;
export const SLUG_RE = /^[a-z0-9-]{2,200}$/;

export async function loadPair(k, p, { kalshi = getKalshiMarket, poly = getMarketBySlug } = {}) {
  if (!TICKER_RE.test(k) || !SLUG_RE.test(p)) return null;
  const [km, pm] = await Promise.all([kalshi(k.toUpperCase()), poly(p)]);
  if (!km || !pm || !(km.yes > 0) || !(pm.yes > 0)) return null;
  return { kalshi: km, polymarket: pm, question: pm.question || km.question };
}

export default async function handler(req, res) {
  const q = query(req);
  const k = q.get("k") || "";
  const p = q.get("p") || "";
  try {
    const pair = await loadPair(k, p);
    if (!pair) {
      // Unknown pair: fall back to the site's general preview image.
      res.statusCode = 302;
      res.setHeader("location", "/og.png");
      res.setHeader("cache-control", "public, s-maxage=300");
      res.end();
      return;
    }
    const host = req.headers?.host && /^[a-z0-9.-]+$/i.test(req.headers.host) ? req.headers.host : undefined;
    const png = renderGapImage({ question: pair.question, kalshiYes: pair.kalshi.yes, polyYes: pair.polymarket.yes, site: host });
    res.statusCode = 200;
    res.setHeader("content-type", "image/png");
    res.setHeader("cache-control", "public, s-maxage=300, stale-while-revalidate=900");
    res.end(png);
  } catch {
    res.statusCode = 302;
    res.setHeader("location", "/og.png");
    res.end();
  }
}

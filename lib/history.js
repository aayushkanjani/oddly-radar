// Gap history: a snapshot of every live gap every 10 minutes, kept for a week.
//
// Storage layout (Upstash Redis, see lib/store.js):
//   gh:b:{bucket}       marks a 10-minute bucket as recorded, so snapshots never double up
//   gh:s:{pair}         list of "time,gap,kalshi,polymarket" (cents), newest first, ~7 days
//   gh:d:{YYYY-MM-DD}   sorted set: each pair's widest gap that day (ZADD GT keeps the max)
//   gh:m:{pair}         the pair's label, links and picture, for the "widest this week" list
// A pair is "KALSHI_TICKER|polymarket-slug".

import { pipeline as defaultPipeline, storeConfig } from "./store.js";

export const BUCKET_MS = 10 * 60 * 1000;
const KEEP_POINTS = 6 * 24 * 7; // one week of 10-minute points
const DAY_TTL = 9 * 86400;
const MAX_PAIRS = 80;

export const pairId = (g) => `${g.kalshi.id}|${g.polymarket.id}`;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const bp = (m) => (m && Number(m.buy) > 0 ? m.buy : m && Number(m.ask) > 0 ? m.ask : m?.yes);
const c1 = (p) => Math.round(Number(p) * 1000) / 10; // cents with one decimal

export async function recordSnapshot(gaps, { now = Date.now(), pipeline = defaultPipeline } = {}) {
  const bucket = Math.floor(now / BUCKET_MS);
  const [claimed] = await pipeline([["SET", `gh:b:${bucket}`, "1", "NX", "EX", "1200"]]);
  if (claimed !== "OK") return { recorded: 0, skipped: true }; // this bucket is already stored
  const ts = Math.floor(now / 1000);
  const today = `gh:d:${day(now)}`;
  const cmds = [];
  for (const g of gaps.slice(0, MAX_PAIRS)) {
    const id = pairId(g);
    cmds.push(
      ["LPUSH", `gh:s:${id}`, `${ts},${c1(g.gap)},${c1(bp(g.kalshi))},${c1(bp(g.polymarket))}`],
      ["LTRIM", `gh:s:${id}`, "0", String(KEEP_POINTS - 1)],
      ["EXPIRE", `gh:s:${id}`, String(DAY_TTL)],
      ["ZADD", today, "GT", String(c1(g.gap)), id],
      [
        "SET", `gh:m:${id}`,
        JSON.stringify({
          label: g.label, verified: !!g.verified, match: g.match ?? null,
          kalshiUrl: g.kalshi.url, polymarketUrl: g.polymarket.url, image: g.polymarket.image || "",
        }),
        "EX", String(DAY_TTL),
      ],
    );
  }
  cmds.push(["EXPIRE", today, String(DAY_TTL)]);
  await pipeline(cmds);
  return { recorded: Math.min(gaps.length, MAX_PAIRS), skipped: false };
}

export function parsePoints(list) {
  return (list || [])
    .map((s) => String(s).split(",").map(Number))
    .filter((p) => p.length === 4 && p.every(Number.isFinite))
    .map(([t, gap, k, p]) => ({ t, gap, k, p }))
    .sort((a, b) => a.t - b.t);
}

// The last `hours` of points for each pair.
export async function readSeries(ids, { hours = 24, pipeline = defaultPipeline } = {}) {
  const n = Math.ceil((hours * 60) / 10);
  const res = await pipeline(ids.map((id) => ["LRANGE", `gh:s:${id}`, "0", String(n - 1)]));
  return Object.fromEntries(ids.map((id, i) => [id, parsePoints(res[i])]));
}

// The widest gaps of the last `days` days, each pair once, at its widest.
export async function readWidest({ days = 7, limit = 20, now = Date.now(), pipeline = defaultPipeline } = {}) {
  const dayKeys = Array.from({ length: days }, (_, i) => day(now - i * 86400e3));
  const res = await pipeline(dayKeys.map((d) => ["ZREVRANGE", `gh:d:${d}`, "0", "49", "WITHSCORES"]));
  const best = new Map();
  res.forEach((flat, i) => {
    for (let j = 0; j + 1 < (flat || []).length; j += 2) {
      const id = flat[j], score = Number(flat[j + 1]);
      if (!best.has(id) || score > best.get(id).maxGap) best.set(id, { id, maxGap: score, day: dayKeys[i] });
    }
  });
  const top = [...best.values()].sort((a, b) => b.maxGap - a.maxGap).slice(0, limit);
  const metas = await pipeline(top.map((t) => ["GET", `gh:m:${t.id}`]));
  return top.map((t, i) => {
    let meta = {};
    try {
      meta = JSON.parse(metas[i] || "{}");
    } catch {}
    return { ...t, ...meta };
  });
}

export const historyEnabled = (env = process.env) => !!storeConfig(env);

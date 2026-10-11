// Automatic matching of the same question on Kalshi and Polymarket.
//
// How it works:
//   1. Pull active markets from both venues (Polymarket's top markets by 24h volume, Kalshi's open
//      events with their markets; Kalshi's events endpoint already leaves out parlays).
//   2. Normalize each question: synonyms (Federal Reserve → fed, decrease → cut), numbers ($120k →
//      120000, 25 bps), month names. Common words count for little; rare words count for a lot.
//   3. A pair must agree on every number (strike prices, basis points, dates; a missing year is
//      allowed), must not point in opposite directions (above/below, cut/hike), and must close within
//      10 days of each other when both close dates are near.
//   4. Each market is used once: the best-scoring pairs win.
//
// Matching is approximate, so every pair carries a match score and both rule texts, and the site
// labels them "auto-matched". Hand-checked pairs in lib/pairs.js are shown as verified.

import { fetchJson, num, str } from "./http.js";
import { normalizeMarket } from "./polymarket.js";
import { kalshiUrl } from "./kalshi.js";
import { BLOCKED } from "./pairs.js";
import { reportedPairs } from "./reports.js";
import { recordSnapshot, historyEnabled } from "./history.js";
import { LEAGUES, kalshiGames, polyGames, matchGames } from "./sports.js";

const GAMMA_API = "https://gamma-api.polymarket.com";
const KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2";

export const MATCH_THRESHOLD = 0.55;

// ---------- text normalization ----------
const SYNONYMS = [
  [/\bfederal reserve\b/g, " fed "],
  [/\bfomc\b/g, " fed "],
  [/\b(decrease|decreases|decreased|lower|lowers|cuts|cutting)\b/g, " cut "],
  [/\b(increase|increases|increased|raise|raises|hikes|hiking)\b/g, " hike "],
  [/\bbasis points?\b/g, " bps "],
  [/\bunited states\b/g, " us "],
  [/\bu\.s\.a?\.?/g, " us "],
  [/\bbtc\b/g, " bitcoin "],
  [/\beth\b/g, " ethereum "],
  [/\bgreater than\b|\bmore than\b|\bhigher than\b|\bor more\b|\bor higher\b/g, " above "],
  [/\bless than\b|\blower than\b|\bor less\b|\bor lower\b/g, " below "],
  [/\bpresidential\b|\bpresidency\b/g, " president "],
  [/\bnominee\b/g, " nomination "],
  [/\bj\.\s?d\.?(?=\s)/g, " jd "],
  [/\bshut down\b/g, " shutdown "],
  // What a sports market measures. Everything that means "most goals" folds to "goal".
  [/\bgolden boot\b|\btop (goal ?)?scorer\b|\bleading (goal ?)?scorer\b|\bgoal ?scorer\b|\bpichichi\b/g, " goal "],
  [/\bmost valuable player\b/g, " mvp "],
  [/\bballon d['’]?or\b/g, " ballondor "],
  [/\bclean sheets?\b|\bgolden glove\b/g, " cleansheet "],
  [/\brelegat\w*/g, " relegated "],
  [/\bpromot\w*/g, " promoted "],
  [/\bhome runs?\b/g, " homerun "],
];
const MONTHS = { january: "jan", february: "feb", march: "mar", april: "apr", june: "jun", july: "jul", august: "aug", september: "sep", sept: "sep", october: "oct", november: "nov", december: "dec" };
const STOP = new Set(
  "will the a an of by at on in be to for before after their there is are any than or and what who which this that its his her he she it with from as do does did yes no market price end ever next".split(" "),
);
const OPPOSITES = [["above", "below"], ["over", "under"], ["cut", "hike"], ["win", "lose"]];

function canonNumber(raw, suffix) {
  let v = parseFloat(raw);
  if (!Number.isFinite(v)) return null;
  const s = (suffix || "").toLowerCase();
  if (s === "k") v *= 1e3;
  else if (s === "m" || s === "mm") v *= 1e6;
  else if (s === "b" || s === "bn") v *= 1e9;
  return String(Math.round(v * 1000) / 1000);
}

export function tokenize(text) {
  let s = ` ${String(text || "").toLowerCase()} `;
  s = s.replace(/(\d),(?=\d{3}\b)/g, "$1"); // 120,000 → 120000
  // Comparison qualifiers change the contract: ">25bps" is not "25bps". Keep them as words.
  s = s.replace(/>=|≥|\bat least\b|\bno less than\b/g, " atleast ");
  s = s.replace(/<=|≤|\bat most\b|\bno more than\b/g, " atmost ");
  s = s.replace(/>/g, " above ").replace(/</g, " below ");
  for (const [re, rep] of SYNONYMS) s = s.replace(re, rep);
  const nums = new Set();
  // Units are checked before multipliers so "25bps" reads as 25 + bps, not 25 billion + "ps".
  s = s.replace(/\$?(\d+(?:\.\d+)?)\s*(?:(bps|%|pct|percent)|(k|mm|m|bn|b)(?![a-z]))?/g, (_, n, unit, mult) => {
    const c = canonNumber(n, mult);
    if (c != null) nums.add(c);
    return unit ? ` ${unit === "bps" ? "bps" : "pct"} ` : " ";
  });
  const words = new Set();
  for (let w of s.split(/[^a-z]+/)) {
    if (!w || w.length < 2 || STOP.has(w)) continue;
    w = MONTHS[w] || w;
    if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1); // crude plural fold
    words.add(w);
  }
  return { words, nums };
}

const isYear = (n) => /^\d{4}$/.test(n) && +n >= 2000 && +n <= 2100;

// Numbers must agree. A year present on only one side is allowed ("Dec 31" vs "Dec 31, 2026").
export function numbersAgree(a, b) {
  const onlyA = [...a].filter((n) => !b.has(n));
  const onlyB = [...b].filter((n) => !a.has(n));
  return onlyA.every(isYear) && onlyB.every(isYear) && onlyA.length + onlyB.length <= 1;
}

// Names, places and organizations: the capitalized words of a question, normalized like everything
// else. Two questions that each name something the other doesn't (Texas vs California, two different
// candidates) are about different things, however similar the rest of the wording is.
const ENTITY_SKIP = new Set(["will", "the", "who", "what", "which", "when", "how", "is", "are", "yes", "no", "a", "an", "in", "on", "by", "at", "of", "if", "does", "do"]);
export function entities(text) {
  const caps = (String(text || "").match(/\b[A-Z][A-Za-z.'’-]*/g) || []).filter((w) => !ENTITY_SKIP.has(w.toLowerCase()));
  return tokenize(caps.join(" ")).words;
}
export function entitiesConflict(a, b) {
  const onlyA = [...a].some((w) => !b.has(w));
  const onlyB = [...b].some((w) => !a.has(w));
  return onlyA && onlyB;
}

// A question that names a year can't match a market on the other venue that closes years away from it.
function yearConflict(numsA, numsB, endB) {
  const years = [...numsA].filter(isYear).map(Number);
  if (!years.length || [...numsB].some(isYear)) return false;
  const yb = new Date(Date.parse(endB)).getUTCFullYear();
  if (!Number.isFinite(yb) || yb > 2090) return false;
  return years.every((y) => Math.abs(y - yb) > 1);
}

function opposite(a, b) {
  return OPPOSITES.some(([x, y]) => (a.has(x) && !a.has(y) && b.has(y) && !b.has(x)) || (a.has(y) && !a.has(x) && b.has(x) && !b.has(y)));
}

// Words that change what a question is about. If one side has one and the other doesn't, they're
// different contracts: "Vice President nominee" vs "presidential nomination", a two-person "ticket"
// vs one person's nomination, a state "primary" vs the national nomination, "election" vs "nomination".
const CONTEXT = new Set([
  "vice", "ticket", "primary", "runoff", "caucu", "election", "nomination", "governor", "senate", "house", "mayor",
  "electoral", "popular", "margin", "turnout", "approval", "debate", "impeach", "resign", "indict", "convict", "pardon",
  // What a sports market measures: "most assists" and "most goals" are different contracts.
  "goal", "assist", "rebound", "touchdown", "yard", "strikeout", "homerun", "mvp", "ballondor", "cleansheet",
  "relegated", "promoted", "rookie",
  // Comparisons: "hike more than 25bps" is not "hike 25bps"; "above $120k" is not "reach $120k".
  "above", "below", "atleast", "atmost",
  // "Impeached and removed" is not "impeached".
  "removed", "remove", "convicted",
  // "Third-most seats" is not "most seats".
  "second", "third", "fourth", "fifth", "runnerup",
]);
export function contextConflict(a, b) {
  for (const w of CONTEXT) if (a.has(w) !== b.has(w)) return true;
  return false;
}

// ---------- market lists ----------
// A price both venues would trade at right now: the middle of a live bid and ask no more than 10¢ apart.
// No fallback to the last trade: on quiet markets it can be weeks old, or even outside today's bid and ask.
export const MAX_SPREAD = 0.1;
export const MAX_AUTO_GAP = 0.3;
function kalshiYes(m) {
  const bid = num(m.yes_bid_dollars, NaN);
  const ask = num(m.yes_ask_dollars, NaN);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > bid && ask - bid <= MAX_SPREAD + 1e-9) return { yes: (bid + ask) / 2, bid, ask };
  return null;
}

// One Kalshi market → one candidate. Used for markets nested in events and for the flat /markets list.
export function toKalshiCandidate(m, ev = {}) {
  if (m.status && !["active", "open"].includes(String(m.status).toLowerCase())) return null;
  if (m.mve_collection_ticker) return null; // parlays
  if (/^KX[A-Z]+GAME-/.test(String(m.event_ticker || ""))) return null; // games are matched by teams and date in lib/sports.js
  const p = kalshiYes(m);
  if (!p) return null;
  const title = str(m.title) || str(ev.title);
  const sub = str(m.yes_sub_title);
  const text = sub && !title.toLowerCase().includes(sub.toLowerCase()) ? `${title} ${sub}` : title;
  return {
    venue: "Kalshi",
    id: str(m.ticker),
    question: text,
    yes: p.yes, bid: p.bid, ask: p.ask,
    volume24h: num(m.volume_24h_fp),
    endDate: str(m.close_time),
    // Kalshi's full resolution rules are the primary text plus any secondary text.
    rules: [str(m.rules_primary), str(m.rules_secondary)].filter(Boolean).join("\n\n"),
    url: kalshiUrl(m.event_ticker || ev.event_ticker, ev.series_ticker || m.series_ticker, ev.title || title),
  };
}

export function kalshiCandidates(events, markets = []) {
  const byId = new Map();
  for (const ev of events) for (const m of ev.markets || []) {
    const c = toKalshiCandidate(m, ev);
    if (c && !byId.has(c.id)) byId.set(c.id, c);
  }
  for (const m of markets) {
    const c = toKalshiCandidate(m);
    if (c && !byId.has(c.id)) byId.set(c.id, c);
  }
  return [...byId.values()];
}

export function polymarketCandidates(rows) {
  const out = [];
  for (const r of rows) {
    let outcomes = r.outcomes;
    try {
      if (typeof outcomes === "string") outcomes = JSON.parse(outcomes);
    } catch {
      outcomes = [];
    }
    if (!Array.isArray(outcomes) || !outcomes.some((o) => String(o).toLowerCase() === "yes")) continue; // binary Yes/No only
    const m = normalizeMarket(r);
    if (!m.question || !(m.yes > 0)) continue;
    if (m.bid == null || m.ask == null || m.ask - m.bid > MAX_SPREAD + 1e-9) continue; // no live, tight book
    out.push({ ...m, url: r.slug ? `https://polymarket.com/market/${r.slug}` : m.url });
  }
  return out;
}

// ---------- matching ----------
// `blocked` holds "kalshiTicker|polymarketSlug" keys for pairs a person has marked as wrong.
export const pairKey = (kalshiId, polyId) => `${String(kalshiId).toUpperCase()}|${String(polyId).toLowerCase()}`;

export function matchMarkets(kalshi, poly, { threshold = MATCH_THRESHOLD, now = Date.now(), nearMissFloor = null, blocked = new Set() } = {}) {
  const K = kalshi.map((m) => ({ m, t: tokenize(m.question), e: entities(m.question) }));
  const P = poly.map((m) => ({ m, t: tokenize(m.question), e: entities(m.question) }));
  const df = new Map();
  for (const d of [...K, ...P]) for (const w of d.t.words) df.set(w, (df.get(w) || 0) + 1);
  const N = K.length + P.length || 1;
  const idf = (w) => Math.log(1 + N / (df.get(w) || 1));

  const index = new Map();
  P.forEach((d, i) => {
    for (const w of d.t.words) {
      if (!index.has(w)) index.set(w, []);
      index.get(w).push(i);
    }
  });

  const daysAway = (iso) => (Date.parse(iso) - now) / 86400e3;

  const scored = [];
  const misses = [];
  K.forEach((k, ki) => {
    const rare = [...k.t.words].sort((a, b) => idf(b) - idf(a)).slice(0, 4);
    const cand = new Set(rare.flatMap((w) => index.get(w) || []));
    for (const pi of cand) {
      const p = P[pi];
      if (blocked.size && blocked.has(pairKey(k.m.id, p.m.id))) continue;
      if (opposite(k.t.words, p.t.words)) continue;
      if (entitiesConflict(k.e, p.e)) continue;
      if (contextConflict(k.t.words, p.t.words)) continue;
      if (yearConflict(k.t.nums, p.t.nums, p.m.endDate) || yearConflict(p.t.nums, k.t.nums, k.m.endDate)) continue;
      const kHasNum = [...k.t.nums].some((n) => !isYear(n));
      const pHasNum = [...p.t.nums].some((n) => !isYear(n));
      if (kHasNum !== pHasNum) continue;
      if (!numbersAgree(k.t.nums, p.t.nums)) continue;
      let inter = 0, union = 0;
      const all = new Set([...k.t.words, ...p.t.words]);
      for (const w of all) {
        const wt = idf(w);
        union += wt;
        if (k.t.words.has(w) && p.t.words.has(w)) inter += wt;
      }
      let score = union ? inter / union : 0;
      if (kHasNum) score = Math.min(1, score + 0.1); // agreeing strike prices are strong evidence
      // Close dates: both soon → must be within 10 days. One soon and one years away → very likely
      // different contests (e.g. the 2026 vs the 2028 race). Placeholder dates (2099, 2070) are ignored.
      const dk = daysAway(k.m.endDate), dp = daysAway(p.m.endDate);
      if (Number.isFinite(dk) && Number.isFinite(dp)) {
        const nearK = dk < 540, nearP = dp < 540;
        const placeholder = (d) => d > 5 * 365;
        // Venues often set different deadlines for the same question (Kalshi's "next presidential
        // election" closes a year after Polymarket's 2028 one), but more than ~13 months apart is a different contest.
        if (!placeholder(dk) && !placeholder(dp) && Math.abs(dk - dp) > 400) continue;
        if (nearK && nearP) {
          if (Math.abs(dk - dp) > 10) score *= 0.5;
        } else if (nearK !== nearP && !placeholder(dk) && !placeholder(dp)) {
          score *= 0.4;
        }
      }
      if (score >= threshold) scored.push({ ki, pi, score });
      else if (nearMissFloor != null && score >= nearMissFloor) misses.push({ kalshi: k.m.question, polymarket: p.m.question, score: +score.toFixed(3) });
    }
  });

  scored.sort((a, b) => b.score - a.score);
  const usedK = new Set(), usedP = new Set(), pairs = [];
  for (const s of scored) {
    if (usedK.has(s.ki) || usedP.has(s.pi)) continue;
    usedK.add(s.ki);
    usedP.add(s.pi);
    pairs.push({ kalshi: K[s.ki].m, polymarket: P[s.pi].m, match: +s.score.toFixed(3) });
  }
  misses.sort((a, b) => b.score - a.score);
  return { pairs, nearMisses: misses.slice(0, 30) };
}

// What it costs to hold YES on the cheaper venue and NO on the other, using asks where we have them.
// One side pays $1 at resolution (if the rules truly match), so 1 − cost is the locked-in edge before fees.
// The price to buy YES right now (the best ask), which is what each venue's app shows on its Yes button.
// Falls back to the mid only for hand-verified pairs on markets without a live ask.
export const buyPrice = (m) => (Number.isFinite(m?.ask) && m.ask > 0 ? m.ask : m?.yes);

export function lockIn(kalshi, poly) {
  const cheapIsK = buyPrice(kalshi) <= buyPrice(poly);
  const cheap = cheapIsK ? kalshi : poly;
  const dear = cheapIsK ? poly : kalshi;
  const yesCost = cheap.ask ?? cheap.yes;
  const noCost = 1 - (dear.bid ?? dear.yes);
  const cost = yesCost + noCost;
  return { cheaper: cheap.venue, yesCost, noCost, cost, edge: 1 - cost };
}

export function toGap(pair, extra = {}, now = Date.now()) {
  const kalshi = { ...pair.kalshi, buy: buyPrice(pair.kalshi) };
  const polymarket = { ...pair.polymarket, buy: buyPrice(pair.polymarket) };
  const li = lockIn(kalshi, polymarket);
  const kDate = Date.parse(kalshi.endDate), pDate = Date.parse(polymarket.endDate);
  const days = Number.isFinite(kDate) && Number.isFinite(pDate) ? Math.abs(kDate - pDate) / 86400e3 : 0;
  // Only warn when both markets close within a year and their deadlines differ by more than two weeks:
  // then one can resolve while the other is still open. Long-dated differences are normal; the card
  // shows both close dates instead.
  const soon = (t) => Number.isFinite(t) && t - now < 365 * 86400e3;
  const warn = soon(kDate) && soon(pDate) && days > 14;
  return {
    label: polymarket.question || kalshi.question,
    kalshi, polymarket,
    // Compare what you'd pay for YES on each venue, as their apps show it.
    gap: Math.abs(kalshi.buy - polymarket.buy),
    cheaper: li.cheaper,
    lockIn: li,
    match: pair.match ?? 1,
    verified: false,
    closeDaysApart: Math.round(days),
    ruleNote: warn ? `Deadlines differ by ${Math.round(days)} days: one market can resolve while the other is still open.` : "",
    ...extra,
  };
}

// ---------- fetching (cached while the function instance stays warm) ----------
const CACHE_MS = 10 * 60 * 1000;
let cached = null;
let building = null;

// Polymarket: its markets list refuses deep paging (offset 2,400 fails), which capped us near 2,000.
// Its events list pages much deeper and nests every market of each event, so read both, within a time
// budget, and merge by market id.
async function pagesInParallel(urls, { batch = 8, budgetMs, started, take }) {
  for (let i = 0; i < urls.length && Date.now() - started < budgetMs; i += batch) {
    const res = await Promise.allSettled(urls.slice(i, i + batch).map((u) => fetchJson(u, { timeoutMs: 8000 })));
    let got = 0;
    for (const r of res) if (r.status === "fulfilled" && Array.isArray(r.value)) got += take(r.value);
    if (!got) break; // past the last page
  }
}

async function fetchPolymarket({ marketPages = 20, eventPages = 60, budgetMs = 14000 } = {}) {
  const started = Date.now();
  const byId = new Map();
  const add = (row, ev) => {
    if (!row || row.closed === true || row.active === false) return;
    const id = row.id || row.conditionId || row.slug;
    if (!id || byId.has(id)) return;
    if (!ev) return byId.set(id, row);
    // Markets nested in an event can lack their own picture; fall back to the event's.
    byId.set(id, { ...row, eventSlug: row.eventSlug || ev.slug, image: row.image || row.icon || ev.image || ev.icon });
  };
  const q = "active=true&closed=false&order=volume24hr&ascending=false";
  await Promise.all([
    pagesInParallel(
      Array.from({ length: marketPages }, (_, i) => `${GAMMA_API}/markets?${q}&limit=100&offset=${i * 100}`),
      { budgetMs, started, take: (rows) => (rows.forEach((r) => add(r)), rows.length) },
    ),
    pagesInParallel(
      Array.from({ length: eventPages }, (_, i) => `${GAMMA_API}/events?${q}&limit=50&offset=${i * 50}`),
      { budgetMs, started, take: (evs) => (evs.forEach((ev) => (ev.markets || []).forEach((m) => add(m, ev))), evs.length) },
    ),
  ]);
  if (!byId.size) throw new Error("Polymarket markets unavailable");
  return [...byId.values()];
}

// Kalshi, part 1: open events with their markets (parlays already excluded). Skews long-dated.
async function fetchKalshiEvents({ maxPages = 15, budgetMs = 9000 } = {}) {
  const started = Date.now();
  const events = [];
  let cursor = "";
  for (let i = 0; i < maxPages && Date.now() - started < budgetMs; i++) {
    const body = await fetchJson(`${KALSHI_API}/events?status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { timeoutMs: 6000 });
    events.push(...(body?.events || []));
    cursor = body?.cursor || "";
    if (!cursor) break;
  }
  return events;
}

// Kalshi, part 2: every non-parlay market closing in the next `days` days, across all categories.
// These are the near-term questions that overlap most with Polymarket's busiest markets.
async function fetchKalshiNearTerm({ days = 75, maxPages = 10, budgetMs = 9000 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const base = `${KALSHI_API}/markets?mve_filter=exclude&min_close_ts=${now}&max_close_ts=${now + days * 86400}&limit=1000`;
  const started = Date.now();
  const markets = [];
  let cursor = "";
  for (let i = 0; i < maxPages && Date.now() - started < budgetMs; i++) {
    const body = await fetchJson(base + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""), { timeoutMs: 6000 });
    markets.push(...(body?.markets || []));
    cursor = body?.cursor || "";
    if (!cursor) break;
  }
  return markets;
}

// Sports: each league's open Kalshi game markets, and Polymarket's moneyline game markets.
async function fetchKalshiGames() {
  const res = await Promise.allSettled(
    Object.keys(LEAGUES).map((series) => fetchJson(`${KALSHI_API}/markets?series_ticker=${series}&status=open&limit=1000`, { timeoutMs: 7000 })),
  );
  return res.flatMap((r) => (r.status === "fulfilled" ? r.value?.markets || [] : []));
}
async function fetchPolyGames({ pages = 5 } = {}) {
  const res = await Promise.allSettled(
    Array.from({ length: pages }, (_, i) =>
      fetchJson(`${GAMMA_API}/markets?sports_market_types=moneyline&active=true&closed=false&limit=100&offset=${i * 100}&order=volume24hr&ascending=false`, { timeoutMs: 8000 }),
    ),
  );
  return res.flatMap((r) => (r.status === "fulfilled" && Array.isArray(r.value) ? r.value : []));
}

export async function getAutoGaps({ minPolyVolume = 1, debug = false } = {}) {
  if (!debug && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  if (!debug && building) return building;
  const run = (async () => {
    const [polyR, eventsR, nearR, kGamesR, pGamesR] = await Promise.allSettled([fetchPolymarket(), fetchKalshiEvents(), fetchKalshiNearTerm(), fetchKalshiGames(), fetchPolyGames()]);
    if (polyR.status === "rejected") throw polyR.reason;
    const events = eventsR.status === "fulfilled" ? eventsR.value : [];
    const nearTerm = nearR.status === "fulfilled" ? nearR.value : [];
    if (!events.length && !nearTerm.length) throw new Error("Kalshi markets unavailable");

    // Keep any Polymarket market with some trading or a live order book.
    const poly = polymarketCandidates(polyR.value).filter((m) => m.volume24h >= minPolyVolume || (m.bid != null && m.ask != null));
    const kalshi = kalshiCandidates(events, nearTerm);
    // Hand-blocked pairs, plus pairs that enough visitors reported as wrong (lib/reports.js).
    const reported = await reportedPairs().catch(() => []);
    const blocked = new Set([...BLOCKED.map((b) => pairKey(b.kalshi, b.polymarket)), ...reported]);
    const { pairs, nearMisses } = matchMarkets(kalshi, poly, { nearMissFloor: debug ? 0.3 : null, blocked });
    // Games: matched by league, date and teams (lib/sports.js), from the main lists plus the game lists.
    const kGameRows = [...nearTerm, ...(kGamesR.status === "fulfilled" ? kGamesR.value : [])];
    const pGameRows = [...polyR.value, ...(pGamesR.status === "fulfilled" ? pGamesR.value : [])];
    const gameGaps = matchGames(kalshiGames(kGameRows), polyGames(pGameRows))
      .filter((g) => !blocked.has(pairKey(g.kalshi.id, g.polymarket.id)))
      .map((g) => {
        const gap = toGap(g, { label: g.label, kind: "game", league: g.league, gameDate: g.gameDate });
        if (g.tieNote) gap.ruleNote = g.tieNote;
        return gap;
      });
    const allGaps = [...pairs.map((p) => toGap(p)), ...gameGaps]
      .filter((g) => g.kalshi.yes > 0.02 && g.kalshi.yes < 0.98 && g.polymarket.yes > 0.02 && g.polymarket.yes < 0.98)
      .sort((a, b) => b.gap - a.gap);
    // On two live, tight books, an automatic match more than 30¢ apart is almost always two different
    // questions. Leave those out rather than headline them.
    const gaps = allGaps.filter((g) => g.verified || g.gap <= MAX_AUTO_GAP);
    const hiddenWide = allGaps.length - gaps.length;
    const value = {
      gaps,
      scanned: { kalshi: kalshi.length, polymarket: poly.length, polymarketRaw: polyR.value.length, kalshiNearTerm: nearTerm.length, games: gameGaps.length, hiddenWide },
      ...(debug ? { nearMisses, sourceErrors: { kalshiEvents: eventsR.reason?.message, kalshiNearTerm: nearR.reason?.message } } : {}),
    };
    if (!debug) {
      cached = { at: Date.now(), value };
      // Gap history (optional): one snapshot per 10 minutes; never let storage trouble break the page.
      if (historyEnabled()) await recordSnapshot(gaps).catch((err) => console.warn("history:", err.message));
    }
    return value;
  })();
  if (!debug) building = run.finally(() => (building = null));
  return run;
}

// Sports games: matched by league, date and the two teams, not by wording.
//
// Formats, checked against live data on 2026-10-12:
//   Kalshi:     series KXNFLGAME / KXMLBGAME / KXNHLGAME …; event "KXMLBGAME-26OCT161800TBCLE"
//               (yy, month, day, optional HHMM start, team codes run together); one market per team,
//               "KXMLBGAME-26OCT161800TBCLE-TB" titled "Tampa Bay wins" (Yes = that team wins).
//               close_time is days after the game, so the date comes from the code.
//   Polymarket: moneyline markets with slug "mlb-sd-mil-2026-10-03", question "Padres vs. Brewers",
//               outcomes ["San Diego Padres", "Milwaukee Brewers"] in the slug's team order;
//               bestBid / bestAsk are for the first outcome.
// Team order can differ between venues, so games match on the unordered pair of codes.

import { num, str } from "./http.js";
import { kalshiUrl } from "./kalshi.js";

// Kalshi series → Polymarket slug prefix.
export const LEAGUES = {
  KXNFLGAME: "nfl",
  KXMLBGAME: "mlb",
  KXNHLGAME: "nhl",
  KXNBAGAME: "nba",
  KXWNBAGAME: "wnba",
  KXNCAAFGAME: "cfb",
};

// Where the two venues' team codes might differ. Codes that are equal match without an entry.
// Aliases only ever join two spellings of the same team.
const ALIASES = {
  nfl: [["la", "lar"], ["wsh", "was"], ["jac", "jax"], ["lv", "lvr"]],
  mlb: [["cws", "chw"], ["kc", "kcr"], ["sd", "sdp"], ["sf", "sfg"], ["tb", "tbr"], ["wsh", "was"], ["az", "ari"], ["ath", "oak"]],
  nhl: [["la", "lak"], ["sj", "sjs"], ["tb", "tbl"], ["nj", "njd"], ["mon", "mtl"], ["wsh", "was"]],
  nba: [["gs", "gsw"], ["ny", "nyk"], ["sa", "sas"], ["no", "nop"], ["utah", "uta"], ["phx", "pho"], ["bkn", "bk"], ["wsh", "was"]],
  wnba: [["gs", "gsv"], ["ny", "nyl"], ["la", "las"], ["lv", "lva"], ["wsh", "was"]],
  cfb: [],
};
export function canonTeam(league, code) {
  const c = String(code || "").toLowerCase();
  for (const [a, b] of ALIASES[league] || []) if (c === a || c === b) return a;
  return c;
}
const pairKeyOf = (league, a, b) => [canonTeam(league, a), canonTeam(league, b)].sort().join("+");

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
// "KXMLBGAME-26OCT161800TBCLE" → { series, date: "2026-10-16", codes: "TBCLE" }
export function parseKalshiGameEvent(eventTicker) {
  const m = String(eventTicker || "").match(/^(KX[A-Z]+GAME)-(\d{2})([A-Z]{3})(\d{2})(\d{4})?([A-Z]+)$/);
  if (!m || !MONTHS[m[3]]) return null;
  const date = `20${m[2]}-${String(MONTHS[m[3]]).padStart(2, "0")}-${m[4]}`;
  return { series: m[1], date, time: m[5] || "", codes: m[6] };
}

// "mlb-sd-mil-2026-10-03" → { league: "mlb", teams: ["sd", "mil"], date: "2026-10-03" }
export function parsePolyGameSlug(slug) {
  const m = String(slug || "").match(/^([a-z0-9]+)-([a-z0-9]+)-([a-z0-9]+)-(\d{4}-\d{2}-\d{2})$/);
  return m ? { league: m[1], teams: [m[2], m[3]], date: m[4] } : null;
}

function parseList(v) {
  if (Array.isArray(v)) return v;
  try {
    const x = JSON.parse(v);
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
}

// Kalshi markets → games: { league, date, key, teams: { code: market } }.
export function kalshiGames(markets) {
  const games = new Map();
  for (const m of markets) {
    const ev = parseKalshiGameEvent(m.event_ticker);
    if (!ev || !LEAGUES[ev.series]) continue;
    if (m.status && !["active", "open"].includes(String(m.status).toLowerCase())) continue;
    const code = String(m.ticker || "").split("-").pop();
    if (!code || !ev.codes.includes(code)) continue;
    const bid = num(m.yes_bid_dollars, NaN), ask = num(m.yes_ask_dollars, NaN), last = num(m.last_price_dollars, NaN);
    const hasBook = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > bid;
    const yes = hasBook ? (bid + ask) / 2 : last > 0 ? last : null;
    if (yes == null) continue;
    const id = String(m.event_ticker);
    if (!games.has(id)) games.set(id, { id, league: LEAGUES[ev.series], date: ev.date, time: ev.time, teams: {} });
    games.get(id).teams[code.toLowerCase()] = {
      venue: "Kalshi",
      id: str(m.ticker),
      question: str(m.title) || `${str(m.yes_sub_title)} wins`,
      team: str(m.yes_sub_title),
      yes, bid: hasBook ? bid : null, ask: hasBook ? ask : null,
      endDate: str(m.close_time),
      rules: [str(m.rules_primary), str(m.rules_secondary)].filter(Boolean).join("\n\n"),
      url: kalshiUrl(m.event_ticker, ev.series, `${str(m.yes_sub_title)} game`),
    };
  }
  return [...games.values()].filter((g) => Object.keys(g.teams).length === 2);
}

// Polymarket rows → two-team moneyline games.
export function polyGames(rows) {
  const out = [];
  for (const r of rows) {
    if (r.closed === true || r.active === false) continue;
    if (r.sportsMarketType && r.sportsMarketType !== "moneyline") continue;
    const g = parsePolyGameSlug(r.slug);
    if (!g || !Object.values(LEAGUES).includes(g.league)) continue;
    const outcomes = parseList(r.outcomes);
    const prices = parseList(r.outcomePrices).map((p) => num(p, NaN));
    if (outcomes.length !== 2 || outcomes.some((o) => /^(yes|no)$/i.test(o))) continue;
    const bid = num(r.bestBid, NaN), ask = num(r.bestAsk, NaN);
    const hasBook = Number.isFinite(bid) && Number.isFinite(ask) && ask > 0 && ask >= bid;
    const p0 = hasBook ? (bid + ask) / 2 : prices[0];
    if (!(p0 > 0 && p0 < 1)) continue;
    const eventSlug = r.eventSlug || r.events?.[0]?.slug || r.slug;
    out.push({
      ...g,
      slug: str(r.slug),
      question: str(r.question),
      outcomes,
      p0, bid0: hasBook ? bid : null, ask0: hasBook ? ask : null,
      endDate: str(r.endDate),
      rules: str(r.description),
      image: /^https:\/\//.test(str(r.image || r.icon)) ? str(r.image || r.icon) : "",
      url: `https://polymarket.com/event/${eventSlug}`,
    });
  }
  return out;
}

const dayDiff = (a, b) => Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / 86400e3);

// Pairs games; one gap per game, priced on Polymarket's first-listed team.
export function matchGames(kGames, pGames) {
  const byKey = new Map();
  for (const k of kGames) {
    const [a, b] = Object.keys(k.teams);
    const key = `${k.league}|${pairKeyOf(k.league, a, b)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(k);
  }
  const gaps = [];
  const used = new Set();
  for (const p of pGames) {
    const cands = byKey.get(`${p.league}|${pairKeyOf(p.league, ...p.teams)}`) || [];
    // Same date first; a one-day difference (time zones) only when it's the only candidate.
    const exact = cands.filter((k) => k.date === p.date && !used.has(k.id));
    const near = cands.filter((k) => dayDiff(k.date, p.date) === 1 && !used.has(k.id));
    const pick = exact.length === 1 ? exact[0] : exact.length === 0 && near.length === 1 ? near[0] : null;
    if (!pick) continue; // none, or ambiguous (e.g. a doubleheader): skip rather than guess
    used.add(pick.id);
    const firstCode = Object.keys(pick.teams).find((c) => canonTeam(p.league, c) === canonTeam(p.league, p.teams[0]));
    const k = pick.teams[firstCode];
    if (!k) continue;
    const team = p.outcomes[0];
    gaps.push({
      kind: "game",
      label: `${p.question} · ${team} to win`,
      kalshi: { ...k },
      polymarket: {
        venue: "Polymarket", id: p.slug, question: `${p.question}: ${team}`, yes: p.p0, bid: p.bid0, ask: p.ask0,
        endDate: p.endDate, rules: p.rules, url: p.url, image: p.image,
      },
      match: 0.95,
      league: p.league,
      gameDate: p.date,
      // NFL games can end in a tie; the venues may settle a tie differently.
      tieNote: p.league === "nfl" ? "NFL games can end in a tie, and the two venues may settle a tie differently. Check both rules." : "",
    });
  }
  return gaps;
}

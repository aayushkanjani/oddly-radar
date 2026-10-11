// Hand-matched markets that ask the same question on both venues.
//
// Automatic matching by title is unreliable, so you curate this list.
// To add a pair:
//   1. Polymarket: open the market, copy the slug from the URL (polymarket.com/market/<slug>).
//   2. Kalshi: open the market and copy its ticker (shown on the market page and in the URL).
//   3. Read both rule sets. If they resolve differently (different source, time zone or definition),
//      write one plain sentence in `ruleNote`; the site shows it as a warning.
//
// Pairs whose market can't be found are skipped, so a typo never breaks the page.

export const PAIRS = [
  // {
  //   label: "Fed cuts rates at the December meeting",
  //   category: "Macro",
  //   polymarket: "fed-decreases-interest-rates-by-25-bps-after-december-2026-meeting",
  //   kalshi: "KXFEDDECISION-26DEC-C25",
  //   ruleNote: "",
  // },
];

// Automatic pairs that are wrong (two different questions). The matcher skips these and looks for
// a better partner instead. Each gap's "Report" link opens a GitHub issue with both IDs filled in:
// copy them here, commit, and the pair is gone on the next refresh.
//   kalshi:     the Kalshi market ticker, e.g. "KXLALIGAGOALS-27-LYAM"
//   polymarket: the Polymarket market slug, e.g. "will-lamine-yamal-record-the-most-assists-in-2026-27-la-liga"
export const BLOCKED = [
  // { kalshi: "TICKER", polymarket: "slug", why: "assists vs goals" },
];

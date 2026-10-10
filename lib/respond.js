// Helpers for the serverless functions in /api.
// They only use plain Node response methods, so the same handlers run on Vercel
// and in the local dev server (scripts/dev-server.js).

export function query(req) {
  return new URL(req.url, "http://localhost").searchParams;
}

export function send(res, status, body, { cacheSeconds = 0 } = {}) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  if (cacheSeconds > 0 && status === 200) {
    // Vercel's edge cache serves repeat requests, so the venues see one call per window.
    res.setHeader("cache-control", `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 5}`);
  } else {
    res.setHeader("cache-control", "no-store");
  }
  res.end(JSON.stringify(body));
}

export function fail(res, err) {
  const status = err?.status && err.status >= 400 && err.status < 600 ? 502 : 500;
  send(res, status, { error: "Data source unavailable. Try again in a minute.", detail: String(err?.message ?? err) });
}

export function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

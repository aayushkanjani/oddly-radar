// POST /api/report  {"pair":"KALSHI_TICKER|polymarket-slug","label":"…"}
// A visitor says an automatic pair is two different questions. See lib/reports.js.
import { recordReport, notifyOwner, PAIR_RE } from "../lib/reports.js";
import { send } from "../lib/respond.js";

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4000) throw new Error("too large");
  }
  return JSON.parse(raw || "{}");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    send(res, 405, { error: "Use POST." });
    return;
  }
  let body;
  try {
    body = await readBody(req);
  } catch {
    send(res, 400, { error: "Send JSON." });
    return;
  }
  const pair = String(body?.pair || "");
  if (!PAIR_RE.test(pair)) {
    send(res, 400, { error: "Unknown pair." });
    return;
  }
  const label = String(body?.label || "").slice(0, 200);
  const ip = String(req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  let result = { stored: false, count: 0, blocked: false };
  try {
    result = await recordReport({ pair, ip, label });
  } catch (err) {
    console.warn("report storage:", err.message);
  }
  // Always visible in the Vercel logs, even without storage or Telegram.
  console.log(`report: ${pair} (${result.count || "?"}) ${label}`);
  try {
    await notifyOwner({ pair, label, ...result });
  } catch (err) {
    console.warn("report notify:", err.message);
  }
  send(res, 200, { ok: true, hidden: result.blocked });
}

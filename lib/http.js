// Small fetch helper shared by the API functions and the Telegram bot.
// Uses Node's built-in fetch (Node 20+), so the project has no dependencies.

export class UpstreamError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

export async function fetchJson(url, { timeoutMs = 8000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "oddly-radar/0.1", ...headers },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new UpstreamError(`${new URL(url).host} answered ${res.status}`, res.status);
    }
    return await res.json();
  } catch (err) {
    if (err.name === "AbortError") {
      throw new UpstreamError(`${new URL(url).host} took longer than ${timeoutMs}ms`, 504);
    }
    if (err instanceof UpstreamError) throw err;
    // DNS failures, refused connections and the like: the source is unreachable.
    throw new UpstreamError(`${new URL(url).host} could not be reached`, 502);
  } finally {
    clearTimeout(timer);
  }
}

export function num(value, fallback = 0) {
  const n = typeof value === "string" ? parseFloat(value) : value;
  return Number.isFinite(n) ? n : fallback;
}

export function str(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

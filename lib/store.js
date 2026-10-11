// Optional storage: an Upstash Redis database over its REST API (free tier is enough).
// Turned on by two environment variables, under either naming Upstash uses:
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, or KV_REST_API_URL + KV_REST_API_TOKEN.
// Without them, everything that needs storage (gap history) quietly switches off.

export function storeConfig(env = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || "";
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || "";
  return /^https:\/\//.test(url) && token ? { url: url.replace(/\/$/, ""), token } : null;
}

// Runs several commands in one request. Returns each command's result (null where it failed).
export async function pipeline(commands, { config = storeConfig(), timeoutMs = 5000 } = {}) {
  if (!config) throw new Error("Storage isn't set up");
  if (!commands.length) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.url}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify(commands.map((c) => c.map(String))),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Storage answered ${res.status}`);
    const body = await res.json();
    return (Array.isArray(body) ? body : []).map((r) => (r && "result" in r ? r.result : null));
  } finally {
    clearTimeout(timer);
  }
}

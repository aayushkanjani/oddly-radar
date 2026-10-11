// Local preview with no dependencies: `npm run dev`, then open http://localhost:3000
// Serves public/ like Vercel does (extensionless URLs map to .html) and runs api/*.js handlers.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const apiDir = path.join(root, "api");
const PORT = Number(process.env.PORT) || 3000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function resolveStatic(urlPath) {
  const clean = path.normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const candidates = clean === "/" || clean === "\\" ? ["index.html"] : [clean, clean + ".html", path.join(clean, "index.html")];
  for (const c of candidates) {
    const full = path.join(publicDir, c);
    if (full.startsWith(publicDir) && existsSync(full) && !full.endsWith(path.sep)) return full;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
  try {
    // Same rewrite as vercel.json: /g/TICKER/slug → /api/share?k=TICKER&p=slug
    const share = pathname.match(/^\/g\/([^/]+)\/([^/]+)$/);
    if (share) {
      req.url = `/api/share?k=${encodeURIComponent(decodeURIComponent(share[1]))}&p=${encodeURIComponent(decodeURIComponent(share[2]))}`;
      const mod = await import(pathToFileURL(path.join(apiDir, "share.js")).href);
      await mod.default(req, res);
      return;
    }
    const apiMatch = pathname.match(/^\/api\/([a-z0-9-]+)$/);
    if (apiMatch) {
      const file = path.join(apiDir, apiMatch[1] + ".js");
      if (!existsSync(file)) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"error":"Not found"}');
        return;
      }
      const mod = await import(pathToFileURL(file).href);
      await mod.default(req, res);
      return;
    }
    const file = resolveStatic(pathname);
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" }).end(body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("Server error");
  }
});

server.listen(PORT, () => console.log(`Oddly Radar running at http://localhost:${PORT}`));

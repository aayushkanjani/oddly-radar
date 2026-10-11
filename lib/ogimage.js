// A tiny PNG renderer for share images, with no dependencies.
// Draws flat rectangles, rounded boxes and anti-aliased text (glyph sheets in lib/ogfont.js, made from
// Inter under the SIL Open Font License), then encodes a PNG with Node's built-in zlib.

import zlib from "node:zlib";
import { FACES } from "./ogfont.js";

// ---------- glyph sheets (decoded once per warm function instance) ----------
const sheets = {};
function face(name) {
  if (!sheets[name]) {
    const f = FACES[name];
    sheets[name] = { ...f, alpha: zlib.inflateSync(Buffer.from(f.data, "base64")) };
  }
  return sheets[name];
}

// Characters the sheets don't have are simplified (accents dropped, curly quotes straightened).
export function simplify(text, faceName) {
  const g = FACES[faceName].glyphs;
  return [...String(text ?? "")]
    .map((ch) => {
      if (g[ch]) return ch;
      const base = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
      if (base && [...base].every((c) => g[c])) return base;
      if ("‘’‛′".includes(ch)) return "'";
      if ("“”″".includes(ch)) return '"';
      if ("–—".includes(ch)) return "-";
      return g["?"] ? "?" : "";
    })
    .join("");
}

// ---------- colour ----------
function rgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// ---------- canvas ----------
export function createCanvas(w, h, bg = "#000000") {
  const px = Buffer.alloc(w * h * 3);
  const [r, g, b] = rgb(bg);
  for (let i = 0; i < w * h; i++) {
    px[i * 3] = r;
    px[i * 3 + 1] = g;
    px[i * 3 + 2] = b;
  }
  return { w, h, px };
}

function blend(c, x, y, [r, g, b], a) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h || a <= 0) return;
  const i = (y * c.w + x) * 3;
  if (a >= 1) {
    c.px[i] = r;
    c.px[i + 1] = g;
    c.px[i + 2] = b;
    return;
  }
  c.px[i] = Math.round(c.px[i] + (r - c.px[i]) * a);
  c.px[i + 1] = Math.round(c.px[i + 1] + (g - c.px[i + 1]) * a);
  c.px[i + 2] = Math.round(c.px[i + 2] + (b - c.px[i + 2]) * a);
}

export function fillRect(c, x, y, w, h, color, alpha = 1) {
  const col = rgb(color);
  for (let yy = Math.max(0, y); yy < Math.min(c.h, y + h); yy++)
    for (let xx = Math.max(0, x); xx < Math.min(c.w, x + w); xx++) blend(c, xx, yy, col, alpha);
}

// Coverage of a pixel inside a rounded rectangle, with a one-pixel soft edge.
function roundCoverage(px, py, x, y, w, h, r) {
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const d = Math.hypot(px - cx, py - cy);
  return Math.max(0, Math.min(1, r - d + 0.5));
}

export function fillRoundRect(c, x, y, w, h, r, color, alpha = 1) {
  const col = rgb(color);
  for (let yy = Math.max(0, y); yy < Math.min(c.h, y + h); yy++)
    for (let xx = Math.max(0, x); xx < Math.min(c.w, x + w); xx++) {
      const cov = roundCoverage(xx + 0.5, yy + 0.5, x, y, w, h, r);
      if (cov > 0) blend(c, xx, yy, col, cov * alpha);
    }
}

export function strokeRoundRect(c, x, y, w, h, r, color, width = 2) {
  const col = rgb(color);
  for (let yy = Math.max(0, y); yy < Math.min(c.h, y + h); yy++)
    for (let xx = Math.max(0, x); xx < Math.min(c.w, x + w); xx++) {
      const outer = roundCoverage(xx + 0.5, yy + 0.5, x, y, w, h, r);
      const inner = roundCoverage(xx + 0.5, yy + 0.5, x + width, y + width, w - 2 * width, h - 2 * width, Math.max(0, r - width));
      const cov = outer - inner;
      if (cov > 0) blend(c, xx, yy, col, cov);
    }
}

// ---------- text ----------
export function measure(text, faceName) {
  const f = FACES[faceName];
  let w = 0;
  for (const ch of simplify(text, faceName)) w += f.glyphs[ch]?.[6] ?? 0;
  return w;
}

// Draws one line with its baseline at y. Returns the x after the last glyph.
export function drawText(c, text, x, y, faceName, color) {
  const f = face(faceName);
  const col = rgb(color);
  let pen = x;
  for (const ch of simplify(text, faceName)) {
    const g = f.glyphs[ch];
    if (!g) continue;
    const [gx, gy, gw, gh, left, top, adv] = g;
    const ox = Math.round(pen + left);
    const oy = Math.round(y - f.ascent + top);
    for (let j = 0; j < gh; j++)
      for (let i = 0; i < gw; i++) {
        const a = f.alpha[(gy + j) * f.w + gx + i];
        if (a) blend(c, ox + i, oy + j, col, a / 255);
      }
    pen += adv;
  }
  return pen;
}

export function drawTextRight(c, text, right, y, faceName, color) {
  return drawText(c, text, right - measure(text, faceName), y, faceName, color);
}

// Greedy word wrap; the last allowed line ends in an ellipsis if text is left over.
export function wrap(text, faceName, maxWidth, maxLines) {
  const words = simplify(text, faceName).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (measure(next, faceName) <= maxWidth) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = words[i];
    if (lines.length === maxLines) {
      line = "";
      break;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  const used = lines.join(" ").split(/\s+/).filter(Boolean).length;
  if (used < words.length && lines.length) {
    let last = lines[lines.length - 1];
    while (last && measure(last + "…", faceName) > maxWidth) last = last.replace(/\s*\S+$/, "");
    lines[lines.length - 1] = (last || lines[lines.length - 1]) + "…";
  }
  return lines;
}

// ---------- PNG ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePNG(c) {
  const raw = Buffer.alloc((c.w * 3 + 1) * c.h);
  for (let y = 0; y < c.h; y++) {
    raw[y * (c.w * 3 + 1)] = 0; // filter: none
    c.px.copy(raw, y * (c.w * 3 + 1) + 1, y * c.w * 3, (y + 1) * c.w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.w, 0);
  ihdr.writeUInt32BE(c.h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- the share image for one price gap ----------
const C = {
  bg: "#0b0d12", grid: "#10131a", ink: "#f1f2f5", muted: "#a1a7b8", faint: "#6b7184",
  line: "#232836", panel: "#11141b", accent: "#2dd4bf", accentInk: "#04241f", good: "#3ccf91", goodWash: "#0e1a17",
};
const centsText = (p) => {
  const v = Number(p) * 100;
  return (v < 10 ? v.toFixed(1) : v.toFixed(0)) + "¢";
};

export function renderGapImage({ question, kalshiYes, polyYes, site = "oddly-radar.vercel.app" }) {
  const W = 1200, H = 630;
  const c = createCanvas(W, H, C.bg);
  for (let x = 0; x < W; x += 60) fillRect(c, x, 0, 1, H, C.grid);
  for (let y = 0; y < H; y += 60) fillRect(c, 0, y, W, 1, C.grid);

  // Brand row
  fillRoundRect(c, 72, 56, 46, 46, 11, C.accent);
  drawText(c, "%", 72 + 23 - measure("%", "mid") / 2, 56 + 38, "mid", C.accentInk);
  const after = drawText(c, "oddly", 132, 94, "mid", C.ink);
  drawText(c, "RADAR", after + 12, 90, "label", C.accent);
  drawTextRight(c, "SAME BET. TWO PRICES.", W - 72, 90, "label", C.muted);

  // Question (up to 3 lines)
  const lines = wrap(question, "title", W - 144, 3);
  let y = 196;
  for (const line of lines) {
    drawText(c, line, 72, y, "title", C.ink);
    y += 66;
  }

  // Prices
  const kCheap = kalshiYes <= polyYes;
  const boxY = 418, boxW = 300, boxH = 140;
  const box = (x, label, value, cheap) => {
    fillRoundRect(c, x, boxY, boxW, boxH, 16, cheap ? C.goodWash : C.panel);
    strokeRoundRect(c, x, boxY, boxW, boxH, 16, cheap ? C.good : C.line, 2);
    drawText(c, label, x + 24, boxY + 42, "label", cheap ? C.good : C.muted);
    drawText(c, value, x + 22, boxY + 122, "big", C.ink);
  };
  box(72, kCheap ? "KALSHI · CHEAPER" : "KALSHI", centsText(kalshiYes), kCheap);
  box(72 + boxW + 20, kCheap ? "POLYMARKET" : "POLYMARKET · CHEAPER", centsText(polyYes), !kCheap);

  // Gap
  const gapText = centsText(Math.abs(kalshiYes - polyYes));
  drawTextRight(c, "GAP", W - 72, boxY + 42, "label", C.muted);
  drawTextRight(c, gapText, W - 72, boxY + 122, "big", C.accent);

  // Footer
  drawText(c, site, 72, H - 26, "label", C.faint);
  return encodePNG(c);
}

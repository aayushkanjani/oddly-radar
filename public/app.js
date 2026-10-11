(function () {
  "use strict";
  const CFG = window.RADAR_CONFIG || {};
  const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;
  const $ = (id) => document.getElementById(id);

  // ---------- formatting ----------
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function money(n, { sign = false } = {}) {
    const v = Number(n) || 0;
    const a = Math.abs(v);
    const s = a >= 1e6 ? (a / 1e6).toFixed(2) + "M" : a >= 1e4 ? (a / 1e3).toFixed(1) + "k" : a.toLocaleString("en-US", { maximumFractionDigits: 0 });
    const pre = v < 0 ? "−$" : sign && v > 0 ? "+$" : "$";
    return pre + s;
  }
  const cents = (p) => (Number(p) * 100).toFixed(0) + "¢";
  const shortAddr = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
  function ago(ts) {
    // Trades can look a few seconds "in the future" when the viewer's clock runs slow.
    const s = Math.floor(Date.now() / 1000 - ts);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }
  function hue(addr) {
    let h = 0;
    for (const c of String(addr)) h = (h * 31 + c.charCodeAt(0)) % 360;
    return h;
  }
  const safeImg = (url) => (url && /^https:\/\//.test(url) ? url : "");
  function avatar(wallet, image, attrs = "") {
    const bg = `hsl(${hue(wallet)} 45% 42%)`;
    const src = safeImg(image);
    const inner = src
      ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
      : esc(String(wallet).slice(2, 4).toUpperCase());
    return `<span class="avatar" ${attrs} style="background:${bg}">${inner}</span>`;
  }
  function micon(t) {
    const src = safeImg(t.icon);
    const letter = esc((t.title || "?").trim().charAt(0).toUpperCase());
    return `<span class="micon">${src ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('${letter}'))">` : letter}</span>`;
  }
  function mpic(src, title) {
    const letter = esc((title || "?").trim().charAt(0).toUpperCase());
    const url = safeImg(src);
    return `<span class="mpic">${url ? `<img src="${esc(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('${letter}'))">` : letter}</span>`;
  }
  const gapImage = (g) => g.polymarket?.image || g.kalshi?.image || "";
  const displayName = (name, wallet) => (name && !/^0x[0-9a-f]{20,}/i.test(name) ? name : shortAddr(wallet));
  const PERIOD_WORD = { day: "today", week: "this week", month: "this month" };
  const PERIOD_SHORT = { day: "24h", week: "7d", month: "30d" };
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const walletUrl = (w) => `/wallet?addr=${encodeURIComponent(w)}`;
  const marketUrl = (t) =>
    (t.url && /^https:\/\//.test(t.url) && t.url) ||
    (t.eventSlug ? `https://polymarket.com/event/${encodeURIComponent(t.eventSlug)}` : t.slug ? `https://polymarket.com/market/${encodeURIComponent(t.slug)}` : "https://polymarket.com");
  const venueBadge = (t) => (t.venue === "Kalshi" ? `<span class="vb ks">Kalshi</span>` : `<span class="vb pm">Poly</span>`);
  const tradeKey = (t) => `${t.tx}:${t.wallet}:${t.outcome}:${t.size}`;
  const sideWord = (t) => (t.side === "SELL" ? "SOLD" : "BOUGHT");
  const sideClass = (t) => (t.side === "SELL" ? "sell" : "buy");
  const REFRESH_MS = 10000;

  async function api(path) {
    const res = await fetch(path, { headers: { accept: "application/json" } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }
  const stateRow = (cols, text, err) => `<tr><td colspan="${cols}" class="state${err ? " err" : ""}">${esc(text)}</td></tr>`;

  // ---------- following (saved in this browser only) ----------
  const FOLLOW_KEY = "oddly.following.v1";
  const MAX_FOLLOWS = 20;
  function getFollows() {
    try {
      const v = JSON.parse(localStorage.getItem(FOLLOW_KEY) || "[]");
      return Array.isArray(v) ? v.filter((f) => f && WALLET_RE.test(f.wallet)).slice(0, MAX_FOLLOWS) : [];
    } catch {
      return [];
    }
  }
  function setFollows(list) {
    try {
      localStorage.setItem(FOLLOW_KEY, JSON.stringify(list.slice(0, MAX_FOLLOWS)));
    } catch {
      /* storage blocked: following works for this visit only */
    }
    document.dispatchEvent(new CustomEvent("follows-changed"));
  }
  const isFollowing = (w) => getFollows().some((f) => f.wallet === w.toLowerCase());
  function toggleFollow(wallet, name) {
    const w = wallet.toLowerCase();
    const list = getFollows();
    if (list.some((f) => f.wallet === w)) {
      setFollows(list.filter((f) => f.wallet !== w));
      return false;
    }
    if (list.length >= MAX_FOLLOWS) return null;
    setFollows([{ wallet: w, name: name || "" }, ...list]);
    return true;
  }
  const starBtn = (wallet, name) =>
    `<button type="button" class="star" data-star="${esc(wallet)}" data-name="${esc(name || "")}" aria-pressed="${isFollowing(wallet)}" aria-label="Follow ${esc(displayName(name, wallet))}" title="Follow">${isFollowing(wallet) ? "★" : "☆"}</button>`;

  // ---------- shared: header wallet search + config links ----------
  function initShared() {
    const form = $("find");
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const v = $("findInput").value.trim();
        if (WALLET_RE.test(v)) location.href = walletUrl(v);
        else {
          $("findInput").setCustomValidity("Paste a full Polymarket wallet address (0x + 40 characters).");
          $("findInput").reportValidity();
        }
      });
      $("findInput").addEventListener("input", () => $("findInput").setCustomValidity(""));
    }
    document.querySelectorAll("[data-cfg]").forEach((el) => {
      const url = CFG[el.dataset.cfg];
      if (url) el.href = url;
      else el.hidden = true;
    });
  }

  // ---------- home page ----------
  function initHome() {
    const st = { period: "week", sort: "pnl", min: 10000, venue: "all", smartHours: 24, gapMin: 0 };
    const seenWhales = new Set();
    const seenFollow = new Set();
    let firstWhaleLoad = true;
    let firstFollowLoad = true;
    let lastBatch = { trades: [], errors: {} };

    function bindSeg(id, key, onChange) {
      const seg = $(id);
      seg.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-v]");
        if (!b) return;
        st[key] = b.dataset.v;
        seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        onChange();
      });
    }

    // Leaderboard: all traders in one list; the top three get a gold rank.
    async function loadBoard() {
      const tb = $("board");
      tb.innerHTML = stateRow(5, "Loading traders…");
      const byProfit = st.sort === "pnl";
      $("mainCol").textContent = byProfit ? "Profit" : "Volume";
      $("sideCol").textContent = byProfit ? "Volume" : "Profit";
      try {
        const { traders } = await api(`/api/leaderboard?period=${st.period}&sort=${st.sort}&limit=50`);
        if (!traders.length) {
          tb.innerHTML = stateRow(5, "No traders for this period yet.");
          return;
        }
        const VISIBLE = 20;
        tb.classList.add("collapsed");
        $("showAll").hidden = traders.length <= VISIBLE;
        $("showAll").textContent = `Show all ${traders.length} traders`;
        const mainVal = (t) => (byProfit ? t.pnl : t.volume);
        const max = Math.max(1, ...traders.map((t) => Math.abs(mainVal(t))));
        tb.innerHTML = traders
          .map((t, i) => {
            const v = mainVal(t);
            const pct = Math.max(2, Math.round((Math.abs(v) / max) * 100));
            const mainTxt = byProfit ? money(v, { sign: true }) : money(v);
            const sideTxt = byProfit ? money(t.volume) : money(t.pnl, { sign: true });
            const mainCls = byProfit ? (v >= 0 ? "up" : "dn") : "";
            const sideCls = byProfit ? "" : t.pnl >= 0 ? "up" : "dn";
            return `<tr class="link${i >= VISIBLE ? " more" : ""}" data-w="${esc(t.wallet)}" tabindex="0">
              <td>${starBtn(t.wallet, t.name)}</td>
              <td class="rank${t.rank <= 3 ? " top" : ""}">${t.rank}</td>
              <td><div class="who">${avatar(t.wallet, t.image)}<div><b>${esc(displayName(t.name, t.wallet))}${t.verified ? '<span class="tick" title="Verified">✔</span>' : ""}</b><small>${esc(shortAddr(t.wallet))}${t.xUsername ? " · @" + esc(t.xUsername) : ""}</small></div></div></td>
              <td class="r"><div class="pnlcell"><span class="num ${mainCls}">${mainTxt}</span><span class="bar"><i style="width:${pct}%"></i></span></div></td>
              <td class="r num ${sideCls}">${sideTxt}</td></tr>`;
          })
          .join("");
      } catch (err) {
        tb.innerHTML = stateRow(5, err.message, true);
      }
    }

    // Live tape: alternate venues so Kalshi shows even when Polymarket is busier.
    function interleaveVenues(trades, max = 24) {
      const pm = trades.filter((t) => t.venue !== "Kalshi");
      const ks = trades.filter((t) => t.venue === "Kalshi");
      const out = [];
      while (out.length < max && (pm.length || ks.length)) {
        if (pm.length) out.push(pm.shift());
        if (ks.length && out.length < max) out.push(ks.shift());
      }
      return out;
    }
    function renderTicker(trades) {
      if (!trades.length) return;
      const items = interleaveVenues(trades)
        .map(
          (t) => `<a class="tk" href="${esc(marketUrl(t))}" target="_blank" rel="noopener">${venueBadge(t)}<b>${money(t.usd)}</b><span class="side ${sideClass(t)}">${sideWord(t)} ${esc(clip(t.outcome || "", 14))}</span><span>${esc(clip(t.title, 50))}</span></a>`,
        )
        .join("");
      $("ticker").innerHTML = items + items; // two copies so the -50% loop is seamless
    }

    function renderWhales() {
      const ul = $("whales");
      const trades = lastBatch.trades.filter((t) => st.venue === "all" || (t.venue || "Polymarket") === st.venue);
      if (!trades.length) {
        const where = st.venue === "all" ? "" : ` on ${st.venue}`;
        ul.innerHTML = `<li class="state">No trades over ${money(st.min)}${where} in the last hour. Try a lower minimum.</li>`;
        return;
      }
      ul.innerHTML = trades
        .map((t) => {
          const key = tradeKey(t);
          const fresh = !firstWhaleLoad && !seenWhales.has(key);
          seenWhales.add(key);
          const who =
            t.venue === "Kalshi"
              ? `<span>anonymous${t.fills > 1 ? ` · ${t.fills} fills` : ""}</span>`
              : `<a href="${walletUrl(t.wallet)}">${esc(displayName(t.name, t.wallet))}</a>`;
          return `<li class="frow${fresh ? " fresh" : ""}">
            ${micon(t)}
            <div style="min-width:0">
              <div class="row1"><span class="amt">${money(t.usd)}</span><span class="pill ${sideClass(t)}">${sideWord(t)} ${esc(t.outcome || "")}</span></div>
              <a class="q" href="${esc(marketUrl(t))}" target="_blank" rel="noopener" title="${esc(t.title)}">${esc(t.title)}</a>
              <div class="meta">${venueBadge(t)}<span>at ${cents(t.price)}</span>${who}<span>${ago(t.ts)}</span></div>
            </div>
          </li>`;
        })
        .join("");
      firstWhaleLoad = false;
    }

    async function loadWhales() {
      const ul = $("whales");
      if (!ul.children.length) ul.innerHTML = `<li class="state">Loading big trades…</li>`;
      try {
        const data = await api(`/api/whales?min=${st.min}&venue=all&limit=80`);
        lastBatch = { trades: data.trades || [], errors: data.errors || {} };
        renderTicker(lastBatch.trades);
        renderWhales();
        const down = Object.keys(lastBatch.errors);
        const note = down.length ? ` · ${down.map((v) => v[0].toUpperCase() + v.slice(1)).join(", ")} unavailable` : "";
        $("whalesAt").textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " · every 10s" + note;
      } catch (err) {
        ul.innerHTML = `<li class="state err">${esc(err.message)}</li>`;
      }
    }

    // Smart money: markets ranked by how many top traders are buying.
    async function loadSmart() {
      const box = $("smart");
      box.innerHTML = Array.from({ length: 4 }, () => `<div class="srow"><span></span><span class="skel" style="height:30px"></span><span class="skel" style="width:70%"></span><span></span></div>`).join("");
      try {
        const d = await api(`/api/smart?period=week&hours=${st.smartHours}&n=30`);
        const windowWord = { 6: "6 hours", 24: "24 hours", 72: "3 days" }[st.smartHours];
        $("smartMeta").textContent = `What this week's ${d.topN} most profitable traders bought in the last ${windowWord}` + (d.failed ? ` · ${d.failed} wallets unavailable` : "");
        if (!d.markets.length) {
          box.innerHTML = `<div class="state">No buying from the top ${d.topN} traders in the last ${windowWord}. Try a longer window.</div>`;
          return;
        }
        box.innerHTML = d.markets
          .map((m, i) => {
            const avs = m.buyers
              .map((b) => `<a href="${walletUrl(b.wallet)}" title="#${b.rank} ${esc(displayName(b.name, b.wallet))} · ${esc(money(b.net))}">${avatar(b.wallet, b.image)}</a>`)
              .join("");
            return `<div class="srow">
              <span class="n">${i + 1}</span>
              ${micon(m)}
              <div style="min-width:0">
                <div class="title"><a href="${esc(marketUrl(m))}" target="_blank" rel="noopener" title="${esc(m.title)}">${esc(m.title)}</a></div>
                <div class="line2">
                  <span class="pill buy">${esc(m.outcome)}</span>
                  <span>Net <b class="up">${money(m.netUsd)}</b></span>
                  ${m.avgEntry != null ? `<span>Entry <b>${cents(m.avgEntry)}</b></span>` : ""}
                  <span>Last <b>${cents(m.lastPrice)}</b></span>
                  <span>${ago(m.lastTs)}</span>
                </div>
              </div>
              <div class="right"><span class="count"><b>${m.buyerCount}</b>${m.buyerCount === 1 ? "trader" : "traders"}</span><span class="stackav">${avs}</span></div>
            </div>`;
          })
          .join("");
      } catch (err) {
        box.innerHTML = `<div class="state err">${esc(err.message)}</div>`;
      }
    }

    // Following: latest trades from the traders this visitor starred.
    async function loadFollowing() {
      const ul = $("following");
      const follows = getFollows();
      $("followCount").textContent = follows.length ? `${follows.length}` : "";
      if (!follows.length) {
        ul.innerHTML = `<li class="empty">Tap <b>☆</b> next to any trader in the leaderboard and their trades show up here as they happen.</li>`;
        $("followAt").textContent = "";
        return;
      }
      if (!ul.querySelector(".frow")) ul.innerHTML = `<li class="state">Loading trades…</li>`;
      try {
        const d = await api(`/api/following?wallets=${follows.map((f) => f.wallet).join(",")}`);
        const names = new Map(follows.map((f) => [f.wallet, f.name]));
        if (!d.trades.length) {
          ul.innerHTML = `<li class="empty">No recent trades from the traders you follow.</li>`;
          return;
        }
        ul.innerHTML = d.trades
          .map((t) => {
            const key = tradeKey(t);
            const fresh = !firstFollowLoad && !seenFollow.has(key);
            seenFollow.add(key);
            const name = displayName(t.name || names.get(t.wallet), t.wallet);
            return `<li class="frow${fresh ? " fresh" : ""}">
              <a href="${walletUrl(t.wallet)}" style="text-decoration:none">${avatar(t.wallet)}</a>
              <div style="min-width:0">
                <div class="row1"><a href="${walletUrl(t.wallet)}" style="text-decoration:none;font-weight:600">${esc(name)}</a><span class="amt" style="font-size:13.5px">${money(t.usd)}</span></div>
                <a class="q" href="${esc(marketUrl(t))}" target="_blank" rel="noopener" title="${esc(t.title)}">${esc(t.title)}</a>
                <div class="meta"><span class="pill ${sideClass(t)}">${sideWord(t)} ${esc(t.outcome || "")}</span><span>at ${cents(t.price)}</span><span>${ago(t.ts)}</span></div>
              </div>
            </li>`;
          })
          .join("");
        firstFollowLoad = false;
        $("followAt").textContent = d.failed ? `${d.failed} unavailable` : "";
      } catch (err) {
        ul.innerHTML = `<li class="state err">${esc(err.message)}</li>`;
      }
    }

    // Price gaps: the same question priced differently on Kalshi and Polymarket.
    let allGaps = [];
    const ctsf = (p) => (Number(p) * 100).toFixed(Number(p) * 100 < 10 ? 1 : 0) + "¢";
    const closeDate = (iso) => {
      const t = Date.parse(iso);
      if (!Number.isFinite(t) || t - Date.now() > 8 * 365 * 86400e3) return ""; // placeholders like 2099
      const sameYear = new Date(t).getFullYear() === new Date().getFullYear();
      return new Date(t).toLocaleDateString([], sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
    };
    function gapShareText(g) {
      const handle = CFG.xHandle ? ` via @${CFG.xHandle}` : "";
      return `Same bet, two prices: "${clip(g.label, 80)}" is ${cents(g.kalshi.yes)} on Kalshi and ${cents(g.polymarket.yes)} on Polymarket. That's a ${(g.gap * 100).toFixed(0)}¢ gap${handle}`;
    }
    // "Report" opens a pre-filled GitHub issue with a ready-to-paste line for BLOCKED in lib/pairs.js.
    function reportUrl(g) {
      if (!CFG.reportUrl || !/^https:\/\//.test(CFG.reportUrl)) return "";
      const body = [
        "This automatic pair looks wrong (two different questions).",
        "",
        `Kalshi: ${g.kalshi.question}`,
        g.kalshi.url,
        "",
        `Polymarket: ${g.polymarket.question}`,
        g.polymarket.url,
        "",
        "To remove it, add this line to BLOCKED in lib/pairs.js:",
        "```",
        `{ kalshi: "${g.kalshi.id}", polymarket: "${g.polymarket.id}", why: "" },`,
        "```",
      ].join("\n");
      return `${CFG.reportUrl}?title=${encodeURIComponent("Wrong pair: " + clip(g.label, 80))}&body=${encodeURIComponent(body)}`;
    }
    // Each gap has its own share page (/g/TICKER/slug) whose link preview is that gap's image.
    const gapKey = (g) => `${g.kalshi.id}|${g.polymarket.id}`;
    const gapLink = (g) => `${location.origin}/g/${encodeURIComponent(g.kalshi.id)}/${encodeURIComponent(g.polymarket.id)}`;
    const shareUrl = (g) => `https://twitter.com/intent/tweet?text=${encodeURIComponent(gapShareText(g))}&url=${encodeURIComponent(gapLink(g))}`;
    // A shared link opens /?gap=TICKER|slug#gaps: scroll to that gap and highlight it once.
    let sharedGap = new URLSearchParams(location.search).get("gap") || "";

    // Very large gaps on auto-matched pairs are more often two different questions than a real gap.
    const SUSPECT_GAP = 0.15;
    const isSuspect = (g) => !g.verified && g.gap > SUSPECT_GAP;
    function renderGapBanner() {
      // Only feature pairs we're confident in: hand-verified, or a strong automatic match.
      const g = allGaps.find((x) => x.verified || ((x.match || 0) >= 0.7 && !isSuspect(x)));
      const el = $("gapBanner");
      if (!g || g.gap < 0.02) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      el.innerHTML = `<span class="lbl">Biggest gap right now</span>
        ${mpic(gapImage(g), g.label)}
        <span class="q">${esc(g.label)}<small>Kalshi ${cents(g.kalshi.yes)} · Polymarket ${cents(g.polymarket.yes)} · cheaper on ${esc(g.cheaper)}</small></span>
        <span class="big">${(g.gap * 100).toFixed(0)}¢</span>`;
    }

    // ---- gap history (only when storage is set up on the server) ----
    let history = { enabled: false, series: {} };
    function sparkline(points) {
      if (!points || points.length < 2) return "";
      const W = 92, H = 26;
      const t0 = points[0].t, t1 = points[points.length - 1].t || t0 + 1;
      const max = Math.max(1, ...points.map((p) => p.gap));
      const X = (t) => ((t - t0) / Math.max(1, t1 - t0)) * (W - 4) + 2;
      const Y = (v) => H - 3 - (v / max) * (H - 6);
      const line = points.map((p) => `${X(p.t).toFixed(1)},${Y(p.gap).toFixed(1)}`).join(" ");
      const last = points[points.length - 1];
      const lo = Math.min(...points.map((p) => p.gap)), hi = Math.max(...points.map((p) => p.gap));
      return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gap over 24 hours: low ${lo}¢, high ${hi}¢">
        <title>Last 24h: low ${lo}¢, high ${hi}¢</title>
        <polygon points="${X(t0).toFixed(1)},${H - 3} ${line} ${X(last.t).toFixed(1)},${H - 3}" fill="var(--mark-soft)"/>
        <polyline points="${line}" fill="none" stroke="var(--mark)" stroke-width="1.6" stroke-linejoin="round"/>
        <circle cx="${X(last.t).toFixed(1)}" cy="${Y(last.gap).toFixed(1)}" r="2.6" fill="var(--mark)"/></svg>`;
    }
    async function loadHistory() {
      if (!allGaps.length) return;
      try {
        const keys = allGaps.slice(0, 40).map(gapKey).join(",");
        const d = await api(`/api/history?pairs=${encodeURIComponent(keys)}`);
        history = { enabled: !!d.enabled, series: d.series || {} };
        $("widestBtn").hidden = !history.enabled;
        if (history.enabled && st.gapMin !== "widest") renderGaps();
      } catch {
        /* history is optional */
      }
    }
    async function renderWidest() {
      const box = $("gaps");
      box.innerHTML = `<div class="state">Loading the widest gaps of the week…</div>`;
      try {
        const d = await api("/api/history?widest=7");
        if (!d.enabled || !d.items?.length) {
          box.innerHTML = `<div class="state">No history yet. It fills in as gaps are recorded every 10 minutes.</div>`;
          return;
        }
        const live = new Map(allGaps.map((g) => [gapKey(g), g]));
        box.innerHTML = d.items
          .map((it, i) => {
            const now = live.get(it.id);
            const when = new Date(it.day + "T12:00:00Z").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
            return `<div class="gcard wide">
              ${mpic(it.image, it.label)}
              <div style="min-width:0">
                <div class="q">${esc(it.label || it.id)}</div>
                <div class="meta">${it.verified ? `<span class="badge ok">Verified pair</span>` : `<span class="badge auto">Auto-matched</span>`}<span>widest on ${esc(when)}</span>${now ? `<span>now <b>${(now.gap * 100).toFixed(1)}¢</b></span>` : `<span>closed or no longer matched</span>`}</div>
              </div>
              <div class="prices">
                ${it.kalshiUrl ? `<a class="vp" href="${esc(it.kalshiUrl)}" target="_blank" rel="noopener"><small>Kalshi</small><b>↗</b></a>` : ""}
                ${it.polymarketUrl ? `<a class="vp" href="${esc(it.polymarketUrl)}" target="_blank" rel="noopener"><small>Polymarket</small><b>↗</b></a>` : ""}
              </div>
              <div class="gapbox"><b class="hot">${Number(it.maxGap).toFixed(1)}¢</b><small>#${i + 1} this week</small></div>
            </div>`;
          })
          .join("");
      } catch (err) {
        box.innerHTML = `<div class="state err">${esc(err.message)}</div>`;
      }
    }

    function renderGaps() {
      const box = $("gaps");
      if (st.gapMin === "widest") return renderWidest();
      const min = Number(st.gapMin) / 100;
      const list = allGaps.filter((g) => g.gap >= min);
      if (!list.length) {
        box.innerHTML = `<div class="state">${allGaps.length ? `No gaps of ${st.gapMin}¢ or more right now. Try "All".` : "No matching questions found on both venues right now. Checking again shortly."}</div>`;
        return;
      }
      box.innerHTML = list
        .map((g) => {
          const pts = g.gap * 100;
          const kCheap = g.cheaper === "Kalshi";
          const edge = g.lockIn ? g.lockIn.edge * 100 : null;
          const badge = g.verified
            ? `<span class="badge ok">Verified pair</span>`
            : g.kind === "game"
              ? `<span class="badge game">${esc((g.league || "").toUpperCase())} game · same teams and date</span>`
              : `<span class="badge auto">Auto-matched · ${Math.round((g.match || 0) * 100)}%</span>`;
          // Same deadline: one date. Different deadlines (normal for long-dated questions): show both.
          const kd = closeDate(g.kalshi.endDate), pd = closeDate(g.polymarket.endDate);
          const dateLine = (g.closeDaysApart || 0) > 30 && kd && pd ? `closes Kalshi ${kd} · Polymarket ${pd}` : kd || pd ? `closes ${kd || pd}` : "";
          return `<div class="gcard${gapKey(g) === sharedGap ? " shared" : ""}" data-key="${esc(gapKey(g))}">
            ${mpic(gapImage(g), g.label)}
            <div style="min-width:0">
              <div class="q">${esc(g.label)}</div>
              <div class="meta">${badge}${dateLine ? `<span>${esc(dateLine)}</span>` : ""}${g.category ? `<span>${esc(g.category)}</span>` : ""}</div>
            </div>
            <div class="prices">
              <a class="vp${kCheap ? " cheap" : ""}" href="${esc(g.kalshi.url)}" target="_blank" rel="noopener" title="${esc(g.kalshi.question)}"><small>Kalshi${kCheap ? " · cheaper" : ""}</small><b>${ctsf(g.kalshi.yes)}</b></a>
              <a class="vp${kCheap ? "" : " cheap"}" href="${esc(g.polymarket.url)}" target="_blank" rel="noopener" title="${esc(g.polymarket.question)}"><small>Polymarket${kCheap ? "" : " · cheaper"}</small><b>${ctsf(g.polymarket.yes)}</b></a>
            </div>
            <div class="gapbox"><b class="${pts >= 3 ? "hot" : ""}">${pts.toFixed(pts < 10 ? 1 : 0)}¢</b><small>gap</small>${history.enabled ? sparkline(history.series[gapKey(g)]) : ""}</div>
            <div class="foot">
              ${edge != null ? `<span>YES on ${esc(g.cheaper)} + NO on the other: ${edge > 0 ? `locks <b class="up">${edge.toFixed(1)}¢</b> per $1` : `<b>no lock-in</b> after the spread`}</span>` : ""}
              ${g.ruleNote ? `<span class="warn">⚠ ${esc(g.ruleNote)}</span>` : ""}
              ${isSuspect(g) ? `<span class="warn">⚠ Unusually large gap: these may be different questions. Compare the rules first.</span>` : ""}
              <span class="act">${!g.verified && reportUrl(g) ? `<a class="btn" href="${esc(reportUrl(g))}" target="_blank" rel="noopener" title="Report a wrong pair">Report</a>` : ""}<a class="btn" href="${shareUrl(g)}" target="_blank" rel="noopener">Share</a></span>
            </div>
            <details>
              <summary>Compare the rules ▾</summary>
              <div class="rules">
                <div><b>Kalshi · ${esc(clip(g.kalshi.question, 70))}</b>${esc(clip(g.kalshi.rules || "No rules text available.", 900))}</div>
                <div><b>Polymarket · ${esc(clip(g.polymarket.question, 70))}</b>${esc(clip(g.polymarket.rules || "No rules text available.", 900))}</div>
              </div>
            </details>
          </div>`;
        })
        .join("");
    }

    async function loadGaps() {
      const box = $("gaps");
      if (!allGaps.length) box.innerHTML = Array.from({ length: 3 }, () => `<div class="gcard"><span class="mpic"></span><span class="skel" style="width:70%"></span><span class="skel" style="width:180px;height:40px"></span><span class="skel" style="width:60px;height:28px"></span></div>`).join("");
      try {
        const d = await api("/api/gaps");
        allGaps = d.gaps || [];
        loadHistory();
        const sc = d.scanned || {};
        // Kalshi lists every outcome and price level as its own market (each candidate, each BTC strike),
        // so its raw count is always far higher. Say so instead of showing two numbers that look broken.
        $("gapsMeta").textContent = `${allGaps.length} ${allGaps.length === 1 ? "question" : "questions"} live on both venues`;
        $("gapsMeta").title =
          sc.kalshi && sc.polymarket
            ? `Checked ${sc.kalshi.toLocaleString()} Kalshi and ${sc.polymarket.toLocaleString()} Polymarket markets. Kalshi lists each outcome and price level as its own market, so its count is much higher.`
            : "";
        renderGapBanner();
        renderGaps();
        if (sharedGap) {
          const el = document.querySelector(".gcard.shared");
          if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
          sharedGap = ""; // highlight only on the first load
        }
      } catch (err) {
        box.innerHTML = `<div class="state err">${esc(err.message)}</div>`;
      }
    }

    bindSeg("period", "period", loadBoard);
    bindSeg("sort", "sort", loadBoard);
    bindSeg("smartHours", "smartHours", loadSmart);
    bindSeg("gapMin", "gapMin", renderGaps);
    bindSeg("venue", "venue", () => {
      firstWhaleLoad = true; // switching views shouldn't flash every row as new
      renderWhales();
    });
    $("minUsd").addEventListener("change", (e) => {
      st.min = Number(e.target.value);
      $("whales").innerHTML = "";
      firstWhaleLoad = true;
      seenWhales.clear();
      loadWhales();
    });
    $("showAll").addEventListener("click", () => {
      const open = $("board").classList.toggle("collapsed") === false;
      $("showAll").textContent = open ? "Show fewer" : "Show all traders";
    });
    $("board").addEventListener("click", (e) => {
      const star = e.target.closest("[data-star]");
      if (star) {
        e.stopPropagation();
        const on = toggleFollow(star.dataset.star, star.dataset.name);
        if (on === null) {
          star.title = `You can follow up to ${MAX_FOLLOWS} traders`;
          return;
        }
        star.setAttribute("aria-pressed", String(on));
        star.textContent = on ? "★" : "☆";
        return;
      }
      const tr = e.target.closest("tr[data-w]");
      if (tr) location.href = walletUrl(tr.dataset.w);
    });
    $("board").addEventListener("keydown", (e) => {
      if (e.target.closest("[data-star]")) return;
      const tr = e.target.closest("tr[data-w]");
      if (tr && e.key === "Enter") location.href = walletUrl(tr.dataset.w);
    });
    document.addEventListener("follows-changed", () => {
      firstFollowLoad = true;
      seenFollow.clear();
      loadFollowing();
    });

    loadBoard();
    loadWhales();
    loadSmart();
    loadFollowing();
    loadGaps();
    setInterval(() => {
      if (!document.hidden) loadWhales();
    }, REFRESH_MS);
    setInterval(() => {
      if (!document.hidden) loadFollowing();
    }, 20000);
    setInterval(() => {
      if (!document.hidden) loadSmart();
    }, 180000);
    // Gaps are cached for 2 minutes on the server; refresh on the same rhythm.
    setInterval(() => {
      if (!document.hidden) loadGaps();
    }, 120000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        loadWhales();
        loadFollowing();
      }
    });
  }

  // ---------- wallet page ----------
  function moveBar(avg, cur) {
    const a = Math.min(1, Math.max(0, Number(avg) || 0)) * 100;
    const c = Math.min(1, Math.max(0, Number(cur) || 0)) * 100;
    const color = c >= a ? "var(--good)" : "var(--no)";
    const lo = Math.min(a, c), hi = Math.max(a, c);
    return `<div style="display:flex;align-items:center;gap:10px">
      <div class="move" title="Entry ${a.toFixed(0)}¢, now ${c.toFixed(0)}¢">
        <span class="rail"></span>
        <span class="seg" style="left:${lo}%;width:${Math.max(1, hi - lo)}%;background:${color}"></span>
        <span class="dot" style="left:${a}%;background:var(--muted)"></span>
        <span class="dot" style="left:${c}%;background:${color}"></span>
      </div>
      <span class="num muted" style="font-size:12px;white-space:nowrap">${a.toFixed(0)}¢ → <b style="color:${color}">${c.toFixed(0)}¢</b></span>
    </div>`;
  }

  async function initWallet() {
    const addr = (new URLSearchParams(location.search).get("addr") || "").trim();
    if (!WALLET_RE.test(addr)) {
      $("profileName").textContent = "Wallet not found";
      $("profileAddr").textContent = "Paste a full Polymarket wallet address in the search box above.";
      $("positions").innerHTML = stateRow(4, "No wallet to show.");
      $("trades").innerHTML = stateRow(5, "No wallet to show.");
      $("followBtn").hidden = true;
      return;
    }
    $("profileAddr").textContent = addr;
    $("polyLink").href = `https://polymarket.com/profile/${addr}`;

    let traderName = "";
    const paintFollow = () => {
      const on = isFollowing(addr);
      $("followBtn").textContent = on ? "★ Following" : "☆ Follow";
      $("followBtn").setAttribute("aria-pressed", String(on));
    };
    paintFollow();
    $("followBtn").addEventListener("click", () => {
      const on = toggleFollow(addr, traderName);
      if (on === null) $("toast").textContent = `You can follow up to ${MAX_FOLLOWS} traders. Unfollow one on the home page first.`;
      else $("toast").textContent = on ? "Following. Their trades now show on the home page." : "Unfollowed.";
      paintFollow();
    });

    try {
      const d = await api(`/api/wallet?addr=${addr}`);
      const name = displayName(d.name, d.wallet);
      traderName = d.name || "";
      document.title = `${name} · Oddly Radar`;
      $("profileName").textContent = name;
      $("profileAvatar").outerHTML = avatar(d.wallet, "", 'id="profileAvatar"');

      const s = d.stats;
      const st = d.standing;
      const pnlCell = (v) => `<span class="${v >= 0 ? "up" : "dn"}">${money(v, { sign: true })}</span>`;
      if (st) {
        $("record").hidden = false;
        $("recRank").textContent = `#${st.rank} ${PERIOD_WORD[st.period]}`;
        $("recBig").textContent = money(st.pnl, { sign: true });
        $("recBig").className = "big " + (st.pnl >= 0 ? "up" : "dn");
        $("recSub").textContent = `profit · ${money(st.volume)} traded`;
      }
      const cards = [
        ["Open bets", s.openPositions],
        ["Open value", money(s.openValue)],
        ["Unrealized P&L", pnlCell(s.openPnl)],
        st ? [`Volume, ${PERIOD_SHORT[st.period]}`, money(st.volume)] : ["Bets in profit", s.winningShare == null ? "—" : Math.round(s.winningShare * 100) + "%"],
        ["Last trade", s.lastTradeAt ? ago(s.lastTradeAt) : "—"],
      ];
      $("stats").innerHTML = cards.map(([k, v]) => `<div class="stat"><small>${k}</small><b>${v}</b></div>`).join("");

      $("positions").innerHTML = d.positions.length
        ? d.positions
            .slice(0, 25)
            .map(
              (p) => `<tr><td class="mkt"><div class="mrow">${micon(p)}<div style="min-width:0"><a href="${esc(marketUrl(p))}" target="_blank" rel="noopener">${esc(p.title)}</a><small>${esc(p.outcome)}${p.endDate ? " · ends " + esc(new Date(p.endDate).toLocaleDateString([], { day: "numeric", month: "short" })) : ""}</small></div></div></td>
              <td>${moveBar(p.avgPrice, p.curPrice)}</td>
              <td class="r num">${money(p.currentValue)}</td>
              <td class="r num ${p.cashPnl >= 0 ? "up" : "dn"}">${money(p.cashPnl, { sign: true })}</td></tr>`,
            )
            .join("")
        : stateRow(4, "No open bets right now. Their recent trades are below.");

      $("trades").innerHTML = d.trades.length
        ? d.trades
            .slice(0, 25)
            .map(
              (t) => `<tr><td class="mkt"><div class="mrow">${micon(t)}<div style="min-width:0"><a href="${esc(marketUrl(t))}" target="_blank" rel="noopener">${esc(t.title)}</a><small>${esc(t.outcome)}</small></div></div></td>
              <td><span class="pill ${sideClass(t)}">${sideWord(t)}</span></td>
              <td class="r num">${cents(t.price)}</td><td class="r num">${money(t.usd)}</td><td class="r muted">${ago(t.ts)}</td></tr>`,
            )
            .join("")
        : stateRow(5, "No recent trades.");

      const top = d.positions[0];
      const handle = CFG.xHandle ? ` via @${CFG.xHandle}` : "";
      const bet = top ? `"${clip(top.title, 70)}" (${top.outcome}, ${money(top.currentValue)})` : "";
      let text;
      if (st && st.pnl > 0) {
        text = `${name} is #${st.rank} on Polymarket ${PERIOD_WORD[st.period]}: ${money(st.pnl, { sign: true })} profit.` + (top ? ` Biggest open bet: ${bet}.` : "") + ` See every position${handle}:`;
      } else if (top) {
        text = `${name} has ${money(s.openValue)} riding on Polymarket. Biggest bet: ${bet}.${handle}`;
      } else {
        const last = d.trades[0];
        text = last
          ? `${name} just ${last.side === "SELL" ? "sold" : "bought"} ${money(last.usd)} of "${clip(last.title, 70)}" on Polymarket.${handle}`
          : `Tracking ${name} on Polymarket${handle}`;
      }
      $("shareX").href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(location.href)}`;
    } catch (err) {
      $("profileName").textContent = "Couldn't load this wallet";
      $("positions").innerHTML = stateRow(4, err.message, true);
      $("trades").innerHTML = stateRow(5, err.message, true);
    }
    $("copyLink").addEventListener("click", () => {
      const done = () => ($("toast").textContent = "Link copied.");
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(location.href).then(done, () => ($("toast").textContent = location.href));
      else $("toast").textContent = location.href;
    });
  }

  initShared();
  if (document.body.dataset.page === "home") initHome();
  if (document.body.dataset.page === "wallet") initWallet();
})();

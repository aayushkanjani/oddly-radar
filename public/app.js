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
    const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }
  function hue(addr) {
    let h = 0;
    for (const c of String(addr)) h = (h * 31 + c.charCodeAt(0)) % 360;
    return h;
  }
  function avatar(wallet, image) {
    const bg = `hsl(${hue(wallet)} 55% 45%)`;
    const inner = image && /^https:\/\//.test(image)
      ? `<img src="${esc(image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
      : esc(String(wallet).slice(2, 4).toUpperCase());
    return `<span class="avatar" style="background:${bg}">${inner}</span>`;
  }
  const displayName = (name, wallet) => (name && !WALLET_RE.test(name) ? name : shortAddr(wallet));
  const walletUrl = (w) => `/wallet?addr=${encodeURIComponent(w)}`;
  const marketUrl = (t) => (t.eventSlug ? `https://polymarket.com/event/${encodeURIComponent(t.eventSlug)}` : t.slug ? `https://polymarket.com/market/${encodeURIComponent(t.slug)}` : "https://polymarket.com");

  async function api(path) {
    const res = await fetch(path, { headers: { accept: "application/json" } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }

  const stateRow = (cols, text, err) => `<tr><td colspan="${cols}" class="state${err ? " err" : ""}">${esc(text)}</td></tr>`;

  // ---------- shared: header wallet search + config links ----------
  function initShared() {
    const form = $("find");
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const v = $("findInput").value.trim();
        if (WALLET_RE.test(v)) location.href = walletUrl(v);
        else $("findInput").setCustomValidity("Paste a full Polymarket wallet address (0x + 40 characters)."), $("findInput").reportValidity();
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
    const st = { period: "week", sort: "pnl", min: 10000 };

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

    async function loadBoard() {
      const tb = $("board");
      tb.innerHTML = stateRow(4, "Loading traders…");
      try {
        const { traders } = await api(`/api/leaderboard?period=${st.period}&sort=${st.sort}&limit=50`);
        if (!traders.length) return (tb.innerHTML = stateRow(4, "No traders for this period yet."));
        tb.innerHTML = traders
          .map(
            (t) => `<tr class="link" data-w="${esc(t.wallet)}" tabindex="0">
            <td class="rank">${t.rank}</td>
            <td><div class="who">${avatar(t.wallet, t.image)}<div><b>${esc(displayName(t.name, t.wallet))}${t.verified ? '<span class="tick" title="Verified">✔</span>' : ""}</b><small>${esc(shortAddr(t.wallet))}${t.xUsername ? " · @" + esc(t.xUsername) : ""}</small></div></div></td>
            <td class="r num ${t.pnl >= 0 ? "up" : "dn"}">${money(t.pnl, { sign: true })}</td>
            <td class="r num">${money(t.volume)}</td></tr>`,
          )
          .join("");
      } catch (err) {
        tb.innerHTML = stateRow(4, err.message, true);
      }
    }

    async function loadWhales() {
      const ul = $("whales");
      if (!ul.children.length) ul.innerHTML = `<li class="state">Loading big trades…</li>`;
      try {
        const { trades } = await api(`/api/whales?min=${st.min}&limit=40`);
        if (!trades.length) return (ul.innerHTML = `<li class="state">No trades over ${money(st.min)} in the latest batch.</li>`);
        ul.innerHTML = trades
          .map(
            (t) => `<li>
            <div class="row1"><span class="amt">${money(t.usd)}</span><span class="pill ${t.side === "SELL" ? "sell" : "buy"}">${t.side === "SELL" ? "SOLD" : "BOUGHT"} ${esc(t.outcome || "")}</span></div>
            <a class="q" href="${marketUrl(t)}" target="_blank" rel="noopener">${esc(t.title)}</a>
            <div class="meta"><span>at ${cents(t.price)}</span><a href="${walletUrl(t.wallet)}">${esc(displayName(t.name, t.wallet))}</a><span>${ago(t.ts)}</span></div>
          </li>`,
          )
          .join("");
        $("whalesAt").textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      } catch (err) {
        ul.innerHTML = `<li class="state err">${esc(err.message)}</li>`;
      }
    }

    async function loadGaps() {
      try {
        const { gaps, pairsConfigured } = await api("/api/gaps");
        if (!pairsConfigured) return; // section stays hidden until you add pairs in lib/pairs.js
        $("gapsSection").hidden = false;
        const box = $("gaps");
        if (!gaps.length) return (box.innerHTML = `<div class="state">Couldn't load the matched markets right now.</div>`);
        box.innerHTML = gaps
          .map((g) => {
            const pts = g.gap * 100;
            return `<div class="gapcard"><div>
              <b>${esc(g.label)}</b> <span class="muted">${esc(g.category)}</span>
              <div class="muted num" style="font-size:13px;margin-top:2px">
                <a href="${esc(g.kalshi.url)}" target="_blank" rel="noopener">Kalshi ${cents(g.kalshi.yes)}</a> ·
                <a href="${esc(g.polymarket.url)}" target="_blank" rel="noopener">Polymarket ${cents(g.polymarket.yes)}</a> ·
                cheaper on ${esc(g.cheaper)}</div>
              ${g.ruleNote ? `<div class="warn">⚠ Rules differ: ${esc(g.ruleNote)}</div>` : ""}
            </div><span class="gapnum ${pts >= 3 ? "hot" : ""}">${pts.toFixed(1)}¢</span></div>`;
          })
          .join("");
      } catch {
        /* gaps are optional; leave the section hidden */
      }
    }

    bindSeg("period", "period", loadBoard);
    bindSeg("sort", "sort", loadBoard);
    $("minUsd").addEventListener("change", (e) => {
      st.min = Number(e.target.value);
      $("whales").innerHTML = "";
      loadWhales();
    });
    $("board").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-w]");
      if (tr) location.href = walletUrl(tr.dataset.w);
    });
    $("board").addEventListener("keydown", (e) => {
      const tr = e.target.closest("tr[data-w]");
      if (tr && e.key === "Enter") location.href = walletUrl(tr.dataset.w);
    });

    loadBoard();
    loadWhales();
    loadGaps();
    setInterval(() => {
      if (!document.hidden) loadWhales();
    }, 30000);
  }

  // ---------- wallet page ----------
  async function initWallet() {
    const addr = (new URLSearchParams(location.search).get("addr") || "").trim();
    if (!WALLET_RE.test(addr)) {
      $("profileName").textContent = "Wallet not found";
      $("profileAddr").textContent = "Paste a full Polymarket wallet address in the search box above.";
      $("positions").innerHTML = stateRow(5, "No wallet to show.");
      $("trades").innerHTML = stateRow(5, "No wallet to show.");
      return;
    }
    $("profileAddr").textContent = addr;
    $("polyLink").href = `https://polymarket.com/profile/${addr}`;
    try {
      const d = await api(`/api/wallet?addr=${addr}`);
      const name = displayName(d.name, d.wallet);
      document.title = `${name} · Oddly Radar`;
      $("profileName").textContent = name;
      $("profileAvatar").outerHTML = avatar(d.wallet).replace('class="avatar"', 'class="avatar" id="profileAvatar"');
      const s = d.stats;
      $("stats").innerHTML = [
        ["Open positions", s.openPositions],
        ["Open value", money(s.openValue)],
        ["Unrealized P&L", `<span class="${s.openPnl >= 0 ? "up" : "dn"}">${money(s.openPnl, { sign: true })}</span>`],
        ["Positions in profit", s.winningShare == null ? "—" : Math.round(s.winningShare * 100) + "%"],
        ["Last trade", s.lastTradeAt ? ago(s.lastTradeAt) : "—"],
      ]
        .map(([k, v]) => `<div class="stat"><small>${k}</small><b>${v}</b></div>`)
        .join("");

      $("positions").innerHTML = d.positions.length
        ? d.positions
            .slice(0, 25)
            .map(
              (p) => `<tr><td class="mkt"><a href="${marketUrl(p)}" target="_blank" rel="noopener">${esc(p.title)}</a><small>${esc(p.outcome)}</small></td>
              <td class="r num">${cents(p.avgPrice)}</td><td class="r num">${cents(p.curPrice)}</td>
              <td class="r num">${money(p.currentValue)}</td>
              <td class="r num ${p.cashPnl >= 0 ? "up" : "dn"}">${money(p.cashPnl, { sign: true })}</td></tr>`,
            )
            .join("")
        : stateRow(5, "No open positions.");

      $("trades").innerHTML = d.trades.length
        ? d.trades
            .slice(0, 25)
            .map(
              (t) => `<tr><td class="mkt"><a href="${marketUrl(t)}" target="_blank" rel="noopener">${esc(t.title)}</a><small>${esc(t.outcome)}</small></td>
              <td><span class="pill ${t.side === "SELL" ? "sell" : "buy"}">${t.side === "SELL" ? "SOLD" : "BOUGHT"}</span></td>
              <td class="r num">${cents(t.price)}</td><td class="r num">${money(t.usd)}</td><td class="r muted">${ago(t.ts)}</td></tr>`,
            )
            .join("")
        : stateRow(5, "No recent trades.");

      const top = d.positions[0];
      const handle = CFG.xHandle ? ` via @${CFG.xHandle}` : "";
      const text = top
        ? `This Polymarket wallet holds ${money(s.openValue)} in open bets. Biggest: "${top.title}" (${top.outcome}).${handle}`
        : `Tracking this Polymarket wallet on Oddly Radar${handle}`;
      $("shareX").href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(location.href)}`;
    } catch (err) {
      $("positions").innerHTML = stateRow(5, err.message, true);
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

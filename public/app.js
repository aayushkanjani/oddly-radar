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
  const clock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  function hue(addr) {
    let h = 0;
    for (const c of String(addr)) h = (h * 31 + c.charCodeAt(0)) % 360;
    return h;
  }
  const safeImg = (url) => (url && /^https:\/\//.test(url) ? url : "");
  function avatar(wallet, image, extra = "") {
    const bg = `hsl(${hue(wallet)} 60% 48%)`;
    const src = safeImg(image);
    const inner = src
      ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
      : esc(String(wallet).slice(2, 4).toUpperCase());
    return `<span class="avatar ${extra}" style="background:${bg}">${inner}</span>`;
  }
  function micon(t) {
    const src = safeImg(t.icon);
    const letter = esc((t.title || "?").trim().charAt(0).toUpperCase());
    return `<span class="micon">${src ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(document.createTextNode('${letter}'))">` : letter}</span>`;
  }
  const displayName = (name, wallet) => (name && !/^0x[0-9a-f]{20,}/i.test(name) ? name : shortAddr(wallet));
  const PERIOD_WORD = { day: "today", week: "this week", month: "this month" };
  const PERIOD_SHORT = { day: "24h", week: "7d", month: "30d" };
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const walletUrl = (w) => `/wallet?addr=${encodeURIComponent(w)}`;
  const marketUrl = (t) =>
    (t.url && /^https:\/\//.test(t.url) && t.url) ||
    (t.eventSlug ? `https://polymarket.com/event/${encodeURIComponent(t.eventSlug)}` : t.slug ? `https://polymarket.com/market/${encodeURIComponent(t.slug)}` : "https://polymarket.com");
  const venueBadge = (t) => (t.venue === "Kalshi" ? `<span class="vb ks">Kalshi</span>` : `<span class="vb pm">Polymarket</span>`);
  const REFRESH_MS = 10000;
  const tradeKey = (t) => `${t.tx}:${t.wallet}:${t.outcome}:${t.size}`;
  const sideWord = (t) => (t.side === "SELL" ? "SOLD" : "BOUGHT");
  const sideClass = (t) => (t.side === "SELL" ? "sell" : "buy");

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
    const st = { period: "week", sort: "pnl", min: 10000, venue: "all", smartHours: 24 };
    const seen = new Set();
    let firstWhaleLoad = true;
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

    function podiumCard(t, place) {
      const byProfit = st.sort === "pnl";
      const main = byProfit ? money(t.pnl, { sign: true }) : money(t.volume);
      const side = byProfit ? `Volume <span>${money(t.volume)}</span>` : `Profit <span class="${t.pnl >= 0 ? "up" : "dn"}">${money(t.pnl, { sign: true })}</span>`;
      return `<a class="pcard p${place}" href="${walletUrl(t.wallet)}">
        <span class="medal">${place}</span>
        <div class="who">${avatar(t.wallet, t.image, "lg")}<div><b>${esc(displayName(t.name, t.wallet))}${t.verified ? '<span class="tick" title="Verified">✔</span>' : ""}</b><small>${esc(shortAddr(t.wallet))}${t.xUsername ? " · @" + esc(t.xUsername) : ""}</small></div></div>
        <span class="big" style="${byProfit ? "" : "color:var(--ink)"}">${main}</span>
        <div class="meta"><span>${side}</span><span>View bets →</span></div>
      </a>`;
    }

    async function loadBoard() {
      const tb = $("board");
      const pod = $("podium");
      tb.innerHTML = stateRow(4, "Loading traders…");
      pod.innerHTML = [2, 1, 3].map((p) => `<div class="pcard p${p}"><span class="skel" style="width:60%"></span><span class="skel" style="width:40%;height:26px"></span></div>`).join("");
      const byProfit = st.sort === "pnl";
      $("mainCol").textContent = byProfit ? "Profit" : "Volume";
      $("sideCol").textContent = byProfit ? "Volume" : "Profit";
      try {
        const { traders } = await api(`/api/leaderboard?period=${st.period}&sort=${st.sort}&limit=50`);
        if (!traders.length) {
          pod.innerHTML = "";
          tb.innerHTML = stateRow(4, "No traders for this period yet.");
          return;
        }
        const top = traders.slice(0, 3);
        // Desktop shows 2 · 1 · 3 so the winner stands in the middle; on phones CSS moves #1 first.
        const order = [top[1], top[0], top[2]].map((t, i) => (t ? podiumCard(t, [2, 1, 3][i]) : "")).join("");
        pod.innerHTML = order;

        const rest = traders.slice(3);
        const VISIBLE = 17; // ranks 4–20 before "Show all"
        $("board").classList.add("collapsed");
        $("showAll").hidden = rest.length <= VISIBLE;
        $("showAll").textContent = `Show all ${traders.length} traders`;
        const mainVal = (t) => (byProfit ? t.pnl : t.volume);
        const max = Math.max(1, ...rest.map((t) => Math.abs(mainVal(t))));
        tb.innerHTML = rest.length
          ? rest
              .map((t, i) => {
                const v = mainVal(t);
                const pct = Math.max(2, Math.round((Math.abs(v) / max) * 100));
                const mainTxt = byProfit ? money(v, { sign: true }) : money(v);
                const sideTxt = byProfit ? money(t.volume) : money(t.pnl, { sign: true });
                const mainCls = byProfit ? (v >= 0 ? "up" : "dn") : "";
                const sideCls = byProfit ? "" : t.pnl >= 0 ? "up" : "dn";
                return `<tr class="link${i >= VISIBLE ? " more" : ""}" data-w="${esc(t.wallet)}" tabindex="0">
                  <td class="rank">${t.rank}</td>
                  <td><div class="who">${avatar(t.wallet, t.image)}<div><b>${esc(displayName(t.name, t.wallet))}${t.verified ? '<span class="tick" title="Verified">✔</span>' : ""}</b><small>${esc(shortAddr(t.wallet))}${t.xUsername ? " · @" + esc(t.xUsername) : ""}</small></div></div></td>
                  <td class="r"><div class="pnlcell"><span class="num ${mainCls}">${mainTxt}</span><span class="bar"><i style="width:${pct}%"></i></span></div></td>
                  <td class="r num ${sideCls}">${sideTxt}</td></tr>`;
              })
              .join("")
          : stateRow(4, "Only three traders on the board for this period.");
      } catch (err) {
        pod.innerHTML = "";
        tb.innerHTML = stateRow(4, err.message, true);
      }
    }

    async function loadPulseTop() {
      try {
        const { traders } = await api("/api/leaderboard?period=week&sort=pnl&limit=1");
        const t = traders[0];
        if (!t) throw new Error("none");
        $("pTop").textContent = money(t.pnl, { sign: true });
        $("pTopSub").innerHTML = `<a href="${walletUrl(t.wallet)}">${esc(displayName(t.name, t.wallet))}</a> · ${esc(money(t.volume))} traded`;
      } catch {
        $("pTop").textContent = "—";
      }
    }

    // Polymarket's whale trades usually arrive faster than Kalshi's, so the newest 20 can all be
    // Polymarket. Alternate venues so both always scroll past.
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
          (t) => `<a class="tk" href="${esc(marketUrl(t))}" target="_blank" rel="noopener"><span class="dot"></span>${venueBadge(t)}<b>${money(t.usd)}</b><span class="side ${sideClass(t)}">${sideWord(t)} ${esc(clip(t.outcome || "", 14))}</span><span>${esc(clip(t.title, 46))}</span></a>`,
        )
        .join("");
      // Two copies so the -50% marquee loops without a gap.
      $("ticker").innerHTML = items + items;
    }

    function renderPulse(trades) {
      if (!trades.length) {
        $("pVol").textContent = "—";
        $("pBig").textContent = "—";
        return;
      }
      const total = trades.reduce((s, t) => s + t.usd, 0);
      const oldest = Math.min(...trades.map((t) => t.ts));
      const big = trades.reduce((a, b) => (b.usd > a.usd ? b : a));
      const venues = new Set(trades.map((t) => t.venue || "Polymarket"));
      $("pVol").textContent = money(total);
      $("pVolSub").textContent = `${trades.length} trades over ${money(st.min)} since ${clock(oldest)} · ${[...venues].join(" + ")}`;
      $("pBig").textContent = money(big.usd);
      $("pBigSub").innerHTML = `${sideWord(big).toLowerCase()} ${esc(big.outcome)} on <a href="${esc(marketUrl(big))}" target="_blank" rel="noopener">${esc(clip(big.title, 48))}</a> · ${esc(big.venue || "Polymarket")}`;
    }

    function renderWhales() {
      const ul = $("whales");
      const trades = lastBatch.trades.filter((t) => st.venue === "all" || (t.venue || "Polymarket") === st.venue);
      if (!trades.length) {
        const where = st.venue === "all" ? "" : ` on ${st.venue}`;
        ul.innerHTML = `<li class="state">No trades over ${money(st.min)}${where} in the last hour or so. Try a lower minimum.</li>`;
        return;
      }
      const max = Math.max(...trades.map((t) => t.usd));
      ul.innerHTML = trades
        .map((t) => {
          const key = tradeKey(t);
          const fresh = !firstWhaleLoad && !seen.has(key);
          seen.add(key);
          const pct = Math.max(4, Math.round((t.usd / max) * 100));
          const who =
            t.venue === "Kalshi"
              ? `<span>anonymous${t.fills > 1 ? ` · ${t.fills} fills` : ""}</span>`
              : `<a href="${walletUrl(t.wallet)}">${esc(displayName(t.name, t.wallet))}</a>`;
          return `<li class="whale${fresh ? " fresh" : ""}">
            ${micon(t)}
            <div style="min-width:0">
              <div class="row1"><span class="amt">${money(t.usd)}</span><span class="pill ${sideClass(t)}">${sideWord(t)} ${esc(t.outcome || "")}</span></div>
              <a class="q" href="${esc(marketUrl(t))}" target="_blank" rel="noopener">${esc(t.title)}</a>
              <div class="meta">${venueBadge(t)}<span>at ${cents(t.price)}</span>${who}<span>${ago(t.ts)}</span></div>
              <div class="size"><i class="${sideClass(t)}" style="width:${pct}%"></i></div>
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
        renderPulse(lastBatch.trades);
        renderWhales();
        const down = Object.keys(lastBatch.errors);
        const note = down.length ? ` · ${down.map((v) => v[0].toUpperCase() + v.slice(1)).join(", ")} unavailable right now` : "";
        $("whalesAt").textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " · refreshes every 10 seconds" + note;
      } catch (err) {
        ul.innerHTML = `<li class="state err">${esc(err.message)}</li>`;
      }
    }

    async function loadSmart() {
      const box = $("smart");
      box.innerHTML = Array.from({ length: 3 }, () => `<div class="scard"><span class="skel" style="width:80%"></span><span class="skel" style="width:50%;height:20px"></span><span class="skel" style="width:60%"></span></div>`).join("");
      try {
        const d = await api(`/api/smart?period=week&hours=${st.smartHours}&n=30`);
        const windowWord = { 6: "6 hours", 24: "24 hours", 72: "3 days" }[st.smartHours];
        $("smartMeta").textContent = `What the ${d.topN} most profitable traders this week bought in the last ${windowWord}` + (d.failed ? ` · ${d.failed} wallets couldn't be read` : "");
        if (!d.markets.length) {
          box.innerHTML = `<div class="state">No buying from the top ${d.topN} traders in the last ${windowWord}. Try a longer window.</div>`;
          return;
        }
        box.innerHTML = d.markets
          .map((m, i) => {
            const avs = m.buyers
              .map((b) => `<a href="${walletUrl(b.wallet)}" title="#${b.rank} ${esc(displayName(b.name, b.wallet))} · ${esc(money(b.net))}">${avatar(b.wallet, b.image)}</a>`)
              .join("");
            const word = m.buyerCount === 1 ? "top trader buying" : "top traders buying";
            return `<div class="scard">
              <div class="top">
                <span class="num-rank">${i + 1}</span>
                ${micon(m)}
                <div style="min-width:0">
                  <div class="title"><a href="${esc(marketUrl(m))}" target="_blank" rel="noopener">${esc(m.title)}</a></div>
                  <span class="pill buy" style="margin-top:6px">${esc(m.outcome)}</span>
                </div>
              </div>
              <div class="consensus"><span class="count"><b>${m.buyerCount}</b>${word}</span><span class="stackav">${avs}</span></div>
              <div class="figs">
                <span>Net bought <b class="up">${money(m.netUsd)}</b></span>
                ${m.avgEntry != null ? `<span>Avg entry <b>${cents(m.avgEntry)}</b></span>` : ""}
                <span>Last <b>${cents(m.lastPrice)}</b></span>
                <span>${ago(m.lastTs)}</span>
              </div>
            </div>`;
          })
          .join("");
      } catch (err) {
        box.innerHTML = `<div class="state err">${esc(err.message)}</div>`;
      }
    }

    async function loadGaps() {
      try {
        const { gaps, pairsConfigured } = await api("/api/gaps");
        if (!pairsConfigured) return; // section stays hidden until you add pairs in lib/pairs.js
        $("gapsSection").hidden = false;
        const box = $("gaps");
        if (!gaps.length) {
          box.innerHTML = `<div class="state">Couldn't load the matched markets right now.</div>`;
          return;
        }
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
    bindSeg("smartHours", "smartHours", loadSmart);
    bindSeg("venue", "venue", () => {
      firstWhaleLoad = true; // switching views shouldn't flash every card as "new"
      renderWhales();
    });
    $("minUsd").addEventListener("change", (e) => {
      st.min = Number(e.target.value);
      $("whales").innerHTML = "";
      firstWhaleLoad = true;
      seen.clear();
      loadWhales();
    });
    $("showAll").addEventListener("click", () => {
      const open = $("board").classList.toggle("collapsed") === false;
      $("showAll").textContent = open ? "Show fewer" : `Show all traders`;
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
    loadPulseTop();
    loadWhales();
    loadSmart();
    loadGaps();
    // Smart money changes slowly; refresh it every 3 minutes, matching its cache.
    setInterval(() => {
      if (!document.hidden) loadSmart();
    }, 180000);
    setInterval(() => {
      if (!document.hidden) loadWhales();
    }, REFRESH_MS);
    // Catch up immediately when the visitor comes back to the tab.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) loadWhales();
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
      <span class="num muted" style="font-size:12.5px;white-space:nowrap">${a.toFixed(0)}¢ → <b style="color:${color}">${c.toFixed(0)}¢</b></span>
    </div>`;
  }

  async function initWallet() {
    const addr = (new URLSearchParams(location.search).get("addr") || "").trim();
    if (!WALLET_RE.test(addr)) {
      $("profileName").textContent = "Wallet not found";
      $("profileAddr").textContent = "Paste a full Polymarket wallet address in the search box above.";
      $("positions").innerHTML = stateRow(4, "No wallet to show.");
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
      $("profileAvatar").outerHTML = avatar(d.wallet).replace('class="avatar "', 'class="avatar" id="profileAvatar"');

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
              (p) => `<tr><td class="mkt"><div class="mrow">${micon(p)}<div style="min-width:0"><a href="${marketUrl(p)}" target="_blank" rel="noopener">${esc(p.title)}</a><small>${esc(p.outcome)}${p.endDate ? " · ends " + esc(new Date(p.endDate).toLocaleDateString([], { day: "numeric", month: "short" })) : ""}</small></div></div></td>
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
              (t) => `<tr><td class="mkt"><div class="mrow">${micon(t)}<div style="min-width:0"><a href="${marketUrl(t)}" target="_blank" rel="noopener">${esc(t.title)}</a><small>${esc(t.outcome)}</small></div></div></td>
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
        text = `${name} is #${st.rank} on Polymarket ${PERIOD_WORD[st.period]}: ${money(st.pnl, { sign: true })} profit.` +
          (top ? ` Biggest open bet: ${bet}.` : "") + ` See every position${handle}:`;
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

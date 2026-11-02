// ---------- Chess Review Lab (phone app) ----------
"use strict";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const S = {
  games: new Map(),      // id -> meta
  data: new Map(),       // id -> {startFen, moves}
  cur: null,             // {id, meta, data, fens}
  p: 0, flip: false, better: false, hint: false, line: null,
  editing: null,
};
let dbReady = false;
const LS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } };
function toast(msg, ms = 3200) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- on-device storage (IndexedDB) ----------
const store = (() => {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      if (!("indexedDB" in window)) { rej(new Error("no-idb")); return; }
      const r = indexedDB.open("chess-review-lab", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("games")) d.createObjectStore("games");
        if (!d.objectStoreNames.contains("analyses")) d.createObjectStore("analyses");
        if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error || new Error("idb-open"));
      r.onblocked = () => rej(new Error("idb-blocked"));
    });
    dbp.catch(() => { dbp = null; });
    return dbp;
  }
  async function tx(name, mode, fn) {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(name, mode); const os = t.objectStore(name);
      let out; const r = fn(os);
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  return {
    get: (s, k) => tx(s, "readonly", os => os.get(k)),
    put: (s, k, v) => tx(s, "readwrite", os => os.put(v, k)),
    del: (s, k) => tx(s, "readwrite", os => os.delete(k)),
    async all(s) {
      const d = await open();
      return new Promise((res, rej) => {
        const out = new Map(); const t = d.transaction(s, "readonly");
        const c = t.objectStore(s).openCursor();
        c.onsuccess = () => { const cur = c.result; if (cur) { out.set(cur.key, cur.value); cur.continue(); } };
        t.oncomplete = () => res(out); t.onerror = () => rej(t.error);
      });
    },
    async putMany(entries) { // [[store, key, value]]
      const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction(["games", "analyses"], "readwrite");
        entries.forEach(([s, k, v]) => t.objectStore(s).put(v, k));
        t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      });
    },
  };
})();
async function saveGame(id, rec) {
  S.data.set(id, rec.data); S.games.set(id, rec.meta);
  await store.putMany([["analyses", id, rec.data], ["games", id, rec.meta]]);
}
async function loadData(id) {
  if (S.data.has(id)) return S.data.get(id);
  const d = await store.get("analyses", id);
  if (!d) throw new Error("This game's analysis is missing.");
  S.data.set(id, d); return d;
}
async function patchMeta(id, patch) {
  const m = { ...(S.games.get(id) || {}), ...patch };
  if (patch.notes) m.notes = { ...((S.games.get(id) || {}).notes || {}), ...patch.notes };
  S.games.set(id, m);
  if (S.cur && S.cur.id === id) S.cur.meta = m;
  await store.put("games", id, m);
}

// ---------- engine (Stockfish 19 lite, WASM, in a worker) ----------
class BrowserEngine {
  constructor() { this.q = Promise.resolve(); this.ready = null; this.ls = []; }
  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((res, rej) => {
      try { this.w = new Worker("stockfish-19-lite-single.js"); } catch (e) { rej(e); return; }
      this.w.onmessage = e => { const l = String(e.data); this.ls.slice().forEach(f => f(l)); };
      this.w.onerror = e => rej(new Error("The engine failed to load."));
      const t = setTimeout(() => rej(new Error("The engine took too long to load.")), 30000);
      const on = l => {
        if (l === "uciok") { this.send("setoption name Hash value 32"); this.send("isready"); }
        if (l === "readyok") { clearTimeout(t); this.off(on); res(); }
      };
      this.ls.push(on); this.send("uci");
    });
    this.ready.catch(() => { this.ready = null; });
    return this.ready;
  }
  off(f) { this.ls = this.ls.filter(x => x !== f); }
  send(c) { this.w.postMessage(c); }
  analyse(fen, depth) {
    const run = async () => {
      await this.start();
      return new Promise(res => {
        let last = { cp: 0, mate: null, pv: [] };
        const f = l => {
          if (l.startsWith("info ") && l.includes(" pv ")) {
            const m = l.match(/score (cp|mate) (-?\d+)/); const pv = l.split(" pv ")[1].trim().split(/\s+/);
            if (m) last = m[1] === "cp" ? { cp: +m[2], mate: null, pv } : { cp: null, mate: +m[2], pv };
          } else if (l.startsWith("bestmove")) {
            this.off(f);
            if (!last.pv.length) { const b = l.split(" ")[1]; if (b && b !== "(none)") last.pv = [b]; }
            res(last);
          }
        };
        this.ls.push(f); this.send("position fen " + fen); this.send("go depth " + depth);
      });
    };
    const p = this.q.then(run, run); this.q = p.catch(() => {}); return p;
  }
}
const engine = new BrowserEngine();


// ---------- library ----------
function sortedGames() {
  return [...S.games.entries()].sort((a, b) => (b[1].date || "").localeCompare(a[1].date || "") || (b[1].createdAt || "").localeCompare(a[1].createdAt || ""));
}
function oppName(m) { return m.side === "w" ? m.black : m.side === "b" ? m.white : null; }
function renderLibrary() {
  const list = sortedGames();
  const gl = $("#gameList"), pt = $("#patterns");
  $("#countNote").textContent = list.length ? `${list.length} game${list.length > 1 ? "s" : ""} saved on this device` : "";
  if (!list.length) {
    pt.innerHTML = "";
    gl.innerHTML = `<div class="card empty"><h2 style="font-size:20px">${dbReady ? "No games yet" : "Loading your games…"}</h2>
      <p class="note" style="max-width:52ch">Paste a game from chess.com and the engine will go through every move, mark your mistakes, and show what was better. Your patterns build up here as you add games.</p>
      <button class="btn primary" data-act="new">+ Analyze a game</button></div>`;
    return;
  }
  // patterns
  const mine = list.map(([, m]) => m).filter(m => m.side);
  const n = mine.length;
  const W = mine.filter(m => m.outcome === "win").length, L = mine.filter(m => m.outcome === "loss").length, D = mine.filter(m => m.outcome === "draw").length;
  const acc = n ? mine.reduce((a, m) => a + (m.acc?.[m.side] || 0), 0) / n : 0;
  const errs = n ? mine.reduce((a, m) => a + (m.counts?.[m.side]?.blunder || 0) + (m.counts?.[m.side]?.mistake || 0), 0) / n : 0;
  const tags = {}, phase = {};
  mine.forEach(m => { Object.entries(m.myTags || {}).forEach(([k, v]) => { if (!k.startsWith("no simple")) tags[k] = (tags[k] || 0) + v; }); Object.entries(m.myPhase || {}).forEach(([k, v]) => phase[k] = (phase[k] || 0) + v); });
  const top = Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const mx = top.length ? top[0][1] : 1;
  const ph = ["opening", "middlegame", "endgame"].map(k => [k, phase[k] || 0]);
  const pmx = Math.max(1, ...ph.map(x => x[1]));
  pt.innerHTML = n ? `
   <section class="card pcard"><h2>What to work on</h2>
    <p class="note">Most frequent problems in your mistakes, across ${n} game${n > 1 ? "s" : ""}.</p>
    <div class="bars">${top.map(([k, v]) => `<div class="brow"><span class="t">${esc(cap(k))}</span><span class="track"><i style="width:${(v / mx) * 100}%"></i></span><span class="c">${v}</span></div>`).join("") || '<p class="note">No mistakes flagged yet.</p>'}</div>
   </section>
   <section class="card pcard"><h2>Overview</h2>
    <div class="kpis"><div class="kpi"><b>${W}–${D}–${L}</b><span>W–D–L</span></div><div class="kpi"><b>${acc.toFixed(0)}%</b><span>Avg accuracy</span></div><div class="kpi"><b>${errs.toFixed(1)}</b><span>Mistakes + blunders / game</span></div></div>
    <div class="bars">${ph.map(([k, v]) => `<div class="brow"><span class="t">${cap(k)}</span><span class="track"><i style="width:${(v / pmx) * 100}%;background:var(--mistake)"></i></span><span class="c">${v}</span></div>`).join("")}</div>
    <p class="note">Where your mistakes and blunders happen.</p>
   </section>` : "";
  gl.innerHTML = list.map(([id, m]) => {
    const me = m.side; const c = me ? m.counts?.[me] : null;
    const resTxt = m.outcome === "win" ? "W" : m.outcome === "loss" ? "L" : m.outcome === "draw" ? "D" : esc(m.result);
    const title = me ? `vs ${esc(oppName(m))}${(me === "w" ? m.blackElo : m.whiteElo) ? ` (${esc(me === "w" ? m.blackElo : m.whiteElo)})` : ""}` : `${esc(m.white)} vs ${esc(m.black)}`;
    return `<button class="card gitem" data-open="${esc(id)}">
     <span class="res ${m.outcome || ""}">${resTxt}</span>
     <span class="gt"><b>${title}</b><span>${[m.date, me ? (me === "w" ? "White" : "Black") : "", m.opening, tcLabel(m.tc)].filter(Boolean).map(esc).join(" · ")}</span></span>
     <span class="gs">${m.fresh ? '<span class="pill new">New</span>' : ""}${me ? `<span>${Math.round(m.acc[me])}%</span>` : ""}<span class="row">${c && c.blunder ? `<span class="pill blunder">${c.blunder}??</span>` : ""}${c && c.mistake ? `<span class="pill mistake">${c.mistake}?</span>` : ""}</span></span>
    </button>`;
  }).join("");
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
function tcLabel(tc) { const m = String(tc || "").match(/^(\d+)(?:\+(\d+))?$/); if (!m) return tc || ""; const b = +m[1]; return `${b >= 60 ? Math.round(b / 60) : b + "s"}|${m[2] || 0}`; }

// ---------- game view ----------
async function openGame(id, push = true) {
  const meta = S.games.get(id); if (!meta) return;
  if (push) { try { history.pushState({ g: id }, "", "#" + encodeURIComponent(id)); } catch (e) {} }
  stopLine(); S.editing = null;
  if (meta.fresh) { meta.fresh = false; store.put("games", id, meta).catch(() => {}); }
  showView("game");
  $("#mPanel").innerHTML = '<p class="note">Loading game…</p>';
  try {
    const data = await loadData(id);
    const fens = [data.startFen, ...data.moves.slice(1).map(m => m.fen)];
    const last = data.moves[data.moves.length - 1];
    const ch = new Chess(last.fen); uciMove(ch, last.uci); fens.push(ch.fen());
    S.cur = { id, meta, data, fens };
    S.flip = meta.side === "b"; S.line = null; S.better = false; S.hint = false;
    const first = data.moves.findIndex(m => m.cls && m.cls !== "inaccuracy" && (!meta.side || m.color === meta.side));
    S.p = 0;
    renderGame();
    if (first >= 0) setP(first + 1);
  } catch (e) { $("#mPanel").innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
function showView(v) {
  $("#libView").hidden = v !== "lib"; $("#gameView").hidden = v !== "game";
  window.scrollTo(0, 0);
}
function renderGame() {
  const { meta } = S.cur;
  const me = meta.side;
  $("#gTitle").textContent = me ? `${meta.outcome ? cap(meta.outcome) : meta.result} vs ${oppName(meta)}` : `${meta.white} vs ${meta.black}`;
  $("#gMeta").innerHTML = [
    `${esc(meta.white)}${meta.whiteElo ? ` (${esc(meta.whiteElo)})` : ""} – ${esc(meta.black)}${meta.blackElo ? ` (${esc(meta.blackElo)})` : ""}`,
    esc(meta.result), esc(meta.date), esc(meta.opening), esc(tcLabel(meta.tc)), `depth ${esc(meta.depth)}`,
    /^https:\/\/(www\.)?chess\.com\//.test(meta.link || "") ? `<a href="${esc(meta.link)}" target="_blank" rel="noopener">View on chess.com ↗</a>` : "",
  ].filter(Boolean).map(x => `<span>${x}</span>`).join("");
  renderMoveList(); renderGraph(); renderSummary(); renderPosition();
}
function setP(p) {
  if (!S.cur) return;
  S.p = Math.max(0, Math.min(S.cur.data.moves.length, p));
  S.better = false; S.line = null; S.editing = null;
  renderPosition();
}
function curMove() { return S.p > 0 ? S.cur.data.moves[S.p - 1] : null; }
function renderPosition() {
  renderBoard(); renderPanel(); renderCoach(); markList(); markGraph(); renderLineBar();
  $("#hintBtn").classList.toggle("on", S.hint);
}

// board
function sqXY(sq) { // returns display col,row 0..7
  const f = sq.charCodeAt(0) - 97, r = +sq[1] - 1;
  return S.flip ? [7 - f, r] : [f, 7 - r];
}
function renderBoard() {
  const g = S.cur; const mv = curMove();
  let fen, last = null, arrows = [];
  if (S.line) {
    fen = S.line.fens[S.line.k]; if (S.line.k > 0) last = S.line.ucis[S.line.k - 1];
  } else if (S.better && mv) {
    fen = mv.fen; arrows.push([mv.uci, "bad"]); if (mv.bestUci && mv.bestUci !== mv.uci) arrows.push([mv.bestUci, "best"]);
  } else {
    fen = g.fens[S.p]; if (mv) last = mv.uci;
    if (mv && mv.cls && mv.refutUci && mv.refutUci[0]) arrows.push([mv.refutUci[0], "bad"]);
    if (S.hint) { const nx = g.data.moves[S.p]; if (nx && nx.bestUci) arrows.push([nx.bestUci, "hint"]); }
  }
  const ch = new Chess(fen); const bd = ch.board();
  const hl = last ? [last.slice(0, 2), last.slice(2, 4)] : [];
  let h = '<div class="sqs">';
  for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
    const f = S.flip ? 7 - col : col, r = S.flip ? row : 7 - row; // r: 0=rank1
    const name = "abcdefgh"[f] + (r + 1);
    const pc = bd[7 - r][f];
    const light = (f + r) % 2 === 1;
    h += `<div class="sq ${light ? "l" : "d"}${hl.includes(name) ? " hl" : ""}">`;
    if (col === 0) h += `<span class="co r">${r + 1}</span>`;
    if (row === 7) h += `<span class="co f">${"abcdefgh"[f]}</span>`;
    if (pc) h += `<span class="pc ${pc.color}${pc.type}"></span>`;
    h += "</div>";
  }
  h += "</div>";
  h += '<svg class="arrows" viewBox="0 0 800 800" aria-hidden="true">' + arrows.map(([u, cls]) => arrowSvg(u, cls)).join("") + "</svg>";
  const b = $("#board"); b.innerHTML = h;
  b.setAttribute("aria-label", "Position: " + fen);
  // eval bar
  let wW = 50, txt = "";
  if (!S.line) {
    if (S.better && mv) { wW = mv.color === "w" ? mv.wb : 100 - mv.wb; txt = mv.evB; }
    else if (mv) { wW = mv.wW; txt = mv.ev; } else { wW = g.meta.startW ?? 50; }
  } else { wW = S.line.wW ?? 50; }
  const eb = $("#evalBar"); eb.classList.toggle("flip", S.flip);
  eb.querySelector(".fill").style.height = wW + "%";
  const whiteAhead = wW >= 50;
  const lo = eb.querySelector(".lo"), hi = eb.querySelector(".hi");
  const raw = String(txt);
  const num = parseFloat(raw);
  const shown = /^#/.test(raw) ? "M" + raw.replace(/^#-?/, "") : isNaN(num) ? raw.replace(/^\+/, "") : Math.abs(num) >= 10 ? String(Math.round(Math.abs(num))) : Math.abs(num).toFixed(1);
  // label sits in the leader's color region
  const leaderAtBottom = whiteAhead !== S.flip;
  lo.textContent = leaderAtBottom ? shown : ""; hi.textContent = leaderAtBottom ? "" : shown;
  lo.style.color = whiteAhead ? "var(--bar-b)" : "var(--bar-w)"; hi.style.color = whiteAhead ? "var(--bar-b)" : "var(--bar-w)";
}
function arrowSvg(u, cls) {
  if (!u || u.length < 4) return "";
  const [c1, r1] = sqXY(u.slice(0, 2)), [c2, r2] = sqXY(u.slice(2, 4));
  const x1 = c1 * 100 + 50, y1 = r1 * 100 + 50, x2 = c2 * 100 + 50, y2 = r2 * 100 + 50;
  const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
  const hx = x2 - ux * 30, hy = y2 - uy * 30; // head base
  const sx = x1 + ux * 18, sy = y1 + uy * 18;
  const px = -uy * 24, py = ux * 24;
  return `<g class="${cls}"><line x1="${sx}" y1="${sy}" x2="${hx}" y2="${hy}"/><polygon points="${x2 - ux * 4},${y2 - uy * 4} ${hx + px},${hy + py} ${hx - px},${hy - py}"/></g>`;
}

// move panel
const CLS = { blunder: ["Blunder", "??"], mistake: ["Mistake", "?"], inaccuracy: ["Inaccuracy", "?!"] };
function verdict(m) {
  if (m.cls) return [m.cls, CLS[m.cls][0]];
  if (m.isBest) return ["best", "Best move"];
  return ["good", m.drop < 3 ? "Good move" : "OK move"];
}
function moveLabel(m) { return `${m.no}${m.color === "w" ? "." : "…"} ${m.san}`; }
function renderPanel() {
  const g = S.cur, m = curMove(), el = $("#mPanel");
  if (!m) {
    el.innerHTML = `<div class="mtitle"><h2>Start</h2></div><p>Step through the game with the arrows or by tapping a move. Your mistakes are marked in the move list and on the graph.</p><p class="note">Tip: ◀ ? and ? ▶ jump straight between your mistakes.</p>`;
    return;
  }
  const [vc, vt] = verdict(m);
  const mine = !g.meta.side || m.color === g.meta.side;
  const who = g.meta.side ? (mine ? "Your move" : "Opponent's move") : (m.color === "w" ? "White's move" : "Black's move");
  const dn = m.wa < m.wb - 0.5;
  let h = `<div class="mtitle"><h2>${esc(moveLabel(m))}</h2><span class="badge ${vc}">${vt}</span><span class="who">${who}</span></div>
   <div class="evrow"><span>Eval ${esc(m.evB)} → ${esc(m.ev)}</span><span class="${dn ? "dn" : "up"}">${mine && g.meta.side ? "Your" : "Mover's"} winning chances ${Math.round(m.wb)}% → ${Math.round(m.wa)}%</span></div>`;
  h += '<div class="facts">';
  if (!m.isBest && m.best) {
    h += `<div class="fact"><span class="k">${m.cls ? "Better was" : "Engine preferred"}</span><span class="v"><b>${esc(m.best)}</b> · ${esc(m.line.slice(0, 6).join(" "))}</span>
      <span style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn sm" data-act="better">${S.better ? "Back to game" : "Show on board"}</button><button class="btn sm" data-act="playbest">Play line</button></span></div>`;
  }
  if (m.cls && m.refut && m.refut.length) {
    h += `<div class="fact"><span class="k">How it gets punished</span><span class="v">${esc(m.refut.slice(0, 6).join(" "))}</span>
      <button class="btn sm" data-act="playrefut">Play line</button></div>`;
  }
  if (m.cls && m.threat) {
    h += `<div class="fact"><span class="k">Threat before the move</span><span class="v">${esc(m.threat)}${m.tags.some(t => t.startsWith("ignored")) ? " · not addressed" : ""}</span></div>`;
  }
  if (m.spent != null || m.clk != null) {
    h += `<div class="fact"><span class="k">Clock</span><span class="v">${m.spent != null ? `${m.spent}s on this move · ` : ""}${m.clk != null ? fmtClock(m.clk) + " left" : ""}</span></div>`;
  }
  h += "</div>";
  if (m.cls && m.tags.length) h += `<div class="tags">${m.tags.map(t => `<span class="tag">${esc(cap(t))}</span>`).join("")}</div>`;
  if (m.cls && !S.better) h += `<p class="note">Red arrow: the reply that punishes ${esc(m.san)}. “Show on board” puts the better move (blue) next to yours (red).</p>`;
  el.innerHTML = h;
}
function fmtClock(s) { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, "0")}`; }

// engine lines
function startLine(fen, ucis, label, wW) {
  const ch = new Chess(fen); const fens = [fen], sans = [], ok = [];
  for (const u of ucis) { const r = uciMove(ch, u); if (!r) break; ok.push(u); sans.push(r.san); fens.push(ch.fen()); }
  if (!ok.length) return;
  stopLine();
  S.line = { fens, ucis: ok, sans, k: 0, label, wW };
  playLine();
}
let lineTimer = null;
function stopLine() { if (lineTimer) { clearInterval(lineTimer); lineTimer = null; } }
function playLine() {
  if (!S.line) return;
  stopLine();
  if (S.line.k >= S.line.ucis.length) S.line.k = 0;
  const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  lineTimer = setInterval(() => {
    if (!S.line) { stopLine(); return; }
    S.line.k++;
    if (S.line.k >= S.line.ucis.length) stopLine();
    renderBoard(); renderLineBar();
  }, reduce ? 1600 : 1100);
  renderBoard(); renderLineBar();
}
function lineStep(k) {
  if (!S.line) return;
  stopLine();
  S.line.k = Math.max(0, Math.min(S.line.ucis.length, k));
  renderBoard(); renderLineBar();
}
function renderLineBar() {
  const lb = $("#lineBar");
  if (!S.line) { stopLine(); lb.hidden = true; lb.innerHTML = ""; return; }
  lb.hidden = false;
  const L = S.line;
  const fen0 = L.fens[0]; const white0 = fen0.split(" ")[1] === "w"; let no = +fen0.split(" ")[5];
  const chips = L.sans.map((s, i) => {
    const isW = white0 ? i % 2 === 0 : i % 2 === 1; const n = no + Math.floor((i + (white0 ? 0 : 1)) / 2);
    const pre = isW ? `${n}.` : (i === 0 ? `${n}…` : "");
    return `<button class="chip${i + 1 === L.k ? " on" : ""}" data-lk="${i + 1}">${pre}${esc(s)}</button>`;
  }).join("");
  lb.innerHTML = `<div class="top"><b>${esc(L.label)}</b><span style="display:flex;gap:6px"><button class="ib" data-act="lprev" aria-label="Back in line">‹</button><button class="ib" data-act="lplay" aria-label="${lineTimer ? "Pause" : L.k >= L.ucis.length ? "Replay" : "Play"}">${lineTimer ? "❚❚" : L.k >= L.ucis.length ? "↺" : "▶"}</button><button class="ib" data-act="lnext" aria-label="Forward in line">›</button><button class="btn sm" data-act="lexit">Done</button></span></div><div class="chips">${chips}</div>`;
}

// move list
function renderMoveList() {
  const ms = S.cur.data.moves; let h = "";
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i];
    if (m.color === "w" || i === 0) {
      h += `<div class="mrow"><span class="n">${m.no}.</span>`;
      if (m.color === "b") h += `<span></span>`;
    }
    h += `<button class="mv" data-ply="${m.ply}">${esc(m.san)}${m.cls ? `<i class="${m.cls}">${CLS[m.cls][1]}</i>` : ""}</button>`;
    if (m.color === "b" || i === ms.length - 1) { if (m.color === "w") h += "<span></span>"; h += "</div>"; }
  }
  $("#mList").innerHTML = h;
}
function markList() {
  const list = $("#mList");
  list.querySelectorAll(".mv.on").forEach(b => b.classList.remove("on"));
  const b = list.querySelector(`.mv[data-ply="${S.p}"]`);
  if (b) { b.classList.add("on"); const top = b.offsetTop - list.offsetTop; if (top < list.scrollTop + 10 || top > list.scrollTop + list.clientHeight - 40) list.scrollTop = top - list.clientHeight / 2; }
  else if (S.p === 0) list.scrollTop = 0;
}

// graph
const GW = 640, GH = 170, GP = { l: 30, r: 8, t: 8, b: 20 };
function gx(i, n) { return GP.l + (GW - GP.l - GP.r) * i / Math.max(1, n); }
function gy(v) { return GP.t + (GH - GP.t - GP.b) * (1 - v / 100); }
function renderGraph() {
  const g = S.cur, ms = g.data.moves, n = ms.length;
  const pts = [g.meta.startW ?? 50, ...ms.map(m => m.wW)];
  const line = pts.map((v, i) => `${gx(i, n).toFixed(1)},${gy(v).toFixed(1)}`).join(" ");
  const area = `M${gx(0, n)},${gy(0)} L${line.replace(/ /g, " L")} L${gx(n, n)},${gy(0)} Z`;
  let ax = "";
  [[100, "W"], [50, "="], [0, "B"]].forEach(([v, l]) => { ax += `<line class="g" x1="${GP.l}" x2="${GW - GP.r}" y1="${gy(v)}" y2="${gy(v)}"/><text class="ax" x="${GP.l - 6}" y="${gy(v) + 3}" text-anchor="end">${l}</text>`; });
  for (let mv = 10; mv * 2 <= n; mv += 10) ax += `<text class="ax" x="${gx(mv * 2, n)}" y="${GH - 6}" text-anchor="middle">${mv}</text>`;
  const dots = ms.filter(m => m.cls && m.cls !== "inaccuracy").map(m => {
    const mine = !g.meta.side || m.color === g.meta.side;
    return `<circle class="d-${m.cls}" cx="${gx(m.ply, n).toFixed(1)}" cy="${gy(m.wW).toFixed(1)}" r="${mine ? 5 : 3.5}" opacity="${mine ? 1 : .55}"/>`;
  }).join("");
  $("#graph").innerHTML = `<svg viewBox="0 0 ${GW} ${GH}" role="img" aria-label="White's winning chances over the game">
   <rect class="abk" x="${GP.l}" y="${GP.t}" width="${GW - GP.l - GP.r}" height="${GH - GP.t - GP.b}"/>
   <path class="aw" d="${area}"/>${ax}<polyline class="ln" points="${line}"/>
   <line id="gCur" class="cur" x1="0" x2="0" y1="${GP.t}" y2="${GH - GP.b}"/>${dots}
   <rect class="frame" x="${GP.l}" y="${GP.t}" width="${GW - GP.l - GP.r}" height="${GH - GP.t - GP.b}"/></svg>`;
  $("#graph svg").addEventListener("click", e => {
    const r = e.currentTarget.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width * GW;
    setP(Math.round((x - GP.l) / (GW - GP.l - GP.r) * n));
  });
}
function markGraph() {
  const c = $("#gCur"); if (!c) return; const x = gx(S.p, S.cur.data.moves.length).toFixed(1);
  c.setAttribute("x1", x); c.setAttribute("x2", x);
}

// summary
function renderSummary() {
  const g = S.cur, m = g.meta, me = m.side;
  const row = (lbl, w, b) => `<span>${lbl}</span><span class="num">${w}</span><span class="num">${b}</span>`;
  const cw = m.counts.w, cb = m.counts.b;
  const keys = g.data.moves.filter(x => x.cls && x.cls !== "inaccuracy" && (!me || x.color === me));
  $("#sumBox").innerHTML = `<h3 style="font-size:17px">Game summary</h3>
   <div class="sumgrid"><span></span><span class="h">${me === "w" ? "You" : "White"}</span><span class="h">${me === "b" ? "You" : "Black"}</span>
    ${row("Accuracy", Math.round(m.acc.w) + "%", Math.round(m.acc.b) + "%")}${row("Blunders ??", cw.blunder, cb.blunder)}${row("Mistakes ?", cw.mistake, cb.mistake)}${row("Inaccuracies ?!", cw.inaccuracy, cb.inaccuracy)}</div>
   <div style="display:grid;gap:6px"><span class="eyebrow">${me ? "Your" : "Key"} mistakes</span>
    <div class="keys">${keys.map(x => `<button class="chip" data-ply-jump="${x.ply}">${esc(moveLabel(x))}${CLS[x.cls][1]}</button>`).join("") || '<span class="note">None. Clean game.</span>'}</div></div>`;
}


// ---------- coach: hand off to Claude, keep notes ----------
function movesText(ms, upTo) {
  let s = "";
  ms.slice(0, upTo).forEach(m => { s += (m.color === "w" ? `${m.no}. ` : (s ? "" : `${m.no}... `)) + m.san + " "; });
  return s.trim();
}
function coachRules(meta) {
  const me = meta.side ? (meta.side === "w" ? meta.white : meta.black) : "the student";
  const elo = meta.side ? (meta.side === "w" ? meta.whiteElo : meta.blackElo) : "";
  return `Act as my grandmaster-level chess coach. I'm ${me}${elo ? `, rated about ${elo}` : ""}; explain at my level, in plain language.
Use the Stockfish analysis below as the ground truth. Don't invent evaluations or lines that aren't in it; if you want to discuss a different move, say it would need an engine check (or check it with your tools if you have them).
Focus on the thinking error behind a bad move (missed threat, didn't check captures, rushed, wrong plan) and the idea behind the better move, not just the move.`;
}
function gameLine(meta) {
  return `Game: ${meta.white}${meta.whiteElo ? ` (${meta.whiteElo})` : ""} vs ${meta.black}${meta.blackElo ? ` (${meta.blackElo})` : ""}, ${meta.result}${meta.opening ? `, ${meta.opening}` : ""}, time control ${meta.tc || "unknown"}.${meta.side ? ` I played ${meta.side === "w" ? "White" : "Black"}.` : ""}`;
}
function coachMovePrompt(g, m) {
  const meta = g.meta;
  const who = meta.side ? (m.color === meta.side ? "my move" : "my opponent's move") : (m.color === "w" ? "White's move" : "Black's move");
  return `${coachRules(meta)}

${gameLine(meta)}
Moves so far: ${movesText(g.data.moves, m.ply)}

Please review ${moveLabel(m)} (${who}).
Position before the move (FEN): ${m.fen}
Stockfish verdict: ${m.cls ? CLS[m.cls][0] : m.isBest ? "best move" : "fine"}. Winning chances for the side that moved: ${Math.round(m.wb)}% before, ${Math.round(m.wa)}% after.
Evaluation (White's view, pawns): before ${m.evB}, after ${m.ev}.
Best move: ${m.best}. Best line: ${m.line.join(" ")}
Opponent's best reply after the move played: ${m.refut.join(" ") || "none"}
${m.threat ? `What the opponent was threatening before the move: ${m.threat}\n` : ""}${m.tags.length ? `Engine motif hints (heuristic): ${m.tags.join("; ")}\n` : ""}${m.spent != null ? `Time spent: ${m.spent}s, clock after: ${fmtClock(m.clk)}\n` : ""}
Explain what this move does, ${m.cls ? "why it's a mistake and how it gets punished" : "whether it was good"}, what was better and why, and the habit to take away. Keep it under 200 words.`;
}
function coachSummaryPrompt(g, short) {
  const meta = g.meta, ms = g.data.moves;
  const flagged = ms.filter(m => m.cls && m.cls !== "inaccuracy").map(m =>
    `${moveLabel(m)} (${m.color === meta.side ? "me" : "opponent"}) ${CLS[m.cls][0]}: chances ${Math.round(m.wb)}%→${Math.round(m.wa)}%, best ${m.best} (${m.line.slice(0, 5).join(" ")}), punished by ${m.refut.slice(0, 5).join(" ")}${short ? "" : `; hints: ${m.tags.join("; ")}`}`).join("\n");
  return `${coachRules(meta)}

${gameLine(meta)}${meta.side ? ` Accuracy: me ${meta.acc[meta.side]}%, opponent ${meta.acc[meta.side === "w" ? "b" : "w"]}%.` : ""}
Moves: ${movesText(ms, ms.length)}

Mistakes and blunders Stockfish found:
${flagged || "none"}

Write my post-game summary: where the game was decided, how my opening and middlegame went, and my three most important lessons as three short numbered sentences at the end. Keep it under 250 words.`;
}
function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).catch(() => fallbackCopy(text)); return; }
  } catch (e) {}
  fallbackCopy(text);
}
function fallbackCopy(text) {
  const ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", "");
  ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); } catch (e) {} ta.remove();
}
function askClaude(prompt, shortPrompt) {
  copyText(prompt);
  let q = prompt;
  if (encodeURIComponent(q).length > 7000 && shortPrompt) q = shortPrompt;
  if (encodeURIComponent(q).length > 7000) q = q.slice(0, 2400);
  const url = "https://claude.ai/new?q=" + encodeURIComponent(q);
  const w = window.open(url, "_blank", "noopener");
  if (w === undefined) location.href = url;
  toast("Question copied. If it isn't filled in, paste it into Claude. Paste the answer back here as a note.", 5200);
}
function renderCoach() {
  const box = $("#coachBox"); const g = S.cur; const m = curMove();
  const key = m ? String(m.ply) : "summary";
  const text = m ? (g.meta.notes || {})[m.ply] : g.meta.summary;
  const editing = S.editing === key;
  const title = m ? "Coach notes" : "Game summary";
  const empty = m
    ? `Ask Claude to explain ${esc(moveLabel(m))}. Claude opens with the engine analysis filled in; paste the answer back here to keep it.`
    : "Ask Claude for a write-up of how the game was decided and the lessons to take from it.";
  box.innerHTML = `<h3>${title}</h3>
   ${editing ? `<div class="notebox"><label for="noteIn" class="note" style="font-weight:600">Paste Claude's answer or write your own note</label><textarea id="noteIn">${esc(text || "")}</textarea>
      <div class="coachacts"><button class="btn primary" data-act="savenote">Save note</button><button class="btn ghost" data-act="cancelnote">Cancel</button></div></div>`
     : `${text ? `<p class="coachtext">${esc(text)}</p>` : `<p class="note">${empty}</p>`}
       <div class="coachacts"><button class="btn primary" data-act="ask">${m ? "Ask Claude about this move" : "Ask Claude for a summary"}</button><button class="btn" data-act="editnote">${text ? "Edit note" : "Add note"}</button></div>`}`;
  if (editing) setTimeout(() => { const t = $("#noteIn"); if (t) t.focus(); }, 30);
}
async function saveNote() {
  const g = S.cur; const m = curMove(); const v = ($("#noteIn")?.value || "").trim();
  try {
    if (m) await patchMeta(g.id, { notes: { [m.ply]: v } });
    else await patchMeta(g.id, { summary: v });
    toast("Note saved");
  } catch (e) { toast("Couldn't save the note on this device."); }
  S.editing = null; renderCoach();
}

// ---------- analyze sheet ----------
let cancelTok = null, wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && cancelTok) keepAwake(true); });
function openSheet(prefill) {
  $("#sheet").hidden = false; $("#sheetErr").hidden = true; $("#progWrap").hidden = true; $("#pasteNote").textContent = "";
  const u = LS("crl-user"); if (u) $("#userIn").value = u;
  const d = LS("crl-depth"); if (d) $("#depthIn").value = d;
  if (prefill) $("#pgnIn").value = prefill;
  $("#pasteBtn").hidden = !(navigator.clipboard && navigator.clipboard.readText);
}
function closeSheet() { if (cancelTok) cancelTok.v = true; $("#sheet").hidden = true; keepAwake(false); }
async function pasteClipboard() {
  try {
    const t = await navigator.clipboard.readText();
    if (!t || !t.trim()) { $("#pasteNote").textContent = "Your clipboard is empty. Copy the PGN in chess.com first."; return; }
    $("#pgnIn").value = t.trim();
    const n = splitGames(t).length;
    $("#pasteNote").textContent = n ? `Pasted ${n} game${n > 1 ? "s" : ""}.` : "That doesn't look like a PGN. In chess.com choose Share → PGN.";
  } catch (e) { $("#pasteNote").textContent = "Paste was blocked. Long-press the box below and choose Paste."; }
}
async function runAnalysis() {
  const err = $("#sheetErr"); err.hidden = true;
  const text = $("#pgnIn").value;
  let games;
  try {
    if (/^\s*https?:\/\/\S+\s*$/.test(text)) throw new Error("That's a link, not the moves. In chess.com choose Share → PGN → Copy instead.");
    games = splitGames(text).map(parseGame);
    if (!games.length) throw new Error("Paste a game first. It should look like 1. e4 e5 2. Nf3 …");
  } catch (e) { err.textContent = e.message; err.hidden = false; return; }
  const user = $("#userIn").value.trim(); LS("crl-user", user);
  const depth = +$("#depthIn").value; LS("crl-depth", String(depth));
  const forced = $("#sideIn").value || null;
  $("#goBtn").disabled = true; $("#progWrap").hidden = false;
  const bar = $("#progBar"), txt = $("#progTxt");
  bar.style.width = "0%";
  cancelTok = { v: false };
  keepAwake(true);
  let firstId = null;
  try {
    txt.textContent = "Loading the engine…";
    await engine.start();
    for (let gi = 0; gi < games.length; gi++) {
      const game = games[gi];
      const id = gameId(game);
      const label = games.length > 1 ? `Game ${gi + 1} of ${games.length}: ` : "";
      const t0 = Date.now();
      const rec = await analyzeGame(game, {
        player: forced ? "" : user, side: forced, depth, cancel: cancelTok,
        onProgress: (d, t) => {
          bar.style.width = (100 * d / t).toFixed(1) + "%";
          const el = (Date.now() - t0) / 1000, eta = d > 3 ? Math.max(0, el / d * (t - d)) : null;
          txt.textContent = `${label}analyzing move ${Math.min(Math.ceil(game.moves.length / 2), Math.ceil(d / 2))} of ${Math.ceil(game.moves.length / 2)}${eta != null ? ` · about ${Math.ceil(eta)}s left` : ""}`;
        },
      }, engine);
      const prev = S.games.get(id);
      if (prev) { rec.meta.notes = prev.notes || {}; rec.meta.summary = prev.summary || ""; }
      rec.meta.mkey = matchKey(game.headers.White, game.headers.Black, game.headers.Date, game.moves.map(m => m.uci));
      CC.recent = CC.recent.filter(x => x.mkey !== rec.meta.mkey);
      try { await saveGame(id, rec); }
      catch (e) { S.data.set(id, rec.data); S.games.set(id, rec.meta); toast("Analyzed, but this device wouldn't save it."); }
      if (!firstId) firstId = id;
    }
    $("#pgnIn").value = "";
    $("#sheet").hidden = true;
    renderLibrary();
    if (firstId) openGame(firstId);
  } catch (e) {
    if (e.message !== "cancelled") { err.textContent = e.message || "Something went wrong analyzing that game."; err.hidden = false; }
  } finally {
    $("#goBtn").disabled = false; cancelTok = null; if (!CC.running) keepAwake(false);
    if (!err.hidden) $("#progWrap").hidden = true;
  }
}

// ---------- backup / restore ----------
async function exportGames() {
  try {
    const [metas, datas] = await Promise.all([store.all("games"), store.all("analyses")]);
    const games = [...metas.entries()].filter(([id]) => datas.has(id)).map(([id, meta]) => ({ id, meta, data: datas.get(id) }));
    if (!games.length) { toast("No games to back up yet."); return; }
    const body = JSON.stringify({ app: "chess-review-lab", version: 1, exportedAt: new Date().toISOString(), games });
    const name = `chess-review-lab-backup-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([body], name, { type: "application/json" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "Chess Review Lab backup" }); return; }
      catch (e) { if (e && e.name === "AbortError") return; }
    }
    const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    toast(`Saved ${games.length} game${games.length > 1 ? "s" : ""} to ${name}`);
  } catch (e) { toast("Couldn't create the backup."); }
}
async function importBundle(obj, { overwrite = true } = {}) {
  if (!obj || !Array.isArray(obj.games)) throw new Error("That file isn't a Chess Review Lab backup.");
  const entries = []; let n = 0;
  for (const g of obj.games) {
    if (!g || typeof g.id !== "string" || !g.meta || !g.data || !Array.isArray(g.data.moves)) continue;
    if (!overwrite && S.games.has(g.id)) continue;
    entries.push(["games", g.id, g.meta], ["analyses", g.id, g.data]);
    S.games.set(g.id, g.meta); S.data.set(g.id, g.data); n++;
  }
  if (entries.length) await store.putMany(entries);
  return n;
}
async function importFile(file) {
  try {
    const obj = JSON.parse(await file.text());
    const n = await importBundle(obj);
    renderLibrary(); toast(n ? `Restored ${n} game${n > 1 ? "s" : ""}` : "No games found in that file.");
  } catch (e) { toast(e.message && !/JSON/.test(e.message) ? e.message : "That file isn't a Chess Review Lab backup."); }
}

// ---------- events ----------
document.addEventListener("click", e => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.dataset.open) return openGame(t.dataset.open);
  if (t.dataset.ply) return setP(+t.dataset.ply);
  if (t.dataset.plyJump) return setP(+t.dataset.plyJump);
  if (t.dataset.lk && S.line) return lineStep(+t.dataset.lk);
  const a = t.dataset.act; const m = S.cur && curMove();
  if (a === "new") return openSheet();
  if (a === "better" && m) { S.better = !S.better; S.line = null; renderBoard(); renderPanel(); renderLineBar(); return; }
  if (a === "playbest" && m) { S.better = false; startLine(m.fen, m.lineUci || [], `Engine line instead of ${m.san}`, m.color === "w" ? m.wb : 100 - m.wb); renderPanel(); return; }
  if (a === "playrefut" && m) { S.better = false; startLine(S.cur.fens[S.p], m.refutUci || [], `How ${m.san} gets punished`, m.wW); renderPanel(); return; }
  if (a === "lprev" && S.line) return lineStep(S.line.k - 1);
  if (a === "lnext" && S.line) return lineStep(S.line.k + 1);
  if (a === "lplay" && S.line) { if (lineTimer) { stopLine(); renderLineBar(); } else playLine(); return; }
  if (a === "lexit") { S.line = null; renderBoard(); renderLineBar(); return; }
  if (a === "ask" && S.cur) { return m ? askClaude(coachMovePrompt(S.cur, m)) : askClaude(coachSummaryPrompt(S.cur, false), coachSummaryPrompt(S.cur, true)); }
  if (a === "editnote") { S.editing = m ? String(m.ply) : "summary"; renderCoach(); return; }
  if (a === "cancelnote") { S.editing = null; renderCoach(); return; }
  if (a === "savenote") return saveNote();
});
function goHome() {
  if (history.state && history.state.g) history.back();
  else { showView("lib"); renderLibrary(); }
}
$("#newBtn").onclick = () => openSheet();
$("#homeBtn").onclick = goHome;
$("#backBtn").onclick = goHome;
$("#cancelBtn").onclick = closeSheet;
$("#goBtn").onclick = runAnalysis;
$("#pasteBtn").onclick = pasteClipboard;
$("#sheet").addEventListener("click", e => { if (e.target.id === "sheet" && !cancelTok) closeSheet(); });
$("#firstBtn").onclick = () => setP(0);
$("#prevBtn").onclick = () => setP(S.p - 1);
$("#nextBtn").onclick = () => setP(S.p + 1);
$("#lastBtn").onclick = () => setP(1e9);
function jumpErr(dir) {
  const g = S.cur; if (!g) return;
  const me = g.meta.side;
  const plies = g.data.moves.filter(m => m.cls && m.cls !== "inaccuracy" && (!me || m.color === me)).map(m => m.ply);
  const t = dir > 0 ? plies.find(p => p > S.p) : plies.reverse().find(p => p < S.p);
  if (t != null) setP(t); else toast(dir > 0 ? "No more mistakes after this point." : "No mistakes before this point.", 1800);
}
$("#prevErrBtn").onclick = () => jumpErr(-1);
$("#nextErrBtn").onclick = () => jumpErr(1);
$("#flipBtn").onclick = () => { S.flip = !S.flip; renderBoard(); };
$("#hintBtn").onclick = () => { S.hint = !S.hint; renderPosition(); };
$("#exportBtn").onclick = exportGames;
$("#importIn").onchange = e => { const f = e.target.files && e.target.files[0]; if (f) importFile(f); e.target.value = ""; };
let delArm = null;
$("#delBtn").onclick = async () => {
  const b = $("#delBtn");
  if (!delArm) { b.textContent = "Tap again to delete for good"; delArm = setTimeout(() => { delArm = null; b.textContent = "Delete this game"; }, 4000); return; }
  clearTimeout(delArm); delArm = null; b.textContent = "Delete this game";
  const id = S.cur.id;
  try { await store.del("games", id); await store.del("analyses", id); } catch (e) {}
  S.games.delete(id); S.data.delete(id); S.cur = null;
  goHome(); toast("Game deleted");
};
document.addEventListener("keydown", e => {
  if (!$("#sheet").hidden) { if (e.key === "Escape" && !cancelTok) closeSheet(); return; }
  if ($("#gameView").hidden || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  if (S.line && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { lineStep(S.line.k + (e.key === "ArrowRight" ? 1 : -1)); e.preventDefault(); return; }
  if (e.key === "ArrowLeft") { setP(S.p - 1); e.preventDefault(); }
  if (e.key === "ArrowRight") { setP(S.p + 1); e.preventDefault(); }
  if (e.key === "Home") setP(0);
  if (e.key === "End") setP(1e9);
});
(() => { // swipe on the board
  let x0 = null, y0 = null;
  const b = $("#board");
  b.addEventListener("touchstart", e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  b.addEventListener("touchend", e => {
    if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0; x0 = null;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
    const step = dx < 0 ? 1 : -1;
    if (S.line) lineStep(S.line.k + step); else setP(S.p + step);
  });
})();
window.addEventListener("popstate", ev => {
  if (!$("#sheet").hidden && !cancelTok) closeSheet();
  const st = ev.state;
  if (st && st.g && S.games.has(st.g)) openGame(st.g, false);
  else { S.cur = null; stopLine(); showView("lib"); renderLibrary(); }
});

// ---------- install + updates ----------
const APP_VERSION = 3;
let swReg = null;
async function checkForUpdate(manual) {
  try {
    const r = await fetch("version.json?t=" + Date.now(), { cache: "no-store" });
    const v = r.ok ? (await r.json()).version : null;
    if (swReg) await swReg.update().catch(() => {});
    if (v && v > APP_VERSION) {
      if (swReg && (swReg.waiting || swReg.installing)) { if (manual) toast("Downloading the update…"); }
      else if (manual) toast("Update found. It will be ready in a few seconds.");
    } else if (manual) toast("You have the latest version.");
  } catch (e) { if (manual) toast("Couldn't check for updates. Are you online?"); }
}
let deferredInstall = null;
const standalone = () => (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredInstall = e; $("#installBtn").hidden = false; });
window.addEventListener("appinstalled", () => { $("#installBtn").hidden = true; deferredInstall = null; toast("Installed. Open Chess Lab from your home screen."); });
$("#installBtn").onclick = async () => { if (!deferredInstall) return; deferredInstall.prompt(); try { await deferredInstall.userChoice; } catch (e) {} deferredInstall = null; $("#installBtn").hidden = true; };
if (!standalone() && /iPhone|iPad|iPod/.test(navigator.userAgent) && !LS("crl-ios-ok")) $("#iosNote").hidden = false;
$("#iosClose").onclick = () => { LS("crl-ios-ok", "1"); $("#iosNote").hidden = true; };
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  let reloading = false, wantUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (!wantUpdate || reloading) return; reloading = true; location.reload(); });
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(reg => {
    swReg = reg;
    reg.update().catch(() => {});
    const offer = w => {
      if (!w || !navigator.serviceWorker.controller) return;
      $("#updateNote").hidden = false;
      $("#updateBtn").onclick = () => { if (cancelTok) { toast("Finish the current analysis first."); return; } wantUpdate = true; w.postMessage("skipWaiting"); };
    };
    if (reg.waiting) offer(reg.waiting);
    reg.addEventListener("updatefound", () => { const w = reg.installing; if (w) w.addEventListener("statechange", () => { if (w.state === "installed") offer(w); }); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
  }).catch(() => {});
}


// ---------- chess.com account sync ----------
// Uses chess.com's public API (https://www.chess.com/news/view/published-data-api): no login needed.
const CC_API = "https://api.chess.com/pub/player/";
const CC = {
  cfg: null,          // {user, since, auto, depth, lastSync}
  recent: [],         // [{url, end, pgn, game, mkey, outcome, opp, oppElo, tclass, tc, date}]
  status: "",         // text shown in the card
  syncing: false,
  showAll: false,
  queue: [], running: null, cancel: null, done: 0, total: 0,
};
function ccLoad() { try { const v = JSON.parse(LS("crl-cc") || "null"); return v && v.user ? v : null; } catch (e) { return null; } }
function ccSave() { LS("crl-cc", JSON.stringify(CC.cfg)); }
const ccNorm = s => String(s || "").trim().toLowerCase();

// a key that matches the same game whether it was pasted or synced
function matchKey(white, black, date, ucis) {
  return [ccNorm(white), ccNorm(black), String(date || "").replace(/\./g, "-"), ucis.join("")].join("|");
}
async function libraryKeys() {
  const keys = new Set();
  let datas = null;
  for (const [id, m] of S.games) {
    if (m.mkey) { keys.add(m.mkey); continue; }
    if (!datas) { try { datas = await store.all("analyses"); } catch (e) { datas = new Map(); } }
    const d = S.data.get(id) || datas.get(id);
    if (!d) continue;
    m.mkey = matchKey(m.white, m.black, m.date, d.moves.map(x => x.uci));
    keys.add(m.mkey);
    store.put("games", id, m).catch(() => {});
  }
  return keys;
}
async function ccFetch(url) {
  let r;
  try { r = await fetch(url, { cache: "no-cache" }); }
  catch (e) { throw new Error(navigator.onLine === false ? "You're offline. Your saved games are still here." : "Couldn't reach chess.com. Check your connection and try again."); }
  if (r.status === 404) { const e = new Error("not_found"); e.code = 404; throw e; }
  if (r.status === 429) throw new Error("chess.com is busy right now. Try again in a minute.");
  if (!r.ok) throw new Error(`chess.com didn't answer (error ${r.status}). Try again later.`);
  return r.json();
}
const TCLASS = { bullet: "Bullet", blitz: "Blitz", rapid: "Rapid", daily: "Daily" };
async function ccSync({ quiet = false } = {}) {
  if (!CC.cfg || CC.syncing) return;
  CC.syncing = true; CC.status = "Checking chess.com…"; renderCC();
  try {
    const user = ccNorm(CC.cfg.user);
    const { archives = [] } = await ccFetch(CC_API + encodeURIComponent(user) + "/games/archives");
    const months = archives.slice(-2).reverse();
    const raw = [];
    for (const u of months) { const j = await ccFetch(u); (j.games || []).forEach(g => raw.push(g)); }
    const keys = await libraryKeys();
    const skip = new Set(CC.cfg.skip || []);
    const list = [];
    for (const g of raw) {
      if (!g || !g.pgn || (g.rules && g.rules !== "chess") || skip.has(g.url)) continue;
      let game;
      try { game = parseGame(splitGames(g.pgn)[0]); } catch (e) { continue; }
      const h = game.headers;
      const mkey = matchKey(h.White, h.Black, h.Date, game.moves.map(m => m.uci));
      if (keys.has(mkey)) continue;
      const meW = ccNorm(g.white && g.white.username) === user;
      const me = meW ? g.white : g.black, opp = meW ? g.black : g.white;
      const res = (me && me.result) || "";
      const outcome = res === "win" ? "win" : ["checkmated", "resigned", "timeout", "abandoned", "lose"].includes(res) ? "loss" : res ? "draw" : "";
      list.push({
        url: g.url, end: g.end_time || 0, pgn: g.pgn, game, mkey, outcome,
        opp: (opp && opp.username) || "?", oppElo: (opp && opp.rating) || "",
        tclass: TCLASS[g.time_class] || "", tc: g.time_control || "", date: (h.Date || "").replace(/\./g, "-"),
      });
    }
    list.sort((a, b) => b.end - a.end);
    CC.recent = list;
    CC.cfg.lastSync = Date.now();
    if (CC.cfg.since == null) {
      // first sync after linking: analyze the 3 most recent games, list the rest
      CC.cfg.since = list.length > 3 ? list[3].end : 0;
    }
    ccSave();
    CC.status = "";
    if (CC.cfg.auto) {
      const fresh = list.filter(x => x.end > CC.cfg.since);
      if (fresh.length) ccEnqueue(fresh.slice().reverse());
    }
  } catch (e) {
    CC.status = e.code === 404 ? `chess.com has no player named “${CC.cfg.user}”.` : e.message;
    if (!quiet) toast(CC.status, 4000);
  } finally {
    CC.syncing = false; renderCC();
  }
}
async function ccLink(name) {
  const err = $("#ccErr"); if (err) err.hidden = true;
  const user = ccNorm(name);
  if (!/^[a-z0-9_-]{3,25}$/.test(user)) { if (err) { err.textContent = "Enter your chess.com username (3–25 letters, numbers, - or _)."; err.hidden = false; } return; }
  const btn = $("#ccLinkBtn"); if (btn) { btn.disabled = true; btn.textContent = "Checking…"; }
  try {
    const p = await ccFetch(CC_API + encodeURIComponent(user));
    CC.cfg = { user: p.username || user, since: null, auto: true, depth: 14, lastSync: 0, skip: [] };
    ccSave(); LS("crl-user", CC.cfg.user);
    $("#userLine").textContent = `${CC.cfg.user} · Stockfish 19 review`;
    renderCC(); toast(`Linked ${CC.cfg.user}. Loading your games…`);
    ccSync();
  } catch (e) {
    if (err) { err.textContent = e.code === 404 ? `chess.com has no player named “${name}”. Check the spelling.` : e.message; err.hidden = false; }
    if (btn) { btn.disabled = false; btn.textContent = "Link account"; }
  }
}
function ccUnlink() {
  ccCancel(); CC.cfg = null; CC.recent = []; CC.status = "";
  try { localStorage.removeItem("crl-cc"); } catch (e) {}
  renderCC(); toast("chess.com account unlinked. Your analyzed games stay in the app.");
}

// ---------- analysis queue (runs in the background of the library) ----------
function ccEnqueue(items) {
  const have = new Set([...CC.queue.map(x => x.url), CC.running && CC.running.url]);
  items.forEach(x => { if (!have.has(x.url)) { CC.queue.push(x); have.add(x.url); CC.total++; } });
  renderCC();
  if (!CC.running) ccRun();
}
function ccCancel() {
  if (CC.cancel) CC.cancel.v = true;
  CC.queue = []; CC.total = 0; CC.done = 0;
}
async function ccRun() {
  keepAwake(true);
  while (CC.queue.length) {
    const item = CC.queue.shift();
    CC.running = item; CC.cancel = { v: false }; CC.pct = 0; renderCC();
    try {
      await engine.start();
      const rec = await analyzeGame(item.game, {
        player: CC.cfg ? CC.cfg.user : "", depth: (CC.cfg && CC.cfg.depth) || 14, cancel: CC.cancel,
        onProgress: (d, t) => { CC.pct = Math.round(100 * d / t); const b = $("#ccProg"); if (b) b.style.width = CC.pct + "%"; },
      }, engine);
      rec.meta.mkey = item.mkey; rec.meta.fresh = true; rec.meta.source = "chess.com";
      if (item.url) rec.meta.link = item.url;
      const id = gameId(item.game);
      const prev = S.games.get(id); if (prev) { rec.meta.notes = prev.notes || {}; rec.meta.summary = prev.summary || ""; }
      await saveGame(id, rec);
      CC.recent = CC.recent.filter(x => x.url !== item.url);
      CC.done++;
    } catch (e) {
      if (e.message === "cancelled") break;
      if (CC.cfg) { CC.cfg.skip = [...(CC.cfg.skip || []), item.url].slice(-200); ccSave(); }
      CC.recent = CC.recent.filter(x => x.url !== item.url);
    }
    CC.running = null;
    if (!$("#libView").hidden) renderLibrary(); else renderCC();
  }
  const n = CC.done;
  CC.running = null; CC.queue = []; CC.total = 0; CC.done = 0; CC.cancel = null;
  if (!cancelTok) keepAwake(false);
  renderCC();
  if (n) toast(`${n} new game${n > 1 ? "s" : ""} analyzed`);
}

// ---------- card ----------
function ago(ts) {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now"; if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`; return `${Math.round(s / 86400)} d ago`;
}
function renderCC() {
  const el = $("#ccCard"); if (!el) return;
  if (!CC.cfg) {
    el.innerHTML = `<h2>Link your chess.com account</h2>
     <p class="note">Your recent games load automatically, and new ones get analyzed each time you open the app.</p>
     <form id="ccForm" class="ccform"><input id="ccUser" aria-label="chess.com username" placeholder="chess.com username" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(LS("crl-user") || "hckymstr19")}"><button id="ccLinkBtn" class="btn primary">Link account</button></form>
     <p id="ccErr" class="err" hidden></p>`;
    $("#ccForm").addEventListener("submit", e => { e.preventDefault(); ccLink($("#ccUser").value); });
    return;
  }
  const c = CC.cfg;
  const busy = CC.running || CC.queue.length;
  const queued = new Set(CC.queue.map(x => x.url));
  const pend = CC.recent.filter(x => !queued.has(x.url) && !(CC.running && CC.running.url === x.url));
  const shown = CC.showAll ? pend : pend.slice(0, 5);
  const row = x => `<div class="ccrow">
     <span class="res sm ${x.outcome}">${x.outcome === "win" ? "W" : x.outcome === "loss" ? "L" : x.outcome === "draw" ? "D" : "?"}</span>
     <span class="gt"><b>vs ${esc(x.opp)}${x.oppElo ? ` (${esc(x.oppElo)})` : ""}</b><span>${[x.date, x.tclass, tcLabel(x.tc)].filter(Boolean).map(esc).join(" · ")}</span></span>
     <button class="btn sm" data-cc-analyze="${esc(x.url)}">Analyze</button></div>`;
  el.innerHTML = `<div class="cchead">
     <div class="gt"><b>chess.com · ${esc(c.user)}</b><span>${CC.syncing ? "Checking for new games…" : esc(CC.status) || `Synced ${ago(c.lastSync)}`}</span></div>
     <button class="btn sm" data-act="ccsync" ${CC.syncing ? "disabled" : ""}>Sync</button>
   </div>
   ${busy ? `<div class="ccq"><div class="gt"><b>Analyzing ${CC.done + 1} of ${CC.total}${CC.running ? `: vs ${esc(CC.running.opp)}` : ""}</b><span>Keep the app open. You can browse your games meanwhile.</span></div>
       <button class="btn sm ghost" data-act="ccstop">Stop</button><div class="prog" style="grid-column:1/-1"><i id="ccProg" style="width:${CC.pct || 0}%"></i></div></div>` : ""}
   ${pend.length ? `<div class="cclist"><div class="cclisthead"><span class="eyebrow">Not analyzed yet · ${pend.length}</span>${pend.length > 1 ? `<button class="btn sm" data-act="ccall">Analyze all</button>` : ""}</div>${shown.map(row).join("")}
       ${pend.length > 5 ? `<button class="btn sm ghost" data-act="ccmore">${CC.showAll ? "Show fewer" : `Show all ${pend.length}`}</button>` : ""}</div>`
     : (!CC.syncing && !busy && c.lastSync && !CC.status ? `<p class="note">You're up to date. Games you play on chess.com show up here.</p>` : "")}
   <details class="ccset"><summary>Sync settings</summary>
     <label class="chk"><input type="checkbox" id="ccAuto" ${c.auto ? "checked" : ""}> Analyze new games automatically</label>
     <label for="ccDepth">Depth for synced games<select id="ccDepth"><option value="12">Quick (12)</option><option value="14">Standard (14)</option><option value="16">Thorough (16)</option></select></label>
     <button class="btn sm ghost danger" data-act="ccunlink">Unlink chess.com account</button>
   </details>`;
  $("#ccDepth").value = String(c.depth || 14);
  $("#ccAuto").onchange = e => { c.auto = e.target.checked; ccSave(); if (c.auto) ccSync({ quiet: true }); };
  $("#ccDepth").onchange = e => { c.depth = +e.target.value; ccSave(); };
}
document.addEventListener("click", e => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.dataset.ccAnalyze) { const x = CC.recent.find(r => r.url === t.dataset.ccAnalyze); if (x) ccEnqueue([x]); return; }
  const a = t.dataset.act;
  if (a === "ccsync") ccSync();
  if (a === "ccstop") { ccCancel(); renderCC(); toast("Stopped. Unanalyzed games stay in the list."); }
  if (a === "ccall") { const queued = new Set(CC.queue.map(x => x.url)); ccEnqueue(CC.recent.filter(x => !queued.has(x.url)).slice().reverse()); }
  if (a === "ccmore") { CC.showAll = !CC.showAll; renderCC(); }
  if (a === "ccunlink") ccUnlink();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && CC.cfg && !CC.syncing && Date.now() - (CC.cfg.lastSync || 0) > 120000) ccSync({ quiet: true });
});
function ccInit() {
  CC.cfg = ccLoad();
  renderCC();
  if (CC.cfg) ccSync({ quiet: true });
}

// ---------- boot ----------
(async () => {
  const u = LS("crl-user") || "hckymstr19"; $("#userLine").textContent = `${u} · Stockfish 19 review`;
  try {
    const [metas, seeded] = await Promise.all([store.all("games"), store.get("kv", "seeded")]);
    S.games = metas;
    if (!seeded) {
      try {
        const r = await fetch("starter-games.json", { cache: "no-cache" });
        if (r.ok) await importBundle(await r.json(), { overwrite: false });
      } catch (e) {}
      await store.put("kv", "seeded", true);
    }
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  } catch (e) {
    $("#storeNote").hidden = false;
  }
  $("#checkUpd").onclick = () => checkForUpdate(true);
  checkForUpdate(false);
  dbReady = true;
  renderLibrary();
  ccInit();
  // shared from another app (Android share sheet)
  const qs = new URLSearchParams(location.search);
  const shared = [qs.get("text"), qs.get("title"), qs.get("url")].filter(Boolean).join("\n").trim();
  if (shared) { history.replaceState(null, "", location.pathname); openSheet(shared); return; }
  const h = decodeURIComponent(location.hash.slice(1));
  if (h && S.games.has(h)) { history.replaceState(null, "", location.pathname); openGame(h); }
})();

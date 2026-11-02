// ---------- Chess Review Lab: analysis core (no DOM) ----------
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const PNAME = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function material(ch, color) {
  let s = 0;
  for (const row of ch.board()) for (const sq of row) if (sq && sq.color === color) s += VAL[sq.type];
  return s;
}
function balance(ch, color) { return material(ch, color) - material(ch, color === "w" ? "b" : "w"); }
function uciMove(ch, u) { return u ? ch.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || "q" }) : null; }
function ucisToSans(fen, ucis, n = 8) {
  const ch = new Chess(fen); const out = [];
  for (const u of (ucis || []).slice(0, n)) { const m = uciMove(ch, u); if (!m) break; out.push(m.san); }
  return out;
}
function balAfter(fen, ucis, plies, color) {
  const ch = new Chess(fen);
  for (const u of (ucis || []).slice(0, plies)) { if (!uciMove(ch, u)) break; }
  return balance(ch, color);
}
function winPct(cp) { cp = Math.max(-1500, Math.min(1500, cp)); return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1); }
function moveAcc(drop) { return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * Math.max(0, drop)) - 3.1669)); }
// engine score {cp, mate} from side-to-move POV -> centipawns
function scoreCp(s) { if (s.mate != null) return s.mate > 0 ? 100000 - s.mate : -100000 - s.mate; return s.cp; }
function fmtScore(s, sign) { // sign=+1 if side to move is white
  if (s.mate != null) { const m = s.mate * sign; return m > 0 ? "#" + m : m < 0 ? "#-" + Math.abs(m) : "#"; }
  const v = (s.cp * sign) / 100; return (v >= 0 ? "+" : "") + v.toFixed(2);
}
function phaseOf(fen, moveNo) {
  const ch = new Chess(fen); let np = 0;
  for (const row of ch.board()) for (const sq of row) if (sq && sq.type !== "p" && sq.type !== "k") np += VAL[sq.type];
  if (np <= 26) return "endgame";
  if (moveNo <= 12) return "opening";
  return "middlegame";
}
function nullMoveFen(fen) {
  const p = fen.split(" "); p[1] = p[1] === "w" ? "b" : "w"; p[3] = "-"; return p.join(" ");
}
function forkTargets(fen, u) {
  const ch = new Chess(fen); const m = uciMove(ch, u); if (!m) return [];
  const piece = ch.get(m.to); if (!piece) return [];
  // squares attacked by the moved piece: probe with the mover to move again
  const probe = new Chess(nullMoveFen(ch.fen()));
  const hits = [];
  for (const mv of probe.moves({ verbose: true })) {
    if (mv.from !== m.to || !mv.captured) continue;
    const t = mv.captured;
    if (t === "k" || VAL[t] >= 3 || VAL[t] > VAL[piece.type]) hits.push(PNAME[t]);
  }
  // a king in check cannot be "captured" in the probe: count the check itself
  if (ch.in_check() && !hits.includes("king")) hits.push("king");
  return hits.length >= 2 ? [...new Set(hits)] : [];
}

// ---------- PGN ----------
function splitGames(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const games = []; let cur = null, inMoves = false;
  for (const raw of lines) {
    const line = raw.trim(); if (!line) continue;
    const h = line.match(/^\[(\w+)\s+"(.*)"\]$/);
    if (h) {
      if (!cur || inMoves) { cur = { headers: {}, text: "" }; games.push(cur); inMoves = false; }
      cur.headers[h[1]] = h[2];
    } else {
      if (!cur) { cur = { headers: {}, text: "" }; games.push(cur); }
      cur.text += " " + line.replace(/^%.*$/, ""); inMoves = true;
    }
  }
  return games.filter(g => g.text.trim());
}
function parseGame(g) {
  const t = g.text; const toks = []; let i = 0, depth = 0;
  while (i < t.length) {
    const c = t[i];
    if (c === "{") {
      const j = t.indexOf("}", i); const body = t.slice(i + 1, j < 0 ? t.length : j);
      if (depth === 0 && toks.length) {
        const m = body.match(/\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]/);
        if (m) toks[toks.length - 1].clk = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
      }
      i = j < 0 ? t.length : j + 1; continue;
    }
    if (c === "(") { depth++; i++; continue; }
    if (c === ")") { depth = Math.max(0, depth - 1); i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    let j = i; while (j < t.length && !/[\s{}()]/.test(t[j])) j++;
    const w = t.slice(i, j); i = j;
    if (depth > 0) continue;
    if (/^\d+\.+$/.test(w) || /^\$\d+$/.test(w) || /^(1-0|0-1|1\/2-1\/2|\*)$/.test(w)) continue;
    const san = w.replace(/^\d+\.+/, "").replace(/[!?]+$/, "");
    if (san) toks.push({ san });
  }
  const startFen = g.headers.FEN || START_FEN;
  const ch = new Chess(startFen);
  const moves = [];
  for (const tk of toks) {
    const before = ch.fen();
    const m = ch.move(tk.san, { sloppy: true });
    if (!m) {
      const no = Math.floor(moves.length / 2) + 1;
      throw new Error(`Couldn't read move ${no}${moves.length % 2 ? "..." : "."} "${tk.san}". Check the pasted moves.`);
    }
    moves.push({ san: m.san, uci: m.from + m.to + (m.promotion || ""), fen: before, fenAfter: ch.fen(), clk: tk.clk ?? null });
  }
  if (!moves.length) throw new Error("No moves found in that PGN.");
  return { headers: g.headers, startFen, moves };
}
function openingName(h) {
  if (h.Opening) return h.Opening;
  if (h.ECOUrl) return decodeURIComponent(h.ECOUrl.split("/").pop()).replace(/-/g, " ").replace(/\s+\d.*$/, "");
  return h.ECO || "";
}

// ---------- tags ----------
function tagsFor(fenBefore, played, best, afterInfo, mover) {
  const tags = [];
  const chA = new Chess(fenBefore); uciMove(chA, played); const fenAfter = chA.fen();
  const refut = afterInfo.pv || [], bestPv = best.pv || [];
  if (afterInfo.mate != null && afterInfo.mate > 0) tags.push(`allows forced mate in ${afterInfo.mate}`);
  if (afterInfo.mate === 0 && afterInfo.final) { /* game over */ }
  if (best.mate != null && best.mate > 0 && !(afterInfo.mate != null && afterInfo.mate < 0)) tags.push(`missed forced mate in ${best.mate}`);
  const pre = balance(new Chess(fenBefore), mover);
  const now = balance(chA, mover);
  const played6 = balAfter(fenBefore, [played, ...refut], 7, mover);
  const best6 = balAfter(fenBefore, bestPv, 7, mover);
  if (refut.length && Math.min(now, pre) - balAfter(fenAfter, refut, 4, mover) >= 2) {
    const first = refut[0]; const cap = chA.get(first.slice(2, 4));
    if (cap && cap.color === mover) {
      if (first.slice(2, 4) === played.slice(2, 4)) tags.push(`hangs the ${PNAME[cap.type]} it just moved`);
      else tags.push(`leaves the ${PNAME[cap.type]} on ${first.slice(2, 4)} undefended`);
    }
  }
  if (!tags.some(t => t.startsWith("hangs") || t.startsWith("leaves")) && best6 - played6 >= 2 && played6 < pre)
    tags.push(`loses about ${best6 - played6} points of material within a few moves`);
  if (refut.length) {
    const f = forkTargets(fenAfter, refut[0]);
    if (f.length) tags.push(`walks into a fork (${f.join(", ")})`);
    const b = new Chess(fenAfter); let checks = 0;
    refut.slice(0, 8).forEach((u, k) => { const m = uciMove(b, u); if (m && k % 2 === 0 && m.san.includes("+")) checks++; });
    if (checks >= 2) tags.push(`exposes the king (${checks} checks in the punishing line)`);
  }
  if (best6 - pre >= 2 && best6 - played6 >= 2) {
    tags.push(`missed a tactic winning about ${best6 - pre} points`);
    if (bestPv.length) {
      const f = forkTargets(fenBefore, bestPv[0]);
      if (f.length) tags.push(`missed a fork (${f.join(", ")})`);
      const cb = new Chess(fenBefore); const bm = uciMove(cb, bestPv[0]);
      const pb = new Chess(fenBefore); const pm = uciMove(pb, played);
      if (bm && bm.captured && !(pm && pm.captured)) tags.push("missed a capture");
    }
  }
  return tags;
}

function parseTC(tc) { const m = String(tc || "").match(/^(\d+)(?:\+(\d+))?/); return m ? [+m[1], +(m[2] || 0)] : [null, 0]; }
function classify(drop) { return drop >= 30 ? "blunder" : drop >= 20 ? "mistake" : drop >= 10 ? "inaccuracy" : null; }

// ---------- full game analysis ----------
// engine: {analyse(fen, depth) -> Promise<{cp, mate, pv:[uci]}>}
async function analyzeGame(game, opts, engine) {
  const { player = "", depth = 14, onProgress = () => {}, cancel = { v: false } } = opts;
  const h = game.headers;
  const p = player.trim().toLowerCase();
  const side = p && (h.White || "").toLowerCase() === p ? "w" : p && (h.Black || "").toLowerCase() === p ? "b" : (opts.side || null);
  const positions = [game.startFen, ...game.moves.map(m => m.fenAfter)];
  const n = game.moves.length;
  const total = positions.length + Math.ceil(n * 0.15);
  let done = 0;
  const infos = [];
  for (let i = 0; i < positions.length; i++) {
    if (cancel.v) throw new Error("cancelled");
    const ch = new Chess(positions[i]);
    infos.push(ch.game_over() ? null : await engine.analyse(positions[i], depth));
    onProgress(++done, total);
  }
  const [base, inc] = parseTC(h.TimeControl);
  const lastClock = { w: base, b: base };
  const moves = [];
  for (let i = 0; i < n; i++) {
    if (cancel.v) throw new Error("cancelled");
    const gm = game.moves[i];
    const before = new Chess(positions[i]); const after = new Chess(positions[i + 1]);
    const mover = before.turn(); const sign = mover === "w" ? 1 : -1;
    const best = infos[i];
    let afterInfo, cpAfter, evTxt, wW;
    if (infos[i + 1] == null) {
      if (after.in_checkmate()) { cpAfter = 100000; evTxt = mover === "w" ? "1-0" : "0-1"; }
      else { cpAfter = 0; evTxt = "½-½"; }
      afterInfo = { cp: -cpAfter, mate: null, pv: [] };
    } else {
      afterInfo = infos[i + 1];
      cpAfter = -scoreCp(afterInfo);
      evTxt = fmtScore(afterInfo, -sign);
    }
    let cpBest = scoreCp(best);
    if (gm.uci === best.pv[0] && Math.abs(cpAfter - cpBest) < 60) cpAfter = Math.max(cpAfter, cpBest);
    const wb = winPct(cpBest), wa = winPct(cpAfter);
    const drop = Math.max(0, wb - wa);
    let cls = classify(drop);
    if (before.moves().length === 1) cls = null;
    if ((cls === null || cls === "inaccuracy") && wb >= 15 && wb <= 85 && cpBest - cpAfter >= 300) cls = "mistake";
    wW = mover === "w" ? wa : 100 - wa;
    let spent = null;
    if (gm.clk != null && lastClock[mover] != null) spent = Math.round((lastClock[mover] - gm.clk + inc) * 10) / 10;
    if (gm.clk != null) lastClock[mover] = gm.clk;
    const rec = {
      ply: i + 1, no: before.history ? Math.floor(i / 2) + 1 : 0, color: mover,
      san: gm.san, uci: gm.uci, fen: positions[i],
      best: ucisToSans(positions[i], [best.pv[0]], 1)[0] || "", bestUci: best.pv[0] || "",
      isBest: gm.uci === best.pv[0],
      evB: fmtScore(best, sign), ev: evTxt, wW: Math.round(wW * 10) / 10,
      wb: Math.round(wb * 10) / 10, wa: Math.round(wa * 10) / 10, drop: Math.round(drop * 10) / 10,
      acc: Math.round(moveAcc(drop) * 10) / 10, cls, phase: phaseOf(positions[i], Number(positions[i].split(" ")[5])),
      line: ucisToSans(positions[i], best.pv, 8), lineUci: (best.pv || []).slice(0, 8),
      refut: ucisToSans(positions[i + 1], afterInfo.pv, 8), refutUci: (afterInfo.pv || []).slice(0, 8),
      clk: gm.clk, spent, tags: [],
    };
    rec.no = Number(positions[i].split(" ")[5]);
    if (cls) {
      rec.tags = tagsFor(positions[i], gm.uci, best, afterInfo, mover);
      if (!before.in_check()) {
        const nf = nullMoveFen(positions[i]);
        try {
          const nch = new Chess(nf);
          if (!nch.game_over()) {
            const th = await engine.analyse(nf, Math.max(10, depth - 4));
            if (th.pv && th.pv[0]) {
              rec.threat = ucisToSans(nf, [th.pv[0]], 1)[0]; rec.threatUci = th.pv[0];
              if (afterInfo.pv && afterInfo.pv[0] === th.pv[0]) rec.tags.unshift(`ignored the threat ${rec.threat}`);
            }
          }
        } catch (e) { /* probe is optional */ }
        onProgress(Math.min(total, ++done), total);
      }
      if (gm.clk != null && base && gm.clk < Math.max(30, 0.1 * base)) rec.tags.push(`played in time trouble (${Math.round(gm.clk)}s left)`);
      if (spent != null && spent <= 2 && drop >= 20) rec.tags.push(`played instantly (${spent}s)`);
      if (i > 0 && moves[i - 1].cls && moves[i - 1].cls !== "inaccuracy" && drop >= 10) rec.tags.push("failed to punish the opponent's error");
      if (!rec.tags.length) rec.tags.push("no simple tactic: positional or king-safety problem");
    }
    moves.push(rec);
  }
  onProgress(total, total);
  const s0 = infos[0];
  const startWhite = s0 ? winPct(scoreCp(s0) * (game.startFen.split(" ")[1] === "w" ? 1 : -1)) : 50;
  return buildRecord(game, moves, side, depth, Math.round(startWhite * 10) / 10);
}

function summarize(moves, color) {
  const ms = moves.filter(m => m.color === color);
  const acc = ms.length ? ms.reduce((a, m) => a + m.acc, 0) / ms.length : 0;
  const c = { inaccuracy: 0, mistake: 0, blunder: 0 };
  ms.forEach(m => { if (m.cls) c[m.cls]++; });
  return { acc: Math.round(acc * 10) / 10, ...c };
}
function tagKey(t) {
  if (t.startsWith("loses about")) return "loses material to the reply";
  if (t.startsWith("leaves the")) return "leaves a piece undefended";
  if (t.startsWith("hangs the")) return "hangs the piece it moved";
  if (t.startsWith("missed a tactic")) return "missed a tactic";
  if (t.startsWith("played in time trouble")) return "time trouble";
  if (t.startsWith("played instantly")) return "moved too fast";
  return t.split(/ about | on | \(| in \d| [KQRBN]?[a-h]?x?[a-h][1-8]| O-O/)[0];
}
function buildRecord(game, moves, side, depth, startW) {
  const h = game.headers;
  const mine = side ? moves.filter(m => m.color === side) : moves;
  const myTags = {}, myPhase = {};
  mine.forEach(m => {
    if (!m.cls) return;
    m.tags.forEach(t => { const k = tagKey(t); myTags[k] = (myTags[k] || 0) + 1; });
    if (m.cls !== "inaccuracy") myPhase[m.phase] = (myPhase[m.phase] || 0) + 1;
  });
  const res = h.Result || "*";
  let outcome = null;
  if (side && (res === "1-0" || res === "0-1")) outcome = (res === "1-0") === (side === "w") ? "win" : "loss";
  else if (side && res === "1/2-1/2") outcome = "draw";
  return {
    meta: {
      white: h.White || "White", black: h.Black || "Black", whiteElo: h.WhiteElo || "", blackElo: h.BlackElo || "",
      date: (h.Date || "").replace(/\./g, "-"), result: res, tc: h.TimeControl || "", opening: openingName(h),
      side, outcome, plies: moves.length, depth, engine: "Stockfish 19 (browser)",
      acc: { w: summarize(moves, "w").acc, b: summarize(moves, "b").acc },
      counts: { w: summarize(moves, "w"), b: summarize(moves, "b") },
      myTags, myPhase, startW, createdAt: new Date().toISOString(), notes: {}, summary: "",
      link: h.Link || h.Site || "",
    },
    data: { startFen: game.startFen, moves },
  };
}
function gameId(game) {
  const h = game.headers; const s = [h.White, h.Black, h.Date, h.UTCTime || "", game.moves.map(m => m.uci).join("")].join("|");
  let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; }
  return "g" + x.toString(36) + game.moves.length;
}
if (typeof module !== "undefined") module.exports = { splitGames, parseGame, analyzeGame, gameId, winPct };

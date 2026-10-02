// Red vs Blue — rules engine.
// Pure functions over a plain JSON "game" object. Shared by the browser (app.js)
// and the server (api/room.js), so both always agree on what a move does.
//
// Two game modes (game.opts.mode):
//   'classic' — stones fight (bigger blob attacking loses), score by leaving through the far wall.
//   'points'  — stones never die and can't move into walls or other stones. Blue's points sit
//               in the top row, Red's in the bottom row. A stone that lands on one of its own
//               points picks it up (carries it); the point scores when that stone reaches home
//               (Blue: bottom 5 rows, Red: top 5 rows). Moving a blob drags everything stuck to it.

export const MIN_W = 3, MAX_W = 120, MIN_H = 3, MAX_H = 80;
export const HOME_ROWS = 5;
export const NAME = { R: 'Red', B: 'Blue' };
export const opp = c => (c === 'R' ? 'B' : 'R');

const HISTORY_MAX = 60;   // undo depth
const LOG_MAX = 300;      // move-log entries kept
const ARROW = { '-1,-1': '↖', '0,-1': '↑', '1,-1': '↗', '-1,0': '←', '1,0': '→', '-1,1': '↙', '0,1': '↓', '1,1': '↘' };
const key = (x, y) => x + ',' + y;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const CANT = 'The blob can\'t go there — its new position has to overlap or edge-touch where it is now.';
export const BLOCKED_KING = 'In Points mode stones can\'t move into walls or other stones.';
export const BLOCKED_BLOB = 'That would push the blob (or something stuck to it) into a wall or another stone.';
export const GIFT_BLOB = 'Illegal — that would put a stone onto one of its opponent\'s points.';
export const FORBIDDEN_KING = 'Illegal — a stone can\'t move onto its opponent\'s points.';

export function emptyBoard(W, H) { return Array.from({ length: H }, () => Array(W).fill(null)); }
const fullPts = W => '1'.repeat(W);

export function newGame(W = 48, H = 24, opts = {}) {
  return {
    W, H, board: emptyBoard(W, H), scores: { R: 0, B: 0 },
    turn: 'B', per: 1, left: 1,
    opts: { enforce: true, order: '122', singleSize: 'one', mode: 'classic', ...opts },
    pts: { B: fullPts(W), R: fullPts(W) },   // Points mode: '1' = point still on that square
    carry: [],                               // Points mode: [x, y] of stones carrying a point
    log: [], moveNo: 0, history: [], lastMove: null,
  };
}
// Fill in fields that games saved by older versions don't have.
export function normalize(g) {
  if (!g.opts.mode) g.opts.mode = 'classic';
  if (!g.pts || typeof g.pts.B !== 'string' || g.pts.B.length !== g.W || g.pts.R.length !== g.W) g.pts = { B: fullPts(g.W), R: fullPts(g.W) };
  if (!Array.isArray(g.carry)) g.carry = [];
  if (isPoints(g)) sanitizePoints(g);
  return g;
}

export const onBoard = (g, x, y) => x >= 0 && x < g.W && y >= 0 && y < g.H;
export const isPoints = g => g.opts.mode === 'points';
export const carrySet = g => new Set(g.carry.map(([x, y]) => key(x, y)));
export const inHome = (g, c, y) => (c === 'B' ? y >= g.H - HOME_ROWS : y < HOME_ROWS);
export const pointRow = (g, c) => (c === 'B' ? 0 : g.H - 1);
export const hasPoint = (g, c, x, y) => y === pointRow(g, c) && x >= 0 && x < g.W && g.pts[c][x] === '1';
// Colour of the uncollected point on (x, y), or null.
export const pointAt = (g, x, y) => (hasPoint(g, 'B', x, y) ? 'B' : hasPoint(g, 'R', x, y) ? 'R' : null);
// A stone of colour c may only land on a point square if it's c's own point and c is the one moving.
// THE rule: a blue stone may never be on a red point, and a red stone never on a blue point.
const pointAllowed = (g, c, x, y) => pointAt(g, x, y) !== opp(c);
// Drop any point that has an opponent's stone sitting on it (e.g. after a resize, mode
// switch or loaded position), so no stone is ever on its opponent's point.
function sanitizePoints(g) {
  const fix = (c, y) => {
    const s = [...g.pts[c]];
    for (let x = 0; x < g.W; x++) if (s[x] === '1' && g.board[y][x] === opp(c)) s[x] = '0';
    return s.join('');
  };
  g.pts = { B: fix('B', 0), R: fix('R', g.H - 1) };
}

/* ---------- turn order ----------
   g.turn = whose turn, g.per = moves in this turn, g.left = moves still to make.
   Default order '122': Blue gets 1 move, then each side gets 2. '111': alternate. */
const perTurn = g => (g.opts.order === '122' ? 2 : 1);
export function restartOrder(g) { g.turn = 'B'; g.per = 1; g.left = 1; }
function passTurn(g) { g.turn = opp(g.turn); g.per = perTurn(g); g.left = g.per; }
function advanceTurn(g, color) {
  if (color !== g.turn) { g.turn = color; g.per = perTurn(g); g.left = g.per; } // out-of-turn move (turns not enforced)
  g.left--;
  if (g.left <= 0) passTurn(g);
}

/* ---------- blobs & clusters ----------
   blob    = orthogonally connected stones of one colour
   cluster = orthogonally connected stones of any colour (everything "stuck" together) */
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
function flood(g, grid, idx, x, y, same) {
  const { W, H, board: b } = g, cells = [], stack = [[x, y]];
  grid[y][x] = idx;
  while (stack.length) {
    const [cx, cy] = stack.pop();
    cells.push([cx, cy]);
    for (const [dx, dy] of DIRS4) {
      const nx = cx + dx, ny = cy + dy;
      if (nx >= 0 && nx < W && ny >= 0 && ny < H && grid[ny][nx] < 0 && b[ny][nx] && same(b[ny][nx])) { grid[ny][nx] = idx; stack.push([nx, ny]); }
    }
  }
  return cells;
}
export function computeBlobs(g) {
  const { W, H, board: b } = g;
  const id = Array.from({ length: H }, () => Array(W).fill(-1));
  const cid = Array.from({ length: H }, () => Array(W).fill(-1));
  const blobs = [], clusters = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = b[y][x];
    if (!c) continue;
    if (id[y][x] < 0) {
      const cells = flood(g, id, blobs.length, x, y, v => v === c);
      blobs.push({ index: blobs.length, color: c, cells, size: cells.length });
    }
    if (cid[y][x] < 0) {
      const cells = flood(g, cid, clusters.length, x, y, () => true);
      clusters.push({ index: clusters.length, cells });
    }
  }
  return { id, blobs, cid, clusters };
}
export function blobAt(g, info, x, y) {
  if (!onBoard(g, x, y)) return null;
  const i = info.id[y][x];
  return i >= 0 ? info.blobs[i] : null;
}
export function clusterOf(info, bl) { const [x, y] = bl.cells[0]; return info.clusters[info.cid[y][x]]; }

/* ---------- classic: what happens when a stone lands somewhere ----------
   Evaluated against the board as it was before the move. `vacated` = cells the
   moving stones are leaving (they count as empty). */
export function outcome(g, info, color, tx, ty, atk, vacated) {
  if (!onBoard(g, tx, ty)) {
    if (color === 'B' && ty < 0) return 'score';
    if (color === 'R' && ty >= g.H) return 'score';
    return 'wall';
  }
  const t = g.board[ty][tx];
  if (!t || (vacated && vacated.has(key(tx, ty)))) return 'empty';
  if (t === color) return 'self';
  return atk > blobAt(g, info, tx, ty).size ? 'lose' : 'win';
}
export function singleAtk(g, info, x, y) { return g.opts.singleSize === 'one' ? 1 : blobAt(g, info, x, y).size; }

/* ---------- points mode: landing + picking up / delivering ---------- */
function pointsOutcome(g, tx, ty, vacated) {
  if (!onBoard(g, tx, ty)) return 'blocked';
  const t = g.board[ty][tx];
  return !t || (vacated && vacated.has(key(tx, ty))) ? 'empty' : 'blocked';
}
// Adds pick / deliver / carry flags to each landing move (m.c = the stone's colour).
function annotatePoints(g, moves) {
  const cs = carrySet(g);
  for (const m of moves) {
    m.had = cs.has(key(m.fx, m.fy));
    if (m.o !== 'empty') continue;
    m.pick = !m.had && hasPoint(g, m.c, m.tx, m.ty);
    m.deliver = (m.had || m.pick) && inHome(g, m.c, m.ty);
    m.carry = (m.had || m.pick) && !m.deliver;
  }
  return moves;
}

export function kingTargets(g, info, x, y) {
  const c = g.board[y][x], out = [];
  const pm = isPoints(g), atk = pm ? 0 : singleAtk(g, info, x, y);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const tx = x + dx, ty = y + dy;
    let o = pm ? pointsOutcome(g, tx, ty) : outcome(g, info, c, tx, ty, atk);
    if (pm && o === 'empty' && !pointAllowed(g, c, tx, ty)) o = 'forbidden';
    out.push({ fx: x, fy: y, tx, ty, dx, dy, c, o });
  }
  return pm ? annotatePoints(g, out) : out;
}

/* ---------- blob translations ----------
   Offset (dx,dy) is legal when the moved blob overlaps its old cells
   (dx,dy = b - a) or edge-touches them (dx,dy = b - a ± unit step),
   for some stones a, b of the blob. (0,0) is excluded. */
const tCache = new WeakMap();
export function blobTranslations(g, info, bl) {
  let m = tCache.get(info);
  if (!m) tCache.set(info, (m = new Map()));
  if (m.has(bl.index)) return m.get(bl.index);
  const OX = g.W + 2, OY = g.H + 2, TH = 2 * OY + 1, size = (2 * OX + 1) * TH;
  const idx = (dx, dy) => (dx + OX) * TH + (dy + OY);
  const diff = new Uint8Array(size), ok = new Uint8Array(size);
  for (const [ax, ay] of bl.cells) for (const [bx, by] of bl.cells) diff[idx(bx - ax, by - ay)] = 1;
  const list = [];
  for (let dx = -g.W; dx <= g.W; dx++) for (let dy = -g.H; dy <= g.H; dy++) {
    if (!diff[idx(dx, dy)]) continue;
    for (const [ex, ey] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const i = idx(dx + ex, dy + ey);
      if (!ok[i] && (dx + ex || dy + ey)) { ok[i] = 1; list.push([dx + ex, dy + ey]); }
    }
  }
  const T = { ok, list, idx, OX, OY, vac: new Set(bl.cells.map(([x, y]) => key(x, y))), legalPoints: null };
  m.set(bl.index, T);
  return T;
}
export function isValidT(T, dx, dy) {
  return !!(dx || dy) && Math.abs(dx) < T.OX && Math.abs(dy) < T.OY && T.ok[T.idx(dx, dy)] === 1;
}
export function blobMoves(g, info, bl, dx, dy) {
  const vac = blobTranslations(g, info, bl).vac;
  return bl.cells.map(([x, y]) => ({ fx: x, fy: y, tx: x + dx, ty: y + dy, c: bl.color, o: outcome(g, info, bl.color, x + dx, y + dy, bl.size, vac) }));
}

// Everything about moving blob `bl` by (dx,dy) in the current mode:
// { valid, reason, moves: [{fx,fy,tx,ty,c,o,...}], dragged }
export function blobPlan(g, info, bl, dx, dy) {
  const T = blobTranslations(g, info, bl);
  const shapeOk = isValidT(T, dx, dy);
  if (!isPoints(g)) {
    return { valid: shapeOk, reason: shapeOk ? '' : CANT, moves: blobMoves(g, info, bl, dx, dy), dragged: 0 };
  }
  const cl = clusterOf(info, bl);
  const vac = new Set(cl.cells.map(([x, y]) => key(x, y)));
  const moves = annotatePoints(g, cl.cells.map(([x, y]) => ({
    fx: x, fy: y, tx: x + dx, ty: y + dy, c: g.board[y][x], o: pointsOutcome(g, x + dx, y + dy, vac),
  })));
  const blocked = moves.some(m => m.o === 'blocked');
  // Illegal: any stone (yours or one being dragged) landing on its opponent's point.
  for (const m of moves) m.gift = m.o === 'empty' && !pointAllowed(g, m.c, m.tx, m.ty);
  const gift = moves.some(m => m.gift);
  return {
    valid: shapeOk && !blocked && !gift,
    reason: !shapeOk ? CANT : blocked ? BLOCKED_BLOB : gift ? GIFT_BLOB : '',
    moves, dragged: cl.cells.length - bl.size,
  };
}
// Every legal offset for blob `bl` in the current mode (used to shade reachable squares).
export function legalOffsets(g, info, bl) {
  const T = blobTranslations(g, info, bl);
  if (!isPoints(g)) return T.list;
  if (T.legalPoints) return T.legalPoints;
  const cells = clusterOf(info, bl).cells;
  const vac = new Set(cells.map(([x, y]) => key(x, y)));
  const free = (x, y) => onBoard(g, x, y) && (!g.board[y][x] || vac.has(key(x, y)));
  const ok = (x, y, dx, dy) => {
    const c = g.board[y][x];
    return free(x + dx, y + dy) && pointAllowed(g, c, x + dx, y + dy);
  };
  T.legalPoints = T.list.filter(([dx, dy]) => cells.every(([x, y]) => ok(x, y, dx, dy)));
  return T.legalPoints;
}

export function offsetText(dx, dy) {
  const p = [];
  if (dx) p.push(`${Math.abs(dx)} ${dx > 0 ? 'right' : 'left'}`);
  if (dy) p.push(`${Math.abs(dy)} ${dy > 0 ? 'down' : 'up'}`);
  return p.join(', ');
}
// Short description of what a move does, for the log and the previews.
export function summarize(moves, mover) {
  const parts = [];
  if (moves.some(m => 'pick' in m)) {                       // points mode
    for (const c of [mover || moves[0].c, opp(mover || moves[0].c)]) {
      const pick = moves.filter(m => m.c === c && m.pick).length;
      const del = moves.filter(m => m.c === c && m.deliver).length;
      const who = c === mover ? '' : NAME[c] + ' ';
      if (pick) parts.push(`${who}picked up ${plural(pick, 'point')}`);
      if (del) parts.push(`${who}scored ${del}`);
    }
    return parts;
  }
  const t = { captured: 0, died: 0, scored: 0, wall: 0, self: 0 };
  for (const m of moves) {
    if (m.o === 'win') t.captured++; else if (m.o === 'lose') t.died++;
    else if (m.o === 'score') t.scored++; else if (m.o === 'wall') t.wall++; else if (m.o === 'self') t.self++;
  }
  if (t.captured) parts.push(`captured ${t.captured}`);
  if (t.scored) parts.push(`scored ${t.scored}`);
  if (t.died) parts.push(`lost ${t.died} in combat`);
  if (t.wall) parts.push(`lost ${t.wall} off the edge`);
  if (t.self) parts.push(`lost ${t.self} into own stones`);
  return parts;
}

/* ---------- position codes ----------
   Classic: RVB1;<W>x<H>;<turn><left>/<per>;R<score>B<score>;<rows>
   Points:  RVB2;p;<W>x<H>;<turn><left>/<per>;R<score>B<score>;<rows>;<blue points>;<red points>
   Rows are separated by "/", each run-length encoded as [count]<token>. Tokens: "." empty,
   "r"/"b" a stone, "R"/"B" a stone carrying a point (points mode). A trailing empty run is
   omitted. Point rows use "o" = point still there, "x" = picked up. */
function rle(tokens, skipTrailing) {
  let out = '', i = 0;
  while (i < tokens.length) {
    const t = tokens[i]; let n = 1;
    while (i + n < tokens.length && tokens[i + n] === t) n++;
    if (!(skipTrailing && t === '.' && i + n === tokens.length)) out += (n > 1 ? n : '') + t;
    i += n;
  }
  return out;
}
function unrle(s, re, W) {
  if (s.replace(re, '') !== '') return null;
  const out = [];
  for (const [, n, t] of s.matchAll(re)) {
    const k = n ? +n : 1;
    for (let i = 0; i < k && out.length <= W; i++) out.push(t);
  }
  return out.length > W ? null : out;
}
export function encodePosition(g) {
  const pm = isPoints(g), cs = pm ? carrySet(g) : null;
  const rows = g.board.map((row, y) => rle(row.map((c, x) => (!c ? '.' : pm && cs.has(key(x, y)) ? c : c.toLowerCase())), true));
  const head = `${g.W}x${g.H};${g.turn}${g.left}/${g.per};R${g.scores.R}B${g.scores.B};${rows.join('/')}`;
  if (!pm) return 'RVB1;' + head;
  const pts = c => rle([...g.pts[c]].map(v => (v === '1' ? 'o' : 'x')), false);
  return `RVB2;p;${head};${pts('B')};${pts('R')}`;
}
export function decodePosition(text) {
  const t = String(text || '').replace(/\s+/g, '');
  let m = t.match(/^RVB1;(\d+)x(\d+);([RB])(\d+)\/(\d+);R(\d+)B(\d+);(.*)$/i), mode = null, ptsB = null, ptsR = null;
  if (!m) {
    const m2 = t.match(/^RVB2;([pc]);(\d+x\d+;[RB]\d+\/\d+;R\d+B\d+;[^;]*);([ox\d]*);([ox\d]*)$/);
    if (!m2) return null;
    mode = m2[1] === 'p' ? 'points' : 'classic';
    ptsB = m2[3]; ptsR = m2[4];
    m = ('RVB1;' + m2[2]).match(/^RVB1;(\d+)x(\d+);([RB])(\d+)\/(\d+);R(\d+)B(\d+);(.*)$/);
    if (!m) return null;
  }
  const W = +m[1], H = +m[2];
  if (W < MIN_W || W > MAX_W || H < MIN_H || H > MAX_H) return null;
  const rows = m[8].split('/');
  if (rows.length !== H) return null;
  const board = [], carry = [];
  for (let y = 0; y < H; y++) {
    const toks = unrle(mode ? rows[y] : rows[y].toLowerCase(), /(\d*)([rbRB.])/g, W);
    if (!toks) return null;
    while (toks.length < W) toks.push('.');
    board.push(toks.map((tk, x) => {
      if (tk === '.') return null;
      if (tk === 'R' || tk === 'B') carry.push([x, y]);
      return tk.toUpperCase();
    }));
  }
  let pts = null;
  if (mode) {
    const pB = unrle(ptsB, /(\d*)([ox])/g, W), pR = unrle(ptsR, /(\d*)([ox])/g, W);
    if (!pB || !pR) return null;
    const str = a => { while (a.length < W) a.push('o'); return a.map(v => (v === 'o' ? '1' : '0')).join(''); };
    pts = { B: str(pB), R: str(pR) };
  }
  const per = Math.min(9, Math.max(1, +m[5])), left = Math.min(per, Math.max(1, +m[4]));
  return { W, H, board, turn: m[3].toUpperCase(), per, left, scores: { R: +m[6], B: +m[7] }, mode, pts, carry };
}
function setPosition(g, pos) {
  g.W = pos.W; g.H = pos.H; g.board = pos.board;
  g.turn = pos.turn; g.per = pos.per; g.left = pos.left; g.scores = pos.scores;
  g.pts = pos.pts || { B: fullPts(pos.W), R: fullPts(pos.W) };
  g.carry = pos.carry || [];
  sanitizePoints(g);
}

/* ---------- log & undo history ---------- */
function addLog(g, e) {
  g.log.push(e);
  const extra = g.log.length - LOG_MAX;
  if (extra > 0) {
    g.log.splice(0, extra);
    for (const h of g.history) h.logLen = Math.max(0, h.logLen - extra);
  }
}
export function logNote(g, c, t) { addLog(g, { c: c || null, t, note: true }); }
function pushHistory(g) {
  g.history.push({ code: encodePosition(g), logLen: g.log.length, moveNo: g.moveNo, lastMove: g.lastMove });
  if (g.history.length > HISTORY_MAX) g.history.shift();
}
function finishMove(g, mover, moves, label, landed) {
  advanceTurn(g, mover);
  const parts = summarize(moves, mover);
  const text = label + (parts.length ? ' — ' + parts.join(', ') : '');
  g.moveNo++;
  addLog(g, { n: g.moveNo, c: mover, t: text });
  g.lastMove = { c: mover, from: moves.map(m => [m.fx, m.fy]), to: landed };
  return `${NAME[mover]} ${text}.`;
}

// Classic: every stone is resolved against the pre-move board, simultaneously.
function executeClassic(g, info, color, moves, atk, label) {
  const vac = new Set(moves.map(m => key(m.fx, m.fy)));
  const results = moves.map(m => ({ ...m, o: outcome(g, info, color, m.tx, m.ty, atk, vac) }));
  const nb = g.board.map(r => r.slice());
  for (const m of moves) nb[m.fy][m.fx] = null;
  const to = [];
  for (const r of results) {
    if (r.o === 'empty' || r.o === 'win') { nb[r.ty][r.tx] = color; to.push([r.tx, r.ty]); }
    else if (r.o === 'score') g.scores[color]++;
  }
  g.board = nb;
  return finishMove(g, color, results, label, to);
}

// Points: moves are already checked (all land on free squares) and annotated.
function executePoints(g, moves, mover, label) {
  const nb = g.board.map(r => r.slice());
  const cs = carrySet(g);
  for (const m of moves) { nb[m.fy][m.fx] = null; cs.delete(key(m.fx, m.fy)); }
  const pts = { B: [...g.pts.B], R: [...g.pts.R] };
  for (const m of moves) {
    nb[m.ty][m.tx] = m.c;
    if (m.pick) pts[m.c][m.tx] = '0';
    if (m.deliver) g.scores[m.c]++;
    if (m.carry) cs.add(key(m.tx, m.ty));
  }
  g.board = nb;
  g.pts = { B: pts.B.join(''), R: pts.R.join('') };
  g.carry = [...cs].map(k => k.split(',').map(Number));
  return finishMove(g, mover, moves, label, moves.map(m => [m.tx, m.ty]));
}

/* ---------- actions ----------
   applyAction(game, action, actor) mutates `game` and returns
   { ok: true, message, moved } or { ok: false, error } (game untouched on error).
   actor: {} for local play, { color: 'B'|'R' } for a seated online player,
   { spectator: true } for someone watching. */
const isInt = v => Number.isInteger(v);
const fail = error => ({ ok: false, error });
const done = (message, moved = false) => ({ ok: true, message, moved });

function moveProblem(g, color, actor) {
  if (actor.color && actor.color !== color) return `You're playing ${NAME[actor.color]} — you can only move ${NAME[actor.color].toLowerCase()} stones.`;
  if (g.opts.enforce && color !== g.turn) return `It's ${NAME[g.turn]}'s turn.`;
  return null;
}
function resetPoints(g) { g.pts = { B: fullPts(g.W), R: fullPts(g.W) }; g.carry = []; sanitizePoints(g); }

export function applyAction(g, a, actor = {}) {
  if (!a || typeof a !== 'object') return fail('Unknown action.');
  if (actor.spectator) return fail('You\'re watching this game. Take an open seat to play.');
  normalize(g);
  const who = actor.color ? NAME[actor.color] : '';
  const note = (withWho, plain) => logNote(g, actor.color, who ? `${who} ${withWho}` : plain);
  const pm = isPoints(g);

  switch (a.type) {
    case 'king': {
      const { fx, fy, tx, ty } = a;
      if (![fx, fy, tx, ty].every(isInt)) return fail('Bad move.');
      if (!onBoard(g, fx, fy) || !g.board[fy][fx]) return fail('There\'s no stone there any more.');
      const color = g.board[fy][fx];
      const bad = moveProblem(g, color, actor); if (bad) return fail(bad);
      const dx = tx - fx, dy = ty - fy;
      if (!(dx || dy) || Math.abs(dx) > 1 || Math.abs(dy) > 1) return fail('A single stone moves one square in any direction.');
      const label = `moved stone at (${fx + 1}, ${fy + 1}) ${ARROW[dx + ',' + dy]}`;
      const info = computeBlobs(g);
      if (pm) {
        const m = kingTargets(g, info, fx, fy).find(t => t.tx === tx && t.ty === ty);
        if (m.o !== 'empty') return fail(m.o === 'forbidden' ? FORBIDDEN_KING : BLOCKED_KING);
        pushHistory(g);
        return done(executePoints(g, [m], color, label), true);
      }
      pushHistory(g);
      return done(executeClassic(g, info, color, [{ fx, fy, tx, ty }], singleAtk(g, info, fx, fy), label), true);
    }

    case 'blob': {
      const { ax, ay, dx, dy } = a;
      if (![ax, ay, dx, dy].every(isInt)) return fail('Bad move.');
      if (!onBoard(g, ax, ay) || !g.board[ay][ax]) return fail('There\'s no stone there any more.');
      const info = computeBlobs(g), bl = blobAt(g, info, ax, ay);
      const bad = moveProblem(g, bl.color, actor); if (bad) return fail(bad);
      const plan = blobPlan(g, info, bl, dx, dy);
      if (!plan.valid) return fail(plan.reason);
      pushHistory(g);
      const label = `moved ${bl.size}-stone blob ${offsetText(dx, dy)}` + (plan.dragged ? ` (dragging ${plural(plan.dragged, 'stuck stone')})` : '');
      return done(pm ? executePoints(g, plan.moves, bl.color, label) : executeClassic(g, info, bl.color, plan.moves, bl.size, label), true);
    }

    case 'edit': {
      const ch = a.changes;
      if (!Array.isArray(ch) || ch.length > g.W * g.H) return fail('Bad edit.');
      const real = [];
      let refused = 0;
      for (const e of ch) {
        if (!Array.isArray(e)) return fail('Bad edit.');
        const [x, y, c] = e;
        if (!isInt(x) || !isInt(y) || !onBoard(g, x, y) || !(c === 'R' || c === 'B' || c === null)) return fail('Bad edit.');
        if (pm && c && !pointAllowed(g, c, x, y)) { refused++; continue; }
        if (g.board[y][x] !== c) real.push([x, y, c]);
      }
      const why = refused ? `Skipped ${plural(refused, 'square')} — a stone can't be placed on its opponent's points.` : '';
      if (!real.length) return done(why);
      pushHistory(g);
      let add = 0, rem = 0;
      const touched = new Set();
      for (const [x, y, c] of real) { if (g.board[y][x]) rem++; if (c) add++; g.board[y][x] = c; touched.add(key(x, y)); }
      g.carry = g.carry.filter(([x, y]) => !touched.has(key(x, y)));   // a replaced stone drops what it carried
      const parts = [];
      if (add) parts.push(`added ${plural(add, 'stone')}`);
      if (rem) parts.push(`removed ${plural(rem, 'stone')}`);
      if (who) note(`edited the board (${parts.join(', ')})`, '');
      return done(why);
    }

    case 'resize': {
      if (!isInt(a.w) || !isInt(a.h)) return fail('Bad size.');
      const w = Math.max(MIN_W, Math.min(MAX_W, a.w)), h = Math.max(MIN_H, Math.min(MAX_H, a.h));
      if (w === g.W && h === g.H) return done(`The board is already ${w} × ${h}.`);
      pushHistory(g);
      const ox = Math.floor((w - g.W) / 2), oy = Math.floor((h - g.H) / 2);
      const nb = emptyBoard(w, h);
      let dropped = 0;
      for (let y = 0; y < g.H; y++) for (let x = 0; x < g.W; x++) {
        const c = g.board[y][x]; if (!c) continue;
        const nx = x + ox, ny = y + oy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) nb[ny][nx] = c; else dropped++;
      }
      // point rows keep their state column by column; new columns start with a point
      const shiftPts = s => { const out = Array(w).fill('1'); for (let x = 0; x < g.W; x++) if (x + ox >= 0 && x + ox < w) out[x + ox] = s[x]; return out.join(''); };
      g.pts = { B: shiftPts(g.pts.B), R: shiftPts(g.pts.R) };
      g.carry = g.carry.map(([x, y]) => [x + ox, y + oy]).filter(([x, y]) => x >= 0 && x < w && y >= 0 && y < h && nb[y][x]);
      g.W = w; g.H = h; g.board = nb; g.lastMove = null;
      sanitizePoints(g);
      const drop = dropped ? ` — ${dropped === 1 ? '1 stone that no longer fit was' : dropped + ' stones that no longer fit were'} removed` : '';
      note(`resized the board to ${w} × ${h}${drop}`, `Board resized to ${w} × ${h}${drop}`);
      return done(`Board resized to ${w} × ${h}${drop}.${dropped ? ' (Undo brings them back.)' : ''}`);
    }

    case 'clear': {
      pushHistory(g);
      g.board = emptyBoard(g.W, g.H); g.scores = { R: 0, B: 0 }; g.lastMove = null; g.moveNo = 0;
      resetPoints(g);
      restartOrder(g);
      note('cleared the board — turn order restarted', 'Board cleared — turn order restarted');
      return done('Board cleared and turn order restarted. (Undo brings it back.)');
    }

    case 'switchTurn': {
      pushHistory(g);
      const from = g.turn;
      passTurn(g);
      note(`handed the turn from ${NAME[from]} to ${NAME[g.turn]}`, `Turn switched to ${NAME[g.turn]}`);
      return done('');
    }

    case 'resetScores': {
      pushHistory(g);
      g.scores = { R: 0, B: 0 };
      if (pm) {
        resetPoints(g);
        note('reset the scores and put every point back', 'Scores reset and every point put back');
        return done('Scores reset, every point is back on the board, and nobody is carrying one.');
      }
      note('reset the scores', 'Scores reset');
      return done('Scores reset.');
    }

    case 'load': {
      const pos = decodePosition(a.code);
      if (!pos) return fail('That isn\'t a valid position code (it should start with RVB1; or RVB2;).');
      pushHistory(g);
      setPosition(g, pos);
      if (pos.mode) g.opts.mode = pos.mode;
      g.lastMove = null;
      const m = pos.mode === 'points' ? ', Points mode' : '';
      note(`loaded a position (${pos.W} × ${pos.H}${m})`, `Position loaded (${pos.W} × ${pos.H}${m})`);
      return done(`Position loaded (${pos.W} × ${pos.H} board${m}).`);
    }

    case 'undo': {
      if (!g.history.length) return fail('Nothing to undo.');
      const h = g.history.pop();
      setPosition(g, decodePosition(h.code));
      g.log.length = Math.min(g.log.length, h.logLen);
      g.moveNo = h.moveNo;
      g.lastMove = h.lastMove || null;
      note('undid the last action', '');
      return done('Undid the last action.');
    }

    case 'options': {
      const said = [];
      if ((a.mode === 'classic' || a.mode === 'points') && a.mode !== g.opts.mode) {
        g.opts.mode = a.mode;
        resetPoints(g);
        said.push(a.mode === 'points' ? 'game mode Points (collect points and bring them home)' : 'game mode Classic');
      }
      if (typeof a.enforce === 'boolean' && a.enforce !== g.opts.enforce) {
        g.opts.enforce = a.enforce; said.push(`turns ${a.enforce ? 'enforced' : 'not enforced'}`);
      }
      if ((a.order === '122' || a.order === '111') && a.order !== g.opts.order) {
        g.opts.order = a.order;
        if (a.order === '111') { g.per = 1; g.left = 1; }
        said.push(a.order === '122' ? 'move order Blue 1, then 2 each' : 'move order alternating, 1 each');
      }
      if ((a.singleSize === 'one' || a.singleSize === 'blob') && a.singleSize !== g.opts.singleSize) {
        g.opts.singleSize = a.singleSize;
        said.push(a.singleSize === 'one' ? 'a lone attacking stone counts as size 1' : 'a lone attacking stone counts as its blob\'s size');
      }
      if (!said.length) return done('');
      note(`changed options: ${said.join('; ')}`, `Options: ${said.join('; ')}`);
      return done(`Options updated: ${said.join('; ')}.`);
    }

    default:
      return fail('Unknown action.');
  }
}

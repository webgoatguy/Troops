// Red vs Blue — rules engine.
// Pure functions over a plain JSON "game" object. Shared by the browser (app.js)
// and the server (api/room.js), so both always agree on what a move does.

export const MIN_W = 3, MAX_W = 120, MIN_H = 3, MAX_H = 80;
export const NAME = { R: 'Red', B: 'Blue' };
export const opp = c => (c === 'R' ? 'B' : 'R');

const HISTORY_MAX = 60;   // undo depth
const LOG_MAX = 300;      // move-log entries kept
const ARROW = { '-1,-1': '↖', '0,-1': '↑', '1,-1': '↗', '-1,0': '←', '1,0': '→', '-1,1': '↙', '0,1': '↓', '1,1': '↘' };
const key = (x, y) => x + ',' + y;
export const CANT = 'The blob can\'t go there — its new position has to overlap or edge-touch where it is now.';

export function emptyBoard(W, H) { return Array.from({ length: H }, () => Array(W).fill(null)); }

export function newGame(W = 48, H = 24, opts = {}) {
  return {
    W, H, board: emptyBoard(W, H), scores: { R: 0, B: 0 },
    turn: 'B', per: 1, left: 1,
    opts: { enforce: true, order: '122', singleSize: 'one', ...opts },
    log: [], moveNo: 0, history: [], lastMove: null,
  };
}

export const onBoard = (g, x, y) => x >= 0 && x < g.W && y >= 0 && y < g.H;

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

/* ---------- blobs (orthogonally connected same-colour stones) ---------- */
export function computeBlobs(g) {
  const { W, H, board: b } = g;
  const id = Array.from({ length: H }, () => Array(W).fill(-1));
  const blobs = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!b[y][x] || id[y][x] >= 0) continue;
    const c = b[y][x], bi = blobs.length, cells = [], stack = [[x, y]];
    id[y][x] = bi;
    while (stack.length) {
      const [cx, cy] = stack.pop();
      cells.push([cx, cy]);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && nx < W && ny >= 0 && ny < H && id[ny][nx] < 0 && b[ny][nx] === c) { id[ny][nx] = bi; stack.push([nx, ny]); }
      }
    }
    blobs.push({ index: bi, color: c, cells, size: cells.length });
  }
  return { id, blobs };
}
export function blobAt(g, info, x, y) {
  if (!onBoard(g, x, y)) return null;
  const i = info.id[y][x];
  return i >= 0 ? info.blobs[i] : null;
}

/* ---------- what happens when a stone lands somewhere ----------
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

export function kingTargets(g, info, x, y) {
  const c = g.board[y][x], atk = singleAtk(g, info, x, y), out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const tx = x + dx, ty = y + dy;
    out.push({ fx: x, fy: y, tx, ty, dx, dy, o: outcome(g, info, c, tx, ty, atk) });
  }
  return out;
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
  const T = { ok, list, idx, OX, OY, vac: new Set(bl.cells.map(([x, y]) => key(x, y))) };
  m.set(bl.index, T);
  return T;
}
export function isValidT(T, dx, dy) {
  return !!(dx || dy) && Math.abs(dx) < T.OX && Math.abs(dy) < T.OY && T.ok[T.idx(dx, dy)] === 1;
}
export function blobMoves(g, info, bl, dx, dy) {
  const vac = blobTranslations(g, info, bl).vac;
  return bl.cells.map(([x, y]) => ({ fx: x, fy: y, tx: x + dx, ty: y + dy, o: outcome(g, info, bl.color, x + dx, y + dy, bl.size, vac) }));
}
export function offsetText(dx, dy) {
  const p = [];
  if (dx) p.push(`${Math.abs(dx)} ${dx > 0 ? 'right' : 'left'}`);
  if (dy) p.push(`${Math.abs(dy)} ${dy > 0 ? 'down' : 'up'}`);
  return p.join(', ');
}
export function summarize(moves) {
  const t = { captured: 0, died: 0, scored: 0, wall: 0, self: 0 };
  for (const m of moves) {
    if (m.o === 'win') t.captured++; else if (m.o === 'lose') t.died++;
    else if (m.o === 'score') t.scored++; else if (m.o === 'wall') t.wall++; else if (m.o === 'self') t.self++;
  }
  const parts = [];
  if (t.captured) parts.push(`captured ${t.captured}`);
  if (t.scored) parts.push(`scored ${t.scored}`);
  if (t.died) parts.push(`lost ${t.died} in combat`);
  if (t.wall) parts.push(`lost ${t.wall} off the edge`);
  if (t.self) parts.push(`lost ${t.self} into own stones`);
  return parts;
}

/* ---------- position codes ----------
   RVB1;<W>x<H>;<turn><left>/<per>;R<score>B<score>;<rows>
   Rows are separated by "/", each run-length encoded: [count]<r|b|.>; a trailing
   empty run is omitted, so an empty row is written as nothing. */
export function encodePosition(g) {
  const rows = g.board.map(row => {
    let out = '', i = 0;
    while (i < row.length) {
      const c = row[i]; let n = 1;
      while (i + n < row.length && row[i + n] === c) n++;
      if (c || i + n < row.length) out += (n > 1 ? n : '') + (c ? c.toLowerCase() : '.');
      i += n;
    }
    return out;
  });
  return `RVB1;${g.W}x${g.H};${g.turn}${g.left}/${g.per};R${g.scores.R}B${g.scores.B};${rows.join('/')}`;
}
export function decodePosition(text) {
  const t = String(text || '').replace(/\s+/g, '');
  const m = t.match(/^RVB1;(\d+)x(\d+);([RB])(\d+)\/(\d+);R(\d+)B(\d+);(.*)$/i);
  if (!m) return null;
  const W = +m[1], H = +m[2];
  if (W < MIN_W || W > MAX_W || H < MIN_H || H > MAX_H) return null;
  const rows = m[8].split('/');
  if (rows.length !== H) return null;
  const board = [];
  for (const r of rows) {
    if (r.replace(/(\d*)([rb.])/gi, '') !== '') return null;
    const row = [];
    for (const [, n, c] of r.matchAll(/(\d*)([rb.])/gi)) {
      const k = n ? +n : 1, v = c === '.' ? null : c.toUpperCase();
      for (let i = 0; i < k && row.length <= W; i++) row.push(v);
    }
    if (row.length > W) return null;
    while (row.length < W) row.push(null);
    board.push(row);
  }
  const per = Math.min(9, Math.max(1, +m[5])), left = Math.min(per, Math.max(1, +m[4]));
  return { W, H, board, turn: m[3].toUpperCase(), per, left, scores: { R: +m[6], B: +m[7] } };
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

function execute(g, info, color, moves, atk, label) {
  // every stone is resolved against the pre-move board, simultaneously
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
  advanceTurn(g, color);
  const parts = summarize(results);
  const text = label + (parts.length ? ' — ' + parts.join(', ') : '');
  g.moveNo++;
  addLog(g, { n: g.moveNo, c: color, t: text });
  g.lastMove = { c: color, from: moves.map(m => [m.fx, m.fy]), to };
  return `${NAME[color]} ${text}.`;
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

export function applyAction(g, a, actor = {}) {
  if (!a || typeof a !== 'object') return fail('Unknown action.');
  if (actor.spectator) return fail('You\'re watching this game. Take an open seat to play.');
  const who = actor.color ? NAME[actor.color] : '';
  const note = (withWho, plain) => logNote(g, actor.color, who ? `${who} ${withWho}` : plain);

  switch (a.type) {
    case 'king': {
      const { fx, fy, tx, ty } = a;
      if (![fx, fy, tx, ty].every(isInt)) return fail('Bad move.');
      if (!onBoard(g, fx, fy) || !g.board[fy][fx]) return fail('There\'s no stone there any more.');
      const color = g.board[fy][fx];
      const bad = moveProblem(g, color, actor); if (bad) return fail(bad);
      const dx = tx - fx, dy = ty - fy;
      if (!(dx || dy) || Math.abs(dx) > 1 || Math.abs(dy) > 1) return fail('A single stone moves one square in any direction.');
      const info = computeBlobs(g);
      pushHistory(g);
      return done(execute(g, info, color, [{ fx, fy, tx, ty }], singleAtk(g, info, fx, fy),
        `moved stone at (${fx + 1}, ${fy + 1}) ${ARROW[dx + ',' + dy]}`), true);
    }

    case 'blob': {
      const { ax, ay, dx, dy } = a;
      if (![ax, ay, dx, dy].every(isInt)) return fail('Bad move.');
      if (!onBoard(g, ax, ay) || !g.board[ay][ax]) return fail('There\'s no stone there any more.');
      const info = computeBlobs(g), bl = blobAt(g, info, ax, ay);
      const bad = moveProblem(g, bl.color, actor); if (bad) return fail(bad);
      if (!isValidT(blobTranslations(g, info, bl), dx, dy)) return fail(CANT);
      pushHistory(g);
      return done(execute(g, info, bl.color, blobMoves(g, info, bl, dx, dy), bl.size,
        `moved ${bl.size}-stone blob ${offsetText(dx, dy)}`), true);
    }

    case 'edit': {
      const ch = a.changes;
      if (!Array.isArray(ch) || ch.length > g.W * g.H) return fail('Bad edit.');
      const real = [];
      for (const e of ch) {
        if (!Array.isArray(e)) return fail('Bad edit.');
        const [x, y, c] = e;
        if (!isInt(x) || !isInt(y) || !onBoard(g, x, y) || !(c === 'R' || c === 'B' || c === null)) return fail('Bad edit.');
        if (g.board[y][x] !== c) real.push([x, y, c]);
      }
      if (!real.length) return done('');
      pushHistory(g);
      let add = 0, rem = 0;
      for (const [x, y, c] of real) { if (g.board[y][x]) rem++; if (c) add++; g.board[y][x] = c; }
      const parts = [];
      if (add) parts.push(`added ${add} stone${add > 1 ? 's' : ''}`);
      if (rem) parts.push(`removed ${rem} stone${rem > 1 ? 's' : ''}`);
      if (who) note(`edited the board (${parts.join(', ')})`, '');
      return done('');
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
      g.W = w; g.H = h; g.board = nb; g.lastMove = null;
      const drop = dropped ? ` — ${dropped === 1 ? '1 stone that no longer fit was' : dropped + ' stones that no longer fit were'} removed` : '';
      note(`resized the board to ${w} × ${h}${drop}`, `Board resized to ${w} × ${h}${drop}`);
      return done(`Board resized to ${w} × ${h}${drop}.${dropped ? ' (Undo brings them back.)' : ''}`);
    }

    case 'clear': {
      pushHistory(g);
      g.board = emptyBoard(g.W, g.H); g.scores = { R: 0, B: 0 }; g.lastMove = null; g.moveNo = 0;
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
      note('reset the scores', 'Scores reset');
      return done('Scores reset.');
    }

    case 'load': {
      const pos = decodePosition(a.code);
      if (!pos) return fail('That isn\'t a valid position code (it should start with RVB1;).');
      pushHistory(g);
      Object.assign(g, pos);
      g.lastMove = null;
      note(`loaded a position (${pos.W} × ${pos.H})`, `Position loaded (${pos.W} × ${pos.H})`);
      return done(`Position loaded (${pos.W} × ${pos.H} board).`);
    }

    case 'undo': {
      if (!g.history.length) return fail('Nothing to undo.');
      const h = g.history.pop();
      Object.assign(g, decodePosition(h.code));
      g.log.length = Math.min(g.log.length, h.logLen);
      g.moveNo = h.moveNo;
      g.lastMove = h.lastMove || null;
      note('undid the last action', '');
      return done('Undid the last action.');
    }

    case 'options': {
      const said = [];
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

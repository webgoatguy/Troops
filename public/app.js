// Red vs Blue — browser app: lobby, local play, and online rooms.
import * as G from './rules.js';
const { NAME } = G;

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const RGB = { R: '214,64,55', B: '43,103,214' };
const COL = {
  R: '#d64037', B: '#2b67d6', Rd: '#9e2821', Bd: '#1a4595',
  cellA: '#f8f4eb', cellB: '#f0eadd', grid: '#e2dac9', side: '#bdb5a5',
  blueGoal: '#d6e2f8', redGoal: '#f6d6d2', sel: '#e8a800', win: '#1f9d55', x: '#2a2622',
  Rl: '#ef8a80', Bl: '#6a97ec', gold: '#f2c230', goldDark: '#8a6a00'
};
const ORD = ['', 'first', 'second', 'third'];

const canvas = $('board');
const ctx = canvas.getContext('2d');
let cs = 22, canvasKey = '', canvasPxW = 0, canvasPxH = 0;
const SQ3 = Math.sqrt(3);
let hexO = { x: 0, y: 0 };   // hex mode: pixel centre of axial cell (0, 0)
const shapeKey = () => (game.hex ? `h${game.hex.side}x${game.hex.length}` : `${game.W}x${game.H}`);

/* ---------- state ---------- */
let game = G.newGame();
let info = G.computeBlobs(game);
let online = null;       // { code, version, room, pending, epoch, chain, timer }
let mode = 'play';       // 'play' | 'R' | 'B' (placing stones) | 'del' (hex: deleting a blob)
const placing = () => mode === 'R' || mode === 'B';
let sel = null;          // { x, y, level: 1 (king) | 2 (blob) }
let hover = null;
let painting = null, paintBoard = null, paintChanges = null;
let drag = null;         // blob drag: { gx, gy, moved, shift }
let kbd = null;          // keyboard-nudged blob offset
let message = '', showTurn = false;

function randId() { const a = new Uint8Array(12); crypto.getRandomValues(a); return Array.from(a, b => b.toString(16).padStart(2, '0')).join(''); }
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
};
const PLAYER = (() => {
  let id = store.get('rvb-player');
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) { id = randId(); store.set('rvb-player', id); }
  return id;
})();
const savedName = () => store.get('rvb-name') || '';

const onBoard = (x, y) => G.onBoard(game, x, y);
const inView = (x, y) => (game.hex ? onBoard(x, y) || G.HEX_DIRS.some(([a, b]) => onBoard(x + a, y + b))
  : x >= -1 && x <= game.W && y >= -1 && y <= game.H);
const blobAt = (x, y) => G.blobAt(game, info, x, y);
const selBlob = () => (sel && sel.level === 2 ? blobAt(sel.x, sel.y) : null);
const me = () => (online && online.room ? online.room.you : null);
const spectating = () => !!online && !me();
const actor = () => (online ? (me() ? { color: me() } : { spectator: true }) : {});

/* ---------- actions ---------- */
function dispatch(action) {
  const r = G.applyAction(game, action, actor());
  if (!r.ok) { message = esc(r.error); showTurn = false; changed(); return false; }
  message = esc(r.message); showTurn = r.moved;
  if (r.moved) { sel = null; drag = null; kbd = null; if (mode === 'del') mode = 'play'; }
  changed();
  if (online) sendAction(action); else saveLocal();
  return true;
}
function saveLocal() { store.set('rvb-local-game', JSON.stringify(game)); }

function turnText() {
  let s = `<b>${NAME[game.turn]}</b> to move` + (game.per > 1 ? ` (${ORD[game.per - game.left + 1] || ''} of ${game.per})` : '');
  if (me() && me() === game.turn) s += ' — <b>your turn</b>';
  return s;
}

/* ---------- online ---------- */
async function api(method, params) {
  const url = method === 'GET' ? '/api/room?' + new URLSearchParams(params) : '/api/room';
  const opt = method === 'GET' ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) };
  let res;
  try { res = await fetch(url, opt); }
  catch { return { status: 0, error: 'Can\'t reach the game server — check your connection.' }; }
  let data;
  try { data = await res.json(); } catch { data = { error: `Server error (${res.status}).` }; }
  return { status: res.status, ...data };
}

function setNet(text, bad = false) {
  const el = $('net');
  el.textContent = text;
  el.classList.toggle('bad', bad);
}

function enterRoom(code, version, room) {
  stopOnline();
  online = { code, version: 0, room, pending: 0, epoch: 0, chain: Promise.resolve(), timer: null };
  window.history.replaceState(null, '', '?room=' + code);
  mode = 'play'; sel = null; message = ''; showTurn = false;
  showGame();
  applyRoom(room, version);
  online.timer = setTimeout(poll, 1000);
}
function stopOnline() {
  if (online) clearTimeout(online.timer);
  online = null;
}
function applyRoom(room, version) {
  online.room = room;
  online.version = version;
  game = G.normalize(room.game);
  changed();
  renderRoomBar();
}

function sendAction(action) {
  const o = online, epoch = o.epoch;
  o.pending++;
  setNet('Saving…');
  o.chain = o.chain.then(async () => {
    if (online !== o || o.epoch !== epoch) return;
    const r = await api('POST', { op: 'action', code: o.code, player: PLAYER, action, baseVersion: o.version });
    if (online !== o) return;
    if (r.ok) {
      o.version = r.version;
      o.room = r.room;
      if (o.pending === 1) { game = G.normalize(r.room.game); changed(); renderRoomBar(); }
    } else {
      o.epoch++;                                     // drop anything queued behind this
      message = esc(r.error || 'Something went wrong.'); showTurn = false; sel = null;
      if (r.room) applyRoom(r.room, r.version); else { changed(); resync(); }
    }
  }).catch(e => console.error(e)).finally(() => {
    if (online !== o) return;
    o.pending--;
    if (!o.pending) setNet('');
  });
}

async function resync() {
  const o = online; if (!o) return;
  const r = await api('GET', { code: o.code, v: 0, player: PLAYER });
  if (online === o && r.room) applyRoom(r.room, r.version);
}

async function poll() {
  const o = online; if (!o) return;
  clearTimeout(o.timer);
  if (!document.hidden && o.pending === 0 && !painting && !drag) {
    const r = await api('GET', { code: o.code, v: o.version, player: PLAYER });
    if (online !== o) return;
    if (r.status === 200) {
      setNet('');
      if (!r.same && r.room && o.pending === 0 && r.version > o.version && !painting && !drag) {
        const lastKey = l => (l.length ? `${l.length}|${l[l.length - 1].t}` : '');
        const before = lastKey(game.log);
        applyRoom(r.room, r.version);
        const last = game.log[game.log.length - 1];
        if (last && lastKey(game.log) !== before && !sel) {
          message = esc(last.note ? last.t : `${NAME[last.c]} ${last.t}.`);
          showTurn = !last.note;
          changed();
        }
      }
    } else if (r.status === 404) {
      message = esc(r.error); setNet('Room not found', true); changed();
      return;                                        // stop polling
    } else {
      setNet('Connection problem — retrying…', true);
    }
  }
  const waiting = !me() || game.turn !== me();
  o.timer = setTimeout(poll, document.hidden ? 6000 : waiting ? 1000 : 2500);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && online) poll(); });

async function seatOp(color) {
  const o = online; if (!o) return;
  await o.chain;
  const r = await api('POST', { op: 'seat', code: o.code, player: PLAYER, name: savedName() || 'Player', color });
  if (online !== o) return;
  if (r.room) applyRoom(r.room, r.version);
  message = esc(r.ok ? r.message : r.error); showTurn = false;
  changed();
}
async function freeSeat(color) {
  const o = online; if (!o) return;
  await o.chain;
  const r = await api('POST', { op: 'free', code: o.code, player: PLAYER, color });
  if (online !== o) return;
  if (r.room) applyRoom(r.room, r.version);
  message = esc(r.ok ? r.message : r.error); showTurn = false;
  changed();
}

function smallBtn(text, fn) {
  const b = document.createElement('button');
  b.className = 'small'; b.textContent = text; b.onclick = fn;
  return b;
}
function renderRoomBar() {
  const bar = $('roombar');
  if (!online || !online.room) { bar.hidden = true; return; }
  bar.hidden = false;
  const r = online.room;
  $('roomCode').textContent = online.code;
  for (const c of ['B', 'R']) {
    const el = $('seat' + c), s = r.seats[c];
    el.textContent = '';
    const lab = document.createElement('b'); lab.textContent = NAME[c] + ':';
    el.append(lab, ' ');
    if (s) {
      el.append(s.name + (r.you === c ? ' (you)' : ''));
      if (r.you === c) el.append(' ', smallBtn('Leave seat', () => seatOp(null)));
      else if (r.host) el.append(' ', smallBtn('Free seat', () => freeSeat(c)));
    } else {
      const open = document.createElement('span'); open.className = 'open'; open.textContent = 'open';
      el.append(open, ' ', smallBtn(r.you ? 'Switch here' : 'Sit here', () => seatOp(c)));
    }
  }
}

/* ---------- lobby & screens ---------- */
let pickColor = 'B';
function showLobby(opts = {}) {
  stopOnline();
  mode = 'play'; sel = null;
  $('lobby').hidden = false; $('gameView').hidden = true; $('scorebar').hidden = true; $('menuBtn').hidden = true;
  $('nameInput').value = savedName();
  $('lobbyErr').textContent = opts.error || '';
  $('joinCard').hidden = true;
  document.title = 'Red vs Blue';
  if (!opts.keepUrl) window.history.replaceState(null, '', location.pathname);
}
function showGame() {
  $('lobby').hidden = true; $('gameView').hidden = false; $('scorebar').hidden = false; $('menuBtn').hidden = false;
  $('optsShared').hidden = !online;
  canvasKey = '';                                    // force a canvas resize
  changed();
}

function lobbyName() {
  const n = $('nameInput').value.replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!n) { $('lobbyErr').textContent = 'Type your name first.'; $('nameInput').focus(); return null; }
  store.set('rvb-name', n);
  return n;
}

$('colorPick').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  pickColor = b.dataset.c;
  for (const x of $('colorPick').children) x.classList.toggle('on', x === b);
});
$('createBtn').onclick = async () => {
  const name = lobbyName(); if (!name) return;
  $('createBtn').disabled = true; $('lobbyErr').textContent = '';
  const r = await api('POST', { op: 'create', player: PLAYER, name, color: pickColor });
  $('createBtn').disabled = false;
  if (!r.ok) { $('lobbyErr').textContent = r.error || 'Couldn\'t create a game.'; return; }
  enterRoom(r.code, r.version, r.room);
  message = 'Room created! Click <b>Copy invite link</b> and send it to your friend.';
  changed();
};
const joinByCode = () => {
  const code = $('joinCode').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{5}$/.test(code)) { $('lobbyErr').textContent = 'Room codes are 5 letters/numbers.'; return; }
  joinFlow(code);
};
$('joinBtn').onclick = joinByCode;
$('joinCode').addEventListener('keydown', e => { if (e.key === 'Enter') joinByCode(); });
$('localBtn').onclick = () => startLocal();
$('menuBtn').onclick = () => showLobby();

async function joinFlow(code) {
  $('lobbyErr').textContent = '';
  const r = await api('GET', { code, v: 0, player: PLAYER });
  if (r.status !== 200 || !r.room) { showLobby({ error: r.error || 'Couldn\'t open that room.' }); return; }
  if (r.room.you) { enterRoom(code, r.version, r.room); return; }   // already seated here
  showLobby({ keepUrl: true });
  window.history.replaceState(null, '', '?room=' + code);
  const s = r.room.seats, open = ['B', 'R'].filter(c => !s[c]);
  $('joinCard').hidden = false;
  $('joinCardCode').textContent = code;
  const who = ['B', 'R'].map(c => `${NAME[c]}: ${s[c] ? s[c].name : 'open'}`).join(' · ');
  $('joinCardInfo').textContent = `${who}. ` + (open.length ? `You'll play ${NAME[open[0]]}.` : 'Both seats are taken — you can watch.');
  $('joinCardBtn').textContent = open.length ? `Join as ${NAME[open[0]]}` : 'Watch the game';
  $('joinCardBtn').onclick = async () => {
    const name = lobbyName(); if (!name) return;
    const again = await api('GET', { code, v: 0, player: PLAYER });
    if (again.status !== 200 || !again.room) { showLobby({ error: again.error || 'Couldn\'t open that room.' }); return; }
    enterRoom(code, again.version, again.room);
    const free = ['B', 'R'].find(c => !again.room.seats[c]);
    if (free && !again.room.you) seatOp(free);
  };
  $('nameInput').focus();
}

function startLocal() {
  stopOnline();
  let g = null;
  try {
    g = JSON.parse(store.get('rvb-local-game'));
    if (!g || !G.decodePosition(G.encodePosition(g)) || !Array.isArray(g.log) || !Array.isArray(g.history) || !g.opts) g = null;
  } catch { g = null; }
  game = G.normalize(g || G.newGame());
  window.history.replaceState(null, '', '?local');
  mode = 'play'; sel = null; message = ''; showTurn = false;
  $('roombar').hidden = true;
  showGame();
}

/* ---------- input ---------- */
function cellAt(e) {
  const r = canvas.getBoundingClientRect();
  if (!game.hex) return { x: Math.floor((e.clientX - r.left) / cs) - 1, y: Math.floor((e.clientY - r.top) / cs) - 1 };
  // pixel -> axial (pointy-top hexes), then cube rounding
  const px = e.clientX - r.left - hexO.x, py = e.clientY - r.top - hexO.y;
  const q = (SQ3 / 3 * px - py / 3) / cs, rr = (2 / 3 * py) / cs, sx = -q - rr;
  let rq = Math.round(q), rz = Math.round(rr), ry = Math.round(sx);
  const dq = Math.abs(rq - q), dz = Math.abs(rz - rr), dy = Math.abs(ry - sx);
  if (dq > dy && dq > dz) rq = -ry - rz; else if (dy <= dz) rz = -rq - ry;
  return { x: rq, y: rz };
}
// Who would be deleting the blob of colour c (hex mode), or null if not allowed now.
function deleter(c) {
  const d = G.opp(c);
  if (online) return me() === d && (!game.opts.enforce || game.turn === d) ? d : null;
  return !game.opts.enforce || game.turn === d ? d : null;
}

function selectProblem(c) {
  if (online) {
    if (!me()) return 'You\'re watching — take an open seat to play.';
    if (c !== me()) return `That's a ${NAME[c].toLowerCase()} stone — you're playing ${NAME[me()]}.`;
    if (game.opts.enforce && c !== game.turn) return `Waiting for ${NAME[game.turn]} to move.`;
    return null;
  }
  if (game.opts.enforce && c !== game.turn) return `It's <b>${NAME[game.turn]}</b>'s turn.`;
  return null;
}

function doBlob(dx, dy) { dispatch({ type: 'blob', ax: sel.x, ay: sel.y, dx, dy }); }

function playClick(x, y, shift) {
  const b = game.board;
  if (sel) {
    if (sel.level === 1) {
      if (x === sel.x && y === sel.y) {
        sel.level = 2;
        const bl = blobAt(x, y);
        const stuck = G.isPoints(game) ? G.clusterOf(info, bl).cells.length - bl.size : 0;
        message = `Blob selected (${bl.size} stone${bl.size > 1 ? 's' : ''}). Click where the ringed stone should go and the rest of the blob follows — or drag any of its stones.`
          + (stuck ? ` The ${stuck} stone${stuck > 1 ? 's' : ''} stuck to it (dashed) will be dragged along.` : '');
        showTurn = false; changed(); return;
      }
      const t = G.kingTargets(game, info, sel.x, sel.y).find(t => t.tx === x && t.ty === y);
      const noDeath = G.isPoints(game) || G.isHybrid(game);
      if (t && (noDeath ? t.o === 'empty' || t.o === 'score' : (t.o !== 'self' || shift))) { dispatch({ type: 'king', fx: t.fx, fy: t.fy, tx: t.tx, ty: t.ty }); return; }
      if (t && noDeath && !(onBoard(x, y) && b[y][x])) {
        message = t.o === 'forbidden' ? G.FORBIDDEN_KING : G.isHybrid(game) ? G.BLOCKED_KING_H : G.BLOCKED_KING;
        showTurn = false; changed(); return;
      }
    } else {
      if (x === sel.x && y === sel.y) { sel = null; message = ''; changed(); return; }
      const bl = blobAt(sel.x, sel.y), dx = x - sel.x, dy = y - sel.y;
      const ownOther = onBoard(x, y) && b[y][x] === bl.color && info.id[y][x] !== bl.index;
      const plan = G.blobPlan(game, info, bl, dx, dy);
      if (plan.valid) {
        if (!ownOther || shift) { doBlob(dx, dy); return; }
      } else if (!ownOther) { message = plan.reason; showTurn = false; changed(); return; }
    }
  }
  if (onBoard(x, y) && b[y][x]) {
    const p = selectProblem(b[y][x]);
    if (p) { sel = null; message = p; showTurn = false; changed(); return; }
    sel = { x, y, level: 1 };
    const bl = blobAt(x, y);
    message = `Stone selected. Click a marked square to move it` +
      (bl.size > 1 ? `, or click it again to select its whole blob (${bl.size} stones).` : `, or click it again to move it as a 1-stone blob.`);
    showTurn = false; changed(); return;
  }
  sel = null; message = ''; changed();
}

function paintCell(x, y) {
  if (!onBoard(x, y)) return;
  const cur = paintBoard[y][x];
  const v = painting.action === 'paint' ? mode : (cur === mode ? null : cur);
  if (v && G.isPoints(game) && G.pointAt(game, x, y) === G.opp(v)) return;   // can't sit on an opponent's point
  if (cur !== v) { paintBoard[y][x] = v; paintChanges.set(x + ',' + y, [x, y, v]); }
}
function finishPaint() {
  const changes = [...paintChanges.values()];
  painting = null; paintBoard = null; paintChanges = null;
  if (changes.length) dispatch({ type: 'edit', changes }); else render();
}

canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const { x, y } = cellAt(e);
  hover = { x, y };
  if (mode === 'del') {
    if (onBoard(x, y) && game.board[y][x]) dispatch({ type: 'delete', x, y });
    else { message = 'Click a blob of your opponent\'s to delete it, or press the button again to cancel.'; showTurn = false; changed(); }
    return;
  }
  if (placing()) {
    if (!onBoard(x, y) || spectating()) return;
    paintBoard = game.board.map(r => r.slice());
    paintChanges = new Map();
    painting = { action: paintBoard[y][x] === mode ? 'erase' : 'paint' };
    paintCell(x, y);
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    render(); return;
  }
  const bl = selBlob();
  if (bl && onBoard(x, y) && info.id[y][x] === bl.index) {
    // pressing on a stone of the selected blob: a click, or the start of a drag
    drag = { gx: x, gy: y, moved: false, shift: e.shiftKey };
    kbd = null;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    render(); return;
  }
  playClick(x, y, e.shiftKey);
});
canvas.addEventListener('pointermove', e => {
  const c = cellAt(e);
  if (hover && hover.x === c.x && hover.y === c.y) return;
  hover = c;
  kbd = null;
  if (drag && (c.x !== drag.gx || c.y !== drag.gy)) drag.moved = true;
  if (painting) paintCell(c.x, c.y);
  render();
});
window.addEventListener('pointerup', e => {
  if (painting) { finishPaint(); return; }
  if (!drag) return;
  const d = drag; drag = null;
  if (!d.moved) { playClick(d.gx, d.gy, d.shift); return; }
  const c = cellAt(e), bl = selBlob();
  const dx = c.x - d.gx, dy = c.y - d.gy;
  if (!bl || (!dx && !dy)) { render(); return; }
  const plan = G.blobPlan(game, info, bl, dx, dy);
  if (plan.valid) doBlob(dx, dy);
  else { message = plan.reason; showTurn = false; changed(); }
});
canvas.addEventListener('pointerleave', () => { if (!painting && !drag) { hover = null; render(); } });

document.addEventListener('keydown', e => {
  if (['SELECT', 'INPUT', 'TEXTAREA'].includes(e.target.tagName) || $('gameView').hidden) return;
  if (e.key === 'Escape') { sel = null; if (mode !== 'play') setMode(mode); else { message = ''; changed(); } return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (!spectating()) dispatch({ type: 'undo' }); return; }
  const bl = selBlob();
  if (!bl) return;
  const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (step) {
    e.preventDefault();
    if (!kbd) kbd = { dx: 0, dy: 0 };
    kbd.dx = Math.max(-game.W, Math.min(game.W, kbd.dx + step[0]));
    kbd.dy = Math.max(-game.H, Math.min(game.H, kbd.dy + step[1]));
    render(); return;
  }
  if (e.key === 'Enter' && kbd) {
    e.preventDefault();
    const plan = G.blobPlan(game, info, bl, kbd.dx, kbd.dy);
    if (plan.valid) doBlob(kbd.dx, kbd.dy);
    else { message = plan.reason; showTurn = false; changed(); }
  }
});

function setMode(m) {
  mode = mode === m ? 'play' : m;
  sel = null; message = ''; showTurn = false;
  changed();
}

/* ---------- toolbar ---------- */
$('addB').onclick = () => setMode('B');
$('addR').onclick = () => setMode('R');
$('delBtn').onclick = () => setMode('del');
$('undo').onclick = () => dispatch({ type: 'undo' });
$('switchTurn').onclick = () => dispatch({ type: 'switchTurn' });
$('resetScores').onclick = () => dispatch({ type: 'resetScores' });
$('clear').onclick = () => dispatch({ type: 'clear' });
const applySize = () => dispatch(game.hex
  ? { type: 'resize', side: Math.round(+$('hs').value) || game.hex.side, length: Math.round(+$('hl').value) || game.hex.length }
  : { type: 'resize', w: Math.round(+$('bw').value) || game.W, h: Math.round(+$('bh').value) || game.H });
$('applySize').onclick = applySize;
for (const id of ['bw', 'bh', 'hs', 'hl']) $(id).addEventListener('keydown', e => { if (e.key === 'Enter') applySize(); });
$('enforce').onchange = e => { sel = null; dispatch({ type: 'options', enforce: e.target.checked }); };
$('order').onchange = e => dispatch({ type: 'options', order: e.target.value });
$('gmode').onchange = e => { sel = null; dispatch({ type: 'options', mode: e.target.value }); };
$('singleSize').onchange = e => dispatch({ type: 'options', singleSize: e.target.value });

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) {}
  ta.remove();
  return ok;
}
const codebox = $('codebox'), codeText = $('codeText');
function openCodebox(title, text, hint) {
  $('codeTitle').textContent = title;
  $('codeHint').textContent = hint || '';
  codeText.value = text || '';
  codebox.hidden = false;
  codeText.focus(); if (text) codeText.select();
}
$('codeClose').onclick = () => { codebox.hidden = true; };
$('codeLoad').onclick = () => {
  if (!G.decodePosition(codeText.value)) { $('codeHint').textContent = 'That doesn\'t look like a position code (it should start with RVB1;).'; return; }
  codebox.hidden = true;
  dispatch({ type: 'load', code: codeText.value.replace(/\s+/g, '') });
};
$('copyPos').onclick = async () => {
  const code = G.encodePosition(game);
  if (await copyText(code)) {
    codebox.hidden = true;
    message = `Position copied to your clipboard (${code.length} characters). Paste it anywhere to keep it; use "Paste position from clipboard" to load it back.`;
  } else {
    openCodebox('Copy this position code', code, 'Your browser blocked clipboard access. Select the text above and copy it (Ctrl+C / ⌘C).');
    message = 'Couldn\'t reach the clipboard — the code is shown above to copy by hand.';
  }
  showTurn = false; changed();
};
$('pastePos').onclick = async () => {
  let text = null;
  try { text = await navigator.clipboard.readText(); } catch (_) {}
  if (text == null) { openCodebox('Paste a position code', '', 'Your browser didn\'t allow reading the clipboard directly. Paste into the box, then click Load.'); return; }
  if (!G.decodePosition(text)) { openCodebox('Paste a position code', text.slice(0, 2000), 'What\'s on your clipboard isn\'t a position code. Paste one here, then click Load.'); return; }
  codebox.hidden = true;
  dispatch({ type: 'load', code: text.replace(/\s+/g, '') });
};
document.addEventListener('paste', e => {
  if (['INPUT', 'TEXTAREA'].includes(e.target.tagName) || $('gameView').hidden || spectating()) return;
  const text = e.clipboardData && e.clipboardData.getData('text');
  if (G.decodePosition(text)) { e.preventDefault(); codebox.hidden = true; dispatch({ type: 'load', code: text.replace(/\s+/g, '') }); }
});
$('save').onclick = () => {
  message = store.set('rvb-saved-position', G.encodePosition(game))
    ? `Position saved in this browser (${game.W} × ${game.H} board).` : 'Couldn\'t save — browser storage is unavailable here.';
  showTurn = false; changed();
};
$('load').onclick = () => {
  const code = store.get('rvb-saved-position');
  if (!G.decodePosition(code)) { message = 'No saved position found in this browser.'; showTurn = false; changed(); return; }
  dispatch({ type: 'load', code });
};
$('inviteBtn').onclick = async () => {
  if (!online) return;
  const link = `${location.origin}${location.pathname}?room=${online.code}`;
  message = (await copyText(link)) ? `Invite link copied — send it to your friend: <b>${esc(link)}</b>` : `Send your friend this link: <b>${esc(link)}</b>`;
  showTurn = false; changed();
};

/* ---------- drawing ---------- */
function resize() {
  if ($('gameView').hidden) return;
  const W = game.W, H = game.H;
  const avail = document.querySelector('.board-wrap').clientWidth - 22;
  const availH = Math.max(300, window.innerHeight - 140);
  if (game.hex) {
    // cs = hex radius. Middle row has length+side-1 hexes; one ring of edge hexes all round.
    const { side: S, length: L } = game.hex;
    const unitsW = (L + S - 1 + 2) * SQ3 + 0.6, unitsH = (2 * S - 1 + 2) * 1.5 + 0.5 + 0.6;
    cs = Math.max(8, Math.min(40, Math.floor(Math.min(avail / unitsW, availH / unitsH))));
    canvasPxW = Math.ceil(unitsW * cs); canvasPxH = Math.ceil(unitsH * cs);
    // leftmost centre (middle row, q + r/2 = (S-1)/2) sits one hex width in from the left margin
    hexO = { x: 0.3 * cs + SQ3 * cs * 1.5 - SQ3 * cs * (S - 1) / 2, y: 0.3 * cs + cs + 1.5 * cs };
  } else {
    cs = Math.max(12, Math.min(44, Math.floor(avail / (W + 2)), Math.floor(availH / (H + 2))));
    canvasPxW = (W + 2) * cs; canvasPxH = (H + 2) * cs;
  }
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvasPxW * dpr; canvas.height = canvasPxH * dpr;
  canvas.style.width = canvasPxW + 'px'; canvas.style.height = canvasPxH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  canvasKey = shapeKey();
  render();
}
window.addEventListener('resize', resize);

// Pixel centre of cell (x, y): squares, or pointy-top hexes in axial coordinates.
function C(x, y) { return game.hex ? [hexO.x + cs * SQ3 * (x + y / 2), hexO.y + cs * 1.5 * y] : [(x + 1.5) * cs, (y + 1.5) * cs]; }
function hexPath(x, y, r = cs) {
  const [px, py] = C(x, y);
  ctx.beginPath();
  for (let i = 0; i < 6; i++) { const a = Math.PI / 180 * (60 * i - 30); ctx[i ? 'lineTo' : 'moveTo'](px + r * Math.cos(a), py + r * Math.sin(a)); }
  ctx.closePath();
}
// The edge of hex (x, y) facing neighbour direction d.
const HEX_ANG = { '1,0': 0, '0,1': 60, '-1,1': 120, '-1,0': 180, '0,-1': 240, '1,-1': 300 };
function hexEdge(x, y, d) {
  const [px, py] = C(x, y), t = HEX_ANG[d.join(',')];
  const v = deg => [px + cs * Math.cos(deg * Math.PI / 180), py + cs * Math.sin(deg * Math.PI / 180)];
  const [a, b] = [v(t - 30), v(t + 30)];
  ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
}
function cellRect(x, y, fill) {
  ctx.fillStyle = fill;
  if (game.hex) { hexPath(x, y); ctx.fill(); } else ctx.fillRect((x + 1) * cs, (y + 1) * cs, cs, cs);
}
function circle(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); }
// Ring around one cell: a circle round a stone, or an inset hex outline on a hex tile.
function ring(x, y, r) { if (game.hex) hexPath(x, y, cs * (r >= 0.47 ? 0.8 : 0.86)); else circle(...C(x, y), cs * r); }
function cross(px, py, s, color, alpha = 1) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2, cs * 0.12);
  ctx.beginPath(); ctx.moveTo(px - s, py - s); ctx.lineTo(px + s, py + s); ctx.moveTo(px + s, py - s); ctx.lineTo(px - s, py + s); ctx.stroke();
  ctx.restore();
}
function marker(x, y, o, color) {
  const [px, py] = C(x, y);
  switch (o) {
    case 'empty': ctx.fillStyle = `rgba(${RGB[color]},.75)`; circle(px, py, cs * 0.15); ctx.fill(); break;
    case 'win': ctx.strokeStyle = COL.win; ctx.lineWidth = Math.max(2.5, cs * 0.13); circle(px, py, cs * 0.44); ctx.stroke(); break;
    case 'lose': case 'self': case 'wall': cross(px, py, cs * 0.2, COL.x); break;
    case 'score':
      ctx.fillStyle = COL[color + 'd']; ctx.font = `800 ${Math.round(cs * 0.5)}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('+1', px, py + 1); break;
  }
}
function drawStone(x, y, c, alpha = 1, carrying = false) {
  if (game.hex) {                                   // hex mode: the stone fills its whole hex
    ctx.save(); ctx.globalAlpha = alpha;
    hexPath(x, y, cs + 0.5); ctx.fillStyle = COL[c]; ctx.fill();
    hexPath(x, y, cs); ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
    return;
  }
  const [px, py] = C(x, y);
  ctx.save(); ctx.globalAlpha = alpha;
  circle(px, py, cs * 0.38); ctx.fillStyle = carrying ? COL[c + 'l'] : COL[c]; ctx.fill();
  ctx.lineWidth = Math.max(1, cs * 0.06); ctx.strokeStyle = COL[c + 'd']; ctx.stroke();
  if (carrying) {
    circle(px, py, cs * 0.15); ctx.fillStyle = COL.gold; ctx.fill();
    ctx.lineWidth = Math.max(1, cs * 0.04); ctx.strokeStyle = COL.goldDark; ctx.stroke();
  } else {
    circle(px - cs * 0.11, py - cs * 0.11, cs * 0.12); ctx.fillStyle = 'rgba(255,255,255,.28)'; ctx.fill();
  }
  ctx.restore();
}
function diamond(x, y, r, fill, stroke) {
  const [px, py] = C(x, y);
  ctx.beginPath(); ctx.moveTo(px, py - r); ctx.lineTo(px + r, py); ctx.lineTo(px, py + r); ctx.lineTo(px - r, py); ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = Math.max(2, cs * 0.1); ctx.stroke(); }
}
// Points-mode marker for a landing square: +1 delivers, hollow diamond picks up, dot = plain move.
function pointsMarker(m, plainDot) {
  if (m.deliver) {
    ctx.fillStyle = COL[m.c + 'd']; ctx.font = `800 ${Math.round(cs * 0.5)}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; { const [px, py] = C(m.tx, m.ty); ctx.fillText('+1', px, py + 1); }
  } else if (m.pick) diamond(m.tx, m.ty, cs * 0.3, null, COL[m.c + 'd']);
  else if (plainDot) { ctx.fillStyle = `rgba(${RGB[m.c]},.75)`; circle(...C(m.tx, m.ty), cs * 0.15); ctx.fill(); }
}
function setPreview(text, bad) {
  const el = $('preview');
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle('bad', !!bad);
}

// Hex board: a ring of edge hexes (grey = wall, blue/red = that side scores there), then the cells.
function drawHexBackground() {
  const W = game.W, H = game.H;
  ctx.fillStyle = '#fffdf8'; ctx.fillRect(0, 0, canvasPxW, canvasPxH);
  const ring = new Map();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!onBoard(x, y)) continue;
    for (const [dx, dy] of G.HEX_DIRS) {
      const nx = x + dx, ny = y + dy, k = nx + ',' + ny;
      if (onBoard(nx, ny) || ring.has(k)) continue;
      ring.set(k, [nx, ny, ny < 0 || ny >= H ? 'wall' : nx > G.hexRowEnd(game, ny) ? 'B' : 'R']);
    }
  }
  ctx.font = `700 ${Math.max(9, Math.round(cs * 0.75))}px system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const [x, y, kind] of ring.values()) {
    hexPath(x, y);
    ctx.fillStyle = kind === 'wall' ? COL.side : kind === 'B' ? COL.blueGoal : COL.redGoal; ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.07)'; ctx.lineWidth = 1; ctx.stroke();
    if (kind !== 'wall') { const [px, py] = C(x, y); ctx.globalAlpha = .45; ctx.fillStyle = kind === 'B' ? COL.Bd : COL.Rd; ctx.fillText(kind === 'B' ? '→' : '←', px, py + 1); ctx.globalAlpha = 1; }
  }
  const shades = [COL.cellA, COL.cellB, '#f4eee2'];
  ctx.lineWidth = 1; ctx.strokeStyle = COL.grid;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!onBoard(x, y)) continue;
    hexPath(x, y); ctx.fillStyle = shades[((x - y) % 3 + 3) % 3]; ctx.fill(); ctx.stroke();
  }
  ctx.strokeStyle = '#8f8672'; ctx.lineWidth = 2; ctx.beginPath();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!onBoard(x, y)) continue;
    for (const d of G.HEX_DIRS) if (!onBoard(x + d[0], y + d[1])) hexEdge(x, y, d);
  }
  ctx.stroke();
}

function render() {
  if ($('gameView').hidden || canvasKey !== shapeKey()) return;
  const W = game.W, H = game.H;
  const cw = canvasPxW, ch = canvasPxH, b = paintBoard || game.board;
  ctx.clearRect(0, 0, cw, ch);
  const pm = G.isPoints(game);
  if (game.hex) drawHexBackground(); else {

  // walls
  ctx.fillStyle = COL.side; ctx.fillRect(0, 0, cw, ch);
  ctx.font = `700 ${Math.max(9, Math.round(cs * 0.45))}px system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (!pm) {
    ctx.fillStyle = COL.blueGoal; ctx.fillRect(cs, 0, W * cs, cs);
    ctx.fillStyle = COL.redGoal; ctx.fillRect(cs, (H + 1) * cs, W * cs, cs);
    const wide = ctx.measureText('▼ RED SCORES ▼').width + 40 <= W * cs;
    const nLab = wide ? Math.max(1, Math.min(3, Math.floor(W * cs / 300))) : 1;
    for (let i = 0; i < nLab; i++) {
      const f = (i + 0.5) / nLab;
      ctx.fillStyle = COL.Bd; ctx.fillText(wide ? '▲ BLUE SCORES ▲' : '▲', cs + W * cs * f, cs / 2 + 1);
      ctx.fillStyle = COL.Rd; ctx.fillText(wide ? '▼ RED SCORES ▼' : '▼', cs + W * cs * f, (H + 1.5) * cs + 1);
    }
  } else {
    const top = 'BLUE POINTS  ·  RED HOME', bot = 'BLUE HOME  ·  RED POINTS';
    if (ctx.measureText(top).width + 20 <= W * cs) {
      ctx.fillStyle = '#4a443b';
      ctx.fillText(top, cs + W * cs / 2, cs / 2 + 1);
      ctx.fillText(bot, cs + W * cs / 2, (H + 1.5) * cs + 1);
    }
  }

  // board
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) cellRect(x, y, (x + y) % 2 ? COL.cellB : COL.cellA);
  ctx.strokeStyle = COL.grid; ctx.lineWidth = 1; ctx.beginPath();
  for (let x = 0; x <= W; x++) { ctx.moveTo((x + 1) * cs + .5, cs); ctx.lineTo((x + 1) * cs + .5, (H + 1) * cs); }
  for (let y = 0; y <= H; y++) { ctx.moveTo(cs, (y + 1) * cs + .5); ctx.lineTo((W + 1) * cs, (y + 1) * cs + .5); }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,.13)'; ctx.beginPath();
  if (W % 2 === 0) { ctx.moveTo((W / 2 + 1) * cs + .5, cs); ctx.lineTo((W / 2 + 1) * cs + .5, (H + 1) * cs); }
  if (H % 2 === 0) { ctx.moveTo(cs, (H / 2 + 1) * cs + .5); ctx.lineTo((W + 1) * cs, (H / 2 + 1) * cs + .5); }
  ctx.stroke();
  ctx.strokeStyle = '#8f8672'; ctx.lineWidth = 1.5; ctx.strokeRect(cs, cs, W * cs, H * cs);

  // points mode: home bases and the points still on the board
  if (pm) {
    const hr = Math.min(G.HOME_ROWS, H);
    ctx.fillStyle = `rgba(${RGB.R},.10)`; ctx.fillRect(cs, cs, W * cs, hr * cs);
    ctx.fillStyle = `rgba(${RGB.B},.10)`; ctx.fillRect(cs, (H - hr + 1) * cs, W * cs, hr * cs);
    ctx.save(); ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
    ctx.strokeStyle = `rgba(${RGB.R},.55)`; ctx.beginPath(); ctx.moveTo(cs, (hr + 1) * cs); ctx.lineTo((W + 1) * cs, (hr + 1) * cs); ctx.stroke();
    ctx.strokeStyle = `rgba(${RGB.B},.55)`; ctx.beginPath(); ctx.moveTo(cs, (H - hr + 1) * cs); ctx.lineTo((W + 1) * cs, (H - hr + 1) * cs); ctx.stroke();
    ctx.restore();
    for (let x = 0; x < W; x++) {
      if (game.pts.B[x] === '1') { cellRect(x, 0, `rgba(${RGB.B},.12)`); diamond(x, 0, cs * 0.2, COL.B); }
      if (game.pts.R[x] === '1') { cellRect(x, H - 1, `rgba(${RGB.R},.12)`); diamond(x, H - 1, cs * 0.2, COL.R); }
    }
  }

  } // end square background

  // last move
  const lm = game.lastMove;
  if (lm && !paintBoard) {
    for (const [x, y] of lm.from) if (onBoard(x, y)) cellRect(x, y, 'rgba(232,168,0,.14)');
    for (const [x, y] of lm.to) if (onBoard(x, y)) cellRect(x, y, 'rgba(232,168,0,.35)');
  }

  // blob mode: shade every square the grabbed stone can reach (under the stones)
  const bl = mode === 'play' ? selBlob() : null;
  const grip = bl ? (drag ? { x: drag.gx, y: drag.gy } : { x: sel.x, y: sel.y }) : null;
  if (bl) {
    ctx.fillStyle = `rgba(${RGB[bl.color]},.16)`;
    for (const [dx, dy] of G.legalOffsets(game, info, bl)) {
      const x = grip.x + dx, y = grip.y + dy;
      if (inView(x, y)) cellRect(x, y, `rgba(${RGB[bl.color]},.16)`);
    }
  }

  // blob connectors, then stones
  ctx.save(); ctx.lineCap = 'butt'; ctx.lineWidth = cs * 0.34;
  const linkDirs = game.hex ? [] : [[1, 0], [0, 1]];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = b[y][x]; if (!c) continue;
    ctx.strokeStyle = COL[c + 'd'];
    for (const [dx, dy] of linkDirs) {
      const nx = x + dx, ny = y + dy;
      if (ny < H && nx >= 0 && nx < W && b[ny][nx] === c) { ctx.beginPath(); ctx.moveTo(...C(x, y)); ctx.lineTo(...C(nx, ny)); ctx.stroke(); }
    }
  }
  ctx.restore();
  const carrying = pm ? G.carrySet(game) : null;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (b[y][x]) drawStone(x, y, b[y][x], 1, !!carrying && carrying.has(x + ',' + y));
  if (game.hex) {
    // outline each blob: a dark edge wherever a tile's neighbour isn't the same colour
    ctx.save(); ctx.lineWidth = Math.max(1.5, cs * 0.09); ctx.lineCap = 'round';
    for (const c of ['B', 'R']) {
      ctx.strokeStyle = COL[c + 'd']; ctx.beginPath();
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (b[y][x] !== c) continue;
        for (const d of G.HEX_DIRS) { const nx = x + d[0], ny = y + d[1]; if (!(onBoard(nx, ny) && b[ny][nx] === c)) hexEdge(x, y, d); }
      }
      ctx.stroke();
    }
    // last move, drawn over the tiles: gold inset outline where stones landed
    if (lm && !paintBoard) {
      ctx.strokeStyle = COL.sel; ctx.lineWidth = Math.max(2, cs * 0.1);
      for (const [x, y] of lm.to) if (onBoard(x, y) && b[y][x]) { hexPath(x, y, cs * 0.62); ctx.stroke(); }
    }
    ctx.restore();
  }

  setPreview('');

  // delete mode (hex): highlight the whole blob under the pointer
  if (mode === 'del') {
    if (hover && onBoard(hover.x, hover.y) && b[hover.y][hover.x]) {
      const hb = blobAt(hover.x, hover.y), who = deleter(hb.color);
      if (who && game.deletes[who] > 0) {
        for (const [x, y] of hb.cells) { cellRect(x, y, 'rgba(107,42,36,.38)'); cross(...C(x, y), cs * 0.22, '#fff', .95); }
        const n = game.deletes[who];
        setPreview(`Delete this ${hb.size}-stone ${NAME[hb.color].toLowerCase()} blob — uses one of ${NAME[who]}'s moves (${n} delete${n === 1 ? '' : 's'} left).`);
      } else {
        setPreview(who ? `${NAME[who]} has no deletes left.` : online && me() === hb.color ? 'You can only delete your opponent\'s blobs.' : `It's ${NAME[game.turn]}'s turn — only ${NAME[G.opp(game.turn)].toLowerCase()} blobs can be deleted now.`, true);
      }
    }
    return;
  }

  // placement preview
  if (placing()) {
    if (hover && onBoard(hover.x, hover.y) && !spectating()) {
      if (b[hover.y][hover.x] === mode) cross(...C(hover.x, hover.y), cs * 0.2, '#fff', .9);
      else drawStone(hover.x, hover.y, mode, .45);
    }
    return;
  }

  // hover ring on stones
  if (hover && !drag && onBoard(hover.x, hover.y) && b[hover.y][hover.x] && !(sel && sel.x === hover.x && sel.y === hover.y)) {
    ctx.strokeStyle = 'rgba(0,0,0,.3)'; ctx.lineWidth = 2; ring(hover.x, hover.y, 0.46); ctx.stroke();
  }
  if (!sel) return;
  const c = b[sel.y][sel.x];

  if (sel.level === 1) {
    ctx.strokeStyle = COL.sel; ctx.lineWidth = 3; ring(sel.x, sel.y, 0.47); ctx.stroke();
    for (const t of G.kingTargets(game, info, sel.x, sel.y)) {
      if (t.o === 'self' || t.o === 'blocked') { if (inView(t.tx, t.ty)) cross(...C(t.tx, t.ty), cs * 0.14, COL.x, .25); continue; }
      if (t.o === 'forbidden') { cross(...C(t.tx, t.ty), cs * 0.18, COL.x, .7); continue; }
      if (hover && hover.x === t.tx && hover.y === t.ty) cellRect(t.tx, t.ty, `rgba(${RGB[c]},.22)`);
      if (pm) pointsMarker(t, true); else marker(t.tx, t.ty, t.o, c);
    }
    return;
  }

  // outline the selected blob and ring the grabbed stone
  const inBlob = (x, y) => onBoard(x, y) && info.id[y][x] === bl.index;
  ctx.save();
  ctx.strokeStyle = COL.sel; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath();
  for (const [x, y] of bl.cells) {
    if (game.hex) { for (const d of G.HEX_DIRS) if (!inBlob(x + d[0], y + d[1])) hexEdge(x, y, d); continue; }
    const X = (x + 1) * cs, Y = (y + 1) * cs;
    if (!inBlob(x, y - 1)) { ctx.moveTo(X, Y); ctx.lineTo(X + cs, Y); }
    if (!inBlob(x, y + 1)) { ctx.moveTo(X, Y + cs); ctx.lineTo(X + cs, Y + cs); }
    if (!inBlob(x - 1, y)) { ctx.moveTo(X, Y); ctx.lineTo(X, Y + cs); }
    if (!inBlob(x + 1, y)) { ctx.moveTo(X + cs, Y); ctx.lineTo(X + cs, Y + cs); }
  }
  ctx.stroke(); ctx.restore();
  ctx.strokeStyle = COL.sel; ctx.lineWidth = 3; ring(grip.x, grip.y, 0.47); ctx.stroke();
  if (pm) {
    ctx.save(); ctx.setLineDash([4, 3]); ctx.lineWidth = 2.5; ctx.strokeStyle = COL.sel;
    for (const [x, y] of G.clusterOf(info, bl).cells) if (!inBlob(x, y)) { circle(...C(x, y), cs * 0.47); ctx.stroke(); }
    ctx.restore();
  }

  // ghost preview of the blob at the hovered / dragged / keyboard offset
  let off = null;
  if (kbd) off = kbd;
  else if (hover && inView(hover.x, hover.y) && (!drag || drag.moved)) off = { dx: hover.x - grip.x, dy: hover.y - grip.y };
  if (!off || (!off.dx && !off.dy)) return;
  const plan = G.blobPlan(game, info, bl, off.dx, off.dy);
  const valid = plan.valid, moves = plan.moves;
  for (const m of moves) {
    if (!inView(m.tx, m.ty)) continue;
    if (valid) cellRect(m.tx, m.ty, `rgba(${RGB[m.c]},.26)`);
    if (onBoard(m.tx, m.ty) && (m.o === 'empty' || m.o === 'win' || !valid)) drawStone(m.tx, m.ty, m.c, valid ? .5 : .18, valid && !!m.carry);
  }
  if (valid) {
    for (const m of moves) if (inView(m.tx, m.ty)) { if (pm) pointsMarker(m, false); else if (m.o !== 'empty') marker(m.tx, m.ty, m.o, m.c); }
    const parts = [...(plan.dragged ? [`dragging ${plan.dragged} stuck stone${plan.dragged > 1 ? 's' : ''}`] : []), ...G.summarize(moves, bl.color)];
    setPreview(`Move ${G.offsetText(off.dx, off.dy, game)}${parts.length ? ' — ' + parts.join(', ') : ''}.${kbd ? ' Press Enter to confirm.' : ''}`);
  } else if (plan.reason === G.BLOCKED_BLOB || plan.reason === G.BLOCKED_BLOB_H) {
    for (const m of moves) if (m.o === 'blocked' && inView(m.tx, m.ty)) cross(...C(m.tx, m.ty), cs * 0.2, COL.x, .7);
    setPreview('Blocked — something would run into a wall or another stone.', true);
  } else if (plan.reason === G.GIFT_BLOB) {
    for (const m of moves) if (m.gift) cross(...C(m.tx, m.ty), cs * 0.22, COL.x, .8);
    setPreview('Illegal — a stone would land on one of its opponent\'s points.', true);
  } else {
    setPreview('Not reachable — the new position must overlap or edge-touch the old one.', true);
  }
}

/* ---------- UI ---------- */
function updateUI() {
  const b = game.board;
  let nR = 0, nB = 0;
  for (const row of b) for (const v of row) { if (v === 'R') nR++; else if (v === 'B') nB++; }
  $('scoreR').textContent = game.scores.R;
  $('scoreB').textContent = game.scores.B;
  $('countR').textContent = nR;
  $('countB').textContent = nB;
  $('wordR').textContent = nR === 1 ? 'stone' : 'stones';
  $('wordB').textContent = nB === 1 ? 'stone' : 'stones';
  $('carryR').textContent = game.carry.filter(([x, y]) => b[y] && b[y][x] === 'R').length;
  $('carryB').textContent = game.carry.filter(([x, y]) => b[y] && b[y][x] === 'B').length;
  document.body.dataset.mode = game.opts.mode;
  $('gmode').value = game.opts.mode;
  $('modeTag').textContent = { hybrid: 'Hybrid mode', hex: 'Hexagonal mode' }[game.opts.mode] || 'Points mode';
  $('delB').textContent = game.deletes.B; $('delR').textContent = game.deletes.R;
  if (game.hex) {
    if (document.activeElement !== $('hs')) $('hs').value = game.hex.side;
    if (document.activeElement !== $('hl')) $('hl').value = game.hex.length;
  }
  const seats = online && online.room ? online.room.seats : null;
  $('nameR').textContent = seats && seats.R ? seats.R.name : 'Red';
  $('nameB').textContent = seats && seats.B ? seats.B.name : 'Blue';

  const turn = $('turn');
  const mine = !!me() && me() === game.turn;
  turn.className = 'turn ' + game.turn + (mine ? ' mine' : '');
  turn.textContent = (mine ? 'Your move' : `${NAME[game.turn]} to move`) + (game.per > 1 ? ` · ${game.per - game.left + 1}/${game.per}` : '');

  $('addB').classList.toggle('active', mode === 'B');
  $('addR').classList.toggle('active', mode === 'R');
  const locked = spectating();
  for (const id of ['addB', 'addR', 'switchTurn', 'resetScores', 'clear', 'applySize', 'bw', 'bh', 'pastePos', 'load', 'codeLoad', 'enforce', 'order', 'singleSize', 'gmode', 'hs', 'hl']) $(id).disabled = locked;
  if (!game.hex && mode === 'del') mode = 'play';
  const dWho = online ? me() : game.turn, dLeft = dWho ? game.deletes[dWho] : 0;
  $('delBtn').textContent = mode === 'del' ? 'Cancel delete' : `Delete a${dWho ? ' ' + NAME[G.opp(dWho)].toLowerCase() : ''} blob (${dLeft} left)`;
  $('delBtn').classList.toggle('active', mode === 'del');
  $('delBtn').disabled = locked || (dLeft <= 0 && mode !== 'del');
  $('undo').disabled = locked || !game.history.length;
  if (locked && mode !== 'play') mode = 'play';

  $('enforce').checked = game.opts.enforce;
  $('order').value = game.opts.order;
  $('singleSize').value = game.opts.singleSize;
  if (document.activeElement !== $('bw')) $('bw').value = game.W;
  if (document.activeElement !== $('bh')) $('bh').value = game.H;

  let s;
  if (placing()) {
    const n = NAME[mode].toLowerCase();
    s = `<b>Placing ${n} stones.</b> Click or drag across ${game.hex ? 'hexes' : 'squares'} to add them; click a ${n} stone to remove it. Press the button again (or Esc) when you're done.`;
  } else if (mode === 'del') {
    const who = online ? me() : game.turn;
    s = message ? message : `<b>Delete mode.</b> Click a ${NAME[G.opp(who)].toLowerCase()} blob to delete all of it — this uses one of ${online ? 'your' : NAME[who] + '\'s'} moves (${game.deletes[who]} delete${game.deletes[who] === 1 ? '' : 's'} left). Press the button again or Esc to cancel.`;
  } else if (message) {
    s = message + (showTurn ? ` ${turnText()}.` : '');
  } else if (spectating()) {
    s = `You're watching. ${turnText()}.`;
  } else if (!game.opts.enforce) {
    s = `Turns aren't enforced — click any ${online ? 'of your stones' : 'stone'}. (${turnText()}.)`;
  } else if (online && !mine) {
    s = `${turnText()}. Waiting for them…`;
  } else {
    s = `${turnText()} — click one of your stones.`;
  }
  $('status').innerHTML = s;
  document.title = online && mine && game.opts.enforce ? '● Your move — Red vs Blue' : 'Red vs Blue';
}

let logKey = '';
function renderLog() {
  const log = game.log;
  const k = log.length + '|' + (log.length ? log[log.length - 1].t : '');
  if (k === logKey) return;
  logKey = k;
  const ul = $('log');
  ul.textContent = '';
  if (!log.length) { const li = document.createElement('li'); li.className = 'hint'; li.textContent = 'No moves yet.'; ul.appendChild(li); return; }
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i], li = document.createElement('li');
    if (e.note) li.className = 'note';
    const dot = document.createElement('span'); dot.className = 'dot';
    if (e.c) dot.style.background = COL[e.c];
    li.appendChild(dot);
    if (e.n) { const n = document.createElement('b'); n.textContent = e.n + '. '; li.appendChild(n); }
    li.appendChild(document.createTextNode(e.note ? e.t : `${NAME[e.c]} ${e.t}`));
    ul.appendChild(li);
  }
}

function changed() {
  info = G.computeBlobs(game);
  if (sel && !(onBoard(sel.x, sel.y) && game.board[sel.y][sel.x])) sel = null;
  if (sel && online && game.board[sel.y][sel.x] !== me()) sel = null;
  if (!sel || sel.level !== 2) { kbd = null; drag = null; }
  if (!$('gameView').hidden && canvasKey !== shapeKey()) resize();
  updateUI(); renderLog(); render();
}

// Read-only handle for debugging in the browser console: __rvb.game, __rvb.cs
window.__rvb = { get game() { return game; }, get cs() { return cs; }, center: (x, y) => C(x, y) };

/* ---------- start ---------- */
const params = new URLSearchParams(location.search);
const roomParam = (params.get('room') || '').trim().toUpperCase();
if (roomParam) joinFlow(roomParam);
else if (params.has('local')) startLocal();
else showLobby();

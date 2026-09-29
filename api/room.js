// Red vs Blue — game-room API (a single Vercel serverless function).
//
//   GET  /api/room?code=ABCDE&v=<version>&player=<id>
//        -> { version, same: true }             if nothing changed since <version>
//        -> { version, room }                   otherwise
//   POST /api/room  { op: 'create', player, name, color }          -> { ok, code, version, room }
//   POST /api/room  { op: 'seat',   code, player, name, color }    color 'B' | 'R' | null (leave)
//   POST /api/room  { op: 'free',   code, player, color }          host frees someone else's seat
//   POST /api/room  { op: 'action', code, player, action, baseVersion }
//
// The server applies every action with the same rules engine the browser uses
// (public/rules.js), so nobody can make an illegal move or move out of turn.

import { getStore } from '../lib/store.js';
import { newGame, applyAction, logNote, NAME } from '../public/rules.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;
const PLAYER_RE = /^[A-Za-z0-9_-]{8,64}$/;
// These actions only make sense on exactly the board the player was looking at.
const NEEDS_FRESH_BOARD = new Set(['king', 'blob', 'undo']);

const cleanName = n => (String(n ?? '').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Player');
const seatOf = (room, player) => (room.seats.B?.id === player ? 'B' : room.seats.R?.id === player ? 'R' : null);

// What a given player is allowed to see (never other players' ids).
function publicRoom(room, player) {
  const seat = c => (room.seats[c] ? { name: room.seats[c].name } : null);
  return { game: room.game, seats: { B: seat('B'), R: seat('R') }, you: seatOf(room, player), host: room.host === player };
}

function randomCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Read-modify-write with compare-and-set; retries if someone else wrote in between.
async function mutate(store, code, player, fn) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const cur = await store.read(code);
    if (!cur) return [404, { error: 'That room doesn\'t exist (rooms expire after two weeks without play).' }];
    const room = JSON.parse(cur.json);
    const r = fn(room, cur.version);
    if (r.error) {
      return [r.status || 400, { error: r.error, version: cur.version, room: publicRoom(JSON.parse(cur.json), player) }];
    }
    const nv = cur.version + 1;
    if (await store.cas(code, cur.version, JSON.stringify(room), nv)) {
      return [200, { ok: true, message: r.message || '', version: nv, room: publicRoom(room, player) }];
    }
    await sleep(10 + Math.random() * (40 + attempt * 30));   // randomised back-off spreads out simultaneous writers
  }
  return [503, { error: 'The server is busy — please try again.' }];
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const reply = (status, body) => res.status(status).json(body);

  let store;
  try { store = await getStore(); }
  catch (e) { return reply(500, { error: e.message }); }

  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      const code = String(q.code || '').toUpperCase();
      if (!CODE_RE.test(code)) return reply(400, { error: 'Room codes are 5 letters/numbers.' });
      const player = String(q.player || '');
      const have = Number(q.v) || 0;
      const ver = await store.getVersion(code);
      if (ver == null) return reply(404, { error: 'That room doesn\'t exist (rooms expire after two weeks without play).' });
      if (ver === have) return reply(200, { version: ver, same: true });
      const cur = await store.read(code);
      if (!cur) return reply(404, { error: 'That room doesn\'t exist.' });
      return reply(200, { version: cur.version, room: publicRoom(JSON.parse(cur.json), player) });
    }

    if (req.method !== 'POST') return reply(405, { error: 'Method not allowed.' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch { body = null; } }
    if (!body || typeof body !== 'object') return reply(400, { error: 'Bad request.' });

    const player = String(body.player || '');
    if (!PLAYER_RE.test(player)) return reply(400, { error: 'Missing player id.' });
    const name = cleanName(body.name);

    if (body.op === 'create') {
      const color = body.color === 'B' || body.color === 'R' ? body.color : null;
      for (let i = 0; i < 12; i++) {
        const code = randomCode();
        const room = { game: newGame(), seats: { B: null, R: null }, host: player, created: Date.now() };
        if (color) {
          room.seats[color] = { id: player, name };
          logNote(room.game, color, `${name} created the room and is playing ${NAME[color]}`);
        } else {
          logNote(room.game, null, `${name} created the room`);
        }
        if (await store.cas(code, '', JSON.stringify(room), 1)) {
          return reply(200, { ok: true, code, version: 1, room: publicRoom(room, player) });
        }
      }
      return reply(503, { error: 'Couldn\'t create a room — please try again.' });
    }

    const code = String(body.code || '').toUpperCase();
    if (!CODE_RE.test(code)) return reply(400, { error: 'Room codes are 5 letters/numbers.' });

    if (body.op === 'seat') {
      const want = body.color === 'B' || body.color === 'R' ? body.color : null;
      const [status, out] = await mutate(store, code, player, room => {
        const mine = seatOf(room, player);
        if (!want) {
          if (!mine) return { message: '' };
          room.seats[mine] = null;
          logNote(room.game, mine, `${name} left the ${NAME[mine]} seat`);
          return { message: 'You left your seat — you\'re now watching.' };
        }
        const taken = room.seats[want];
        if (taken && taken.id !== player) return { status: 409, error: `${NAME[want]} is already taken by ${taken.name}.` };
        if (mine === want && taken.name === name) return { message: '' };
        if (mine && mine !== want) room.seats[mine] = null;
        room.seats[want] = { id: player, name };
        logNote(room.game, want, mine === want ? `${name} is now the ${NAME[want]} player's name` : `${name} is playing ${NAME[want]}`);
        return { message: `You're playing ${NAME[want]}.` };
      });
      return reply(status, out);
    }

    if (body.op === 'free') {
      const c = body.color === 'B' || body.color === 'R' ? body.color : null;
      const [status, out] = await mutate(store, code, player, room => {
        if (room.host !== player) return { status: 403, error: 'Only the person who created the room can free a seat.' };
        if (!c || !room.seats[c]) return { message: '' };
        logNote(room.game, c, `${room.seats[c].name} was removed from the ${NAME[c]} seat`);
        room.seats[c] = null;
        return { message: `The ${NAME[c]} seat is open again.` };
      });
      return reply(status, out);
    }

    if (body.op === 'action') {
      const action = body.action;
      const [status, out] = await mutate(store, code, player, (room, version) => {
        if (action && NEEDS_FRESH_BOARD.has(action.type) && Number(body.baseVersion) !== version) {
          return { status: 409, error: 'The board changed just before your move arrived — take another look and try again.' };
        }
        const mine = seatOf(room, player);
        const r = applyAction(room.game, action, mine ? { color: mine } : { spectator: true });
        if (!r.ok) return { status: 400, error: r.error };
        return { message: r.message };
      });
      return reply(status, out);
    }

    return reply(400, { error: 'Unknown request.' });
  } catch (e) {
    console.error('[red-vs-blue]', e);
    return reply(500, { error: 'Server error: ' + e.message });
  }
}

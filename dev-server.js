// Local test server: serves public/ and runs api/room.js the way Vercel would.
//   npm install
//   npm run local            -> http://localhost:3000
// With no Redis environment variables it keeps rooms in memory (they vanish when you stop it).
// To test against your real database, copy the env vars from Vercel into your shell first
// (or run `vercel env pull .env.local` and `node --env-file=.env.local dev-server.js`).

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from './api/room.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/room') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    req.query = Object.fromEntries(url.searchParams);
    try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = raw; }
    res.status = code => { res.statusCode = code; return res; };
    res.json = obj => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
    try { await handler(req, res); }
    catch (e) { console.error(e); res.statusCode = 500; res.end(JSON.stringify({ error: String(e) })); }
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
  try {
    const data = await fs.readFile(file);
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  } catch {
    res.statusCode = 404; res.end('Not found');
  }
}).listen(PORT, () => console.log(`Red vs Blue running at http://localhost:${PORT}`));

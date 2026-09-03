// Relic Run - plain node:http server: static files + API.
// No external dependencies. Validates score submissions by deterministic
// replay using the shared rules/session modules.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCHEMA_VERSION, hashState, scoreBreakdown, compareResults, tieBreakMeta } from './src/rules.js';
import * as Session from './src/session.js';
import { dailyContent, dailySeedFor, utcDateKey, CONTENT_VERSION } from './src/content.js';
import { ACHIEVEMENTS } from './src/store.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, 'data');
const BOARD_FILE = path.join(DATA_DIR, 'leaderboard.json');
const ACH_FILE = path.join(DATA_DIR, 'achievements.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.opus': 'audio/ogg',
};

function sendJson(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(body);
}
function sendError(res, code, msg, extra) {
  sendJson(res, code, { error: msg, ...extra });
}

// --- tiny rate limiter: 60 req / 10s per ip, 10 score posts / 60s ---------------
const buckets = new Map();
function rateLimited(ip, kind) {
  const now = Date.now();
  const key = kind + ':' + ip;
  const win = kind === 'score' ? 60_000 : 10_000;
  const max = kind === 'score' ? 10 : 60;
  let b = buckets.get(key);
  if (!b || now - b.start > win) { b = { start: now, count: 0 }; buckets.set(key, b); }
  b.count++;
  if (b.count > max) return Math.ceil((b.start + win - now) / 1000);
  return 0;
}

// --- persistent stores -------------------------------------------------------------
function loadJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
async function saveJson(file, data) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 1));
}

// --- score validation ------------------------------------------------------------------
function validateSubmission(body) {
  if (!body || typeof body !== 'object') return 'malformed-body';
  if (body.ruleset !== SCHEMA_VERSION) return 'stale-version';
  if (body.contentVersion !== CONTENT_VERSION) return 'stale-content-version';
  if (!Number.isInteger(body.seed) || body.seed < 0) return 'bad-seed';
  if (!Number.isInteger(body.durationTicks) || body.durationTicks < 0 || body.durationTicks > 30 * 600) return 'bad-duration';
  if (!Array.isArray(body.commands) || body.commands.length > 5000) return 'bad-commands';
  for (const c of body.commands) {
    if (!c || !Number.isInteger(c.id) || c.id <= 0) return 'bad-command-id';
    if (!['left', 'right', 'jump', 'slide'].includes(c.action)) return 'bad-action';
  }
  return null;
}

// Re-run the replay; reject mismatched or impossible scores.
export function verifyScore(body) {
  const sess = Session.replayTicks(body.seed, body.commands, body.genOpts || {});
  const recomputed = scoreBreakdown(sess.state);
  const claimed = body.scoreBreakdown || {};
  if ((claimed.total | 0) !== recomputed.total) {
    return { ok: false, reason: 'score-mismatch', recomputed };
  }
  return { ok: true, breakdown: recomputed, meta: tieBreakMeta(sess.state, body.player || 'anon'), terminal: sess.state.terminal };
}

export function createAppServer(port = 8090) {
  const server = createServer(async (req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';
    const u = new URL(req.url || '/', 'http://x');
    const p = u.pathname;

    // ---- API ----
    if (p.startsWith('/api/')) {
      const rl = rateLimited(ip, p === '/api/v1/scores' ? 'score' : 'api');
      if (rl > 0) return sendError(res, 429, 'rate-limited', { retryAfter: rl });

      if (p === '/api/v1/time' && req.method === 'GET') {
        return sendJson(res, 200, { serverTime: Date.now() });
      }
      if (p === '/api/v1/daily' && req.method === 'GET') {
        const dk = utcDateKey();
        const d = dailyContent(dk);
        return sendJson(res, 200, {
          dateKey: dk, seed: d.seed, genOpts: d.genOpts, theme: d.theme,
          contentVersion: CONTENT_VERSION, ruleset: SCHEMA_VERSION,
        });
      }
      if (p === '/api/v1/scores' && req.method === 'POST') {
        const body = await readBody(res, req, 256 * 1024);
        if (body === null) return; // error already sent
        const invalid = validateSubmission(body);
        if (invalid) return sendError(res, 422, invalid);
        const v = verifyScore(body);
        if (!v.ok) return sendError(res, 422, v.reason, { recomputed: v.recomputed });
        const board = body.board === 'daily' ? 'daily' : 'global';
        const boards = loadJson(BOARD_FILE, { global: [], daily: [] });
        const entry = {
          player: String(body.player || 'runner').slice(0, 32),
          score: v.breakdown.total,
          breakdown: v.breakdown,
          terminal: v.terminal,
          ticks: body.durationTicks,
          seed: body.seed,
          dateKey: board === 'daily' ? utcDateKey() : undefined,
          at: new Date().toISOString(),
        };
        boards[board].push(entry);
        boards[board].sort((a, b) => b.score - a.score || compareResults(
          { finished: a.terminal === 'finished', invalids: 0, ticks: a.ticks, sessionId: a.player },
          { finished: b.terminal === 'finished', invalids: 0, ticks: b.ticks, sessionId: b.player },
        ));
        boards[board] = boards[board].slice(0, 100);
        await saveJson(BOARD_FILE, boards);
        return sendJson(res, 200, { accepted: true, score: v.breakdown.total });
      }
      if (p === '/api/v1/leaderboard' && req.method === 'GET') {
        const boardName = u.searchParams.get('board') === 'daily' ? 'daily' : 'global';
        const boards = loadJson(BOARD_FILE, { global: [], daily: [] });
        let entries = boards[boardName] || [];
        const friends = u.searchParams.get('friends');
        if (friends) {
          const set = new Set(friends.split(',').map((s) => s.trim()).filter(Boolean));
          entries = entries.filter((e) => set.has(e.player));
        }
        return sendJson(res, 200, { board: boardName, entries });
      }
      if (p === '/api/v1/achievements' && req.method === 'POST') {
        const body = await readBody(res, req, 4096);
        if (body === null) return;
        const key = body && body.key;
        if (!ACHIEVEMENTS.some((a) => a.id === key)) return sendError(res, 422, 'unknown-achievement');
        const store = loadJson(ACH_FILE, { unlocks: {} });
        const first = !store.unlocks[key];
        if (first) {
          store.unlocks[key] = { at: new Date().toISOString(), count: 1 };
          await saveJson(ACH_FILE, store);
        } else {
          store.unlocks[key].count++; // idempotent: still unlocked
          await saveJson(ACH_FILE, store);
        }
        return sendJson(res, 200, { key, unlocked: true, firstUnlock: first });
      }
      if (p.startsWith('/api/')) {
        return sendError(res, ['GET', 'POST'].includes(req.method) ? 404 : 405, 'not-found');
      }
    }

    // ---- static ----
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'method-not-allowed');
    let rel = decodeURIComponent(p === '/' ? '/index.html' : p);
    // path traversal protection
    const abs = path.normalize(path.join(ROOT, rel));
    if (!abs.startsWith(ROOT + path.sep) && abs !== ROOT) return sendError(res, 403, 'forbidden');
    if (!existsSync(abs) || !require_isFile(abs)) return sendError(res, 404, 'not-found');
    const ext = path.extname(abs).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    try {
      const data = await readFile(abs);
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      res.end(data);
    } catch {
      sendError(res, 404, 'not-found');
    }
  });
  return server;
}

function require_isFile(abs) {
  try { return require_statSync(abs).isFile(); } catch { return false; }
}
import { statSync as require_statSync } from 'node:fs';

function readBody(res, req, limit) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        sendError(res, 413, 'payload-too-large');
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { sendError(res, 400, 'bad-json'); resolve(null); }
    });
    req.on('error', () => { sendError(res, 400, 'bad-request'); resolve(null); });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT) || 8090;
  createAppServer(port).listen(port, () => {
    console.log('Relic Run server listening on http://localhost:' + port);
  });
}

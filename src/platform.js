// Relic Run - platform adapter for hosted (StarHermit) and local-dev play.
// Hosted mode activates iff a launch token was read from the URL fragment.
// Auth: Authorization: Bearer <token> on every REST call; the token is
// re-minted every 45 min via POST /api/v1/games/{slug}/launch-token.
// Cloud progress mirrors the checksummed localStorage doc to the single
// cloud-save slot (zip+base64). Leaderboards are read-only on-platform;
// replay-validated score submission only exists on the game's own dev server.
let serverOnline = null; // null unknown, true/false after probe
let clockOffsetMs = 0;

// --- launch token ------------------------------------------------------------------
function isLocalHost() {
  if (typeof location === 'undefined' || !location) return false;
  const h = location.hostname || '';
  return h === 'localhost' || h.endsWith('.localhost') || h.startsWith('127.') || h === '::1' || h === '0.0.0.0';
}

function readLaunchToken() {
  if (typeof location === 'undefined' || !location) return null;
  // hosted launch: #game_token=<jwt>[&session_id=<guid>] - read once, then strip
  if (location.hash) {
    const frag = new URLSearchParams(location.hash.slice(1));
    const t = frag.get('game_token');
    if (t && typeof history !== 'undefined' && history.replaceState) {
      history.replaceState(null, '', location.pathname + location.search);
      return t;
    }
  }
  // query fallbacks are for local dev only
  if (isLocalHost()) {
    const q = new URLSearchParams(location.search);
    return q.get('game_token') || q.get('launch_token') || q.get('token') || q.get('launch');
  }
  return null;
}

function decodeJwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

let token = readLaunchToken();
const payload = token ? decodeJwtPayload(token) : null;
let userSub = payload && payload.sub ? String(payload.sub) : null;
let gameSlug = payload && payload.game_scope ? String(payload.game_scope) : null;

// Hosted mode iff a token was read.
export function hasIdentity() {
  return !!token;
}

// --- token refresh: re-mint every 45 min, retry failures after ~60 s ----------------
const REFRESH_MS = 45 * 60 * 1000;
const REFRESH_RETRY_MS = 60 * 1000;
let refreshTimer = null;

async function refreshLaunchToken() {
  if (!token || !gameSlug || typeof fetch === 'undefined') return true;
  try {
    const res = await fetch(`/api/v1/games/${encodeURIComponent(gameSlug)}/launch-token`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token },
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    const next = body && (body.token || body.launchToken || body.launch_token || body.access_token);
    if (typeof next === 'string' && next) {
      token = next;
      const p = decodeJwtPayload(token);
      if (p) {
        if (p.sub) userSub = String(p.sub);
        if (p.game_scope) gameSlug = String(p.game_scope);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function scheduleRefresh(delayMs = REFRESH_MS) {
  if (typeof setTimeout === 'undefined') return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    const ok = await refreshLaunchToken();
    scheduleRefresh(ok ? REFRESH_MS : REFRESH_RETRY_MS);
  }, delayMs);
}

if (token) scheduleRefresh();

// --- authenticated API helper --------------------------------------------------------
async function api(path, opts = {}, timeoutMs = 8000) {
  if (!token) throw new Error('offline');
  const headers = { ...(opts.headers || {}), authorization: 'Bearer ' + token };
  if (opts.body && typeof opts.body === 'string' && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(path, { ...opts, headers, signal: ctrl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('http-' + res.status);
    const ct = res.headers.get('content-type') || '';
    return ct.includes('json') ? res.json() : new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

// --- profile / nickname ---------------------------------------------------------------
const nicknameCache = new Map();

async function resolveNickname(userId) {
  if (!userId) return null;
  if (nicknameCache.has(userId)) return nicknameCache.get(userId);
  const fallback = 'Player ' + String(userId).slice(0, 8);
  let name = fallback;
  try {
    // NEVER /api/v1/me (403 for launch tokens); display nickname, never username
    const body = await api(`/api/v1/users/${encodeURIComponent(userId)}/profile`);
    if (body && typeof body.nickname === 'string' && body.nickname.trim()) name = body.nickname.trim();
  } catch {
    /* keep fallback */
  }
  nicknameCache.set(userId, name);
  return name;
}

// The signed-in player's display name, or null when playing locally.
export async function fetchNickname() {
  if (!token || !userSub) return null;
  return resolveNickname(userSub);
}

// --- server time ----------------------------------------------------------------------
async function fetchServerTime(timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('/api/v1/time', { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error('no-time');
    const body = await res.json();
    const serverMs = Number(body.serverTime ?? body.now ?? body.epochMs);
    if (!Number.isFinite(serverMs)) throw new Error('no-time');
    return serverMs;
  } finally {
    clearTimeout(t);
  }
}

export function isServerOnline() {
  return serverOnline === true;
}

// Round-trip-adjusted clock sync with the host's public time route.
export async function syncTime() {
  const t0 = Date.now();
  const serverMs = await fetchServerTime();
  const t1 = Date.now();
  clockOffsetMs = serverMs + (t1 - t0) / 2 - t1;
  return clockOffsetMs;
}

export async function probeServer() {
  try {
    await syncTime();
    serverOnline = true;
    return true;
  } catch {
    serverOnline = false;
    clockOffsetMs = 0;
    return false;
  }
}

export function serverNow() {
  return Date.now() + clockOffsetMs;
}

// --- minimal ZIP writer/reader (stored entries only, no compression) -------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const local = out.length;
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
export function unzipFirstEntry(zipBytes) {
  // Stored single-entry reader: scan local headers for compression 0.
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

// --- cloud save: one slot, zip+base64; localStorage stays the offline cache ----------
const SAVE_ENTRY = 'relicrun-save.json';
const SAVE_DEBOUNCE_MS = 2000;
let syncStatus = 'offline'; // offline | saving | synced
const syncListeners = new Set();
let pendingDoc = null;      // cloned profile waiting to upload
let saveTimer = null;
let flushInFlight = null;

export function getSyncStatus() {
  return syncStatus;
}

export function onSyncStatus(fn) {
  syncListeners.add(fn);
  fn(syncStatus);
  return () => syncListeners.delete(fn);
}

function setSyncStatus(s) {
  if (s === syncStatus) return;
  syncStatus = s;
  for (const fn of syncListeners) fn(s);
}

function encodeSave(profile) {
  return bytesToBase64(zipStore(SAVE_ENTRY, new TextEncoder().encode(JSON.stringify(profile))));
}

function decodeSave(bytes) {
  return JSON.parse(new TextDecoder().decode(unzipFirstEntry(bytes)));
}

// Remote-preferred load: 404 = no save yet; null whenever hosted data is unavailable.
export async function cloudLoad() {
  if (!token || !gameSlug || typeof fetch === 'undefined') return null;
  try {
    const res = await fetch(`/api/v1/me/cloud-saves/${encodeURIComponent(gameSlug)}`, {
      cache: 'no-store',
      headers: { authorization: 'Bearer ' + token },
    });
    if (res.status === 404) {
      if (!pendingDoc) setSyncStatus('synced');
      return null;
    }
    if (!res.ok) throw new Error('http-' + res.status);
    return decodeSave(new Uint8Array(await res.arrayBuffer()));
  } catch {
    return null;
  }
}

// Debounced mirror upload; flush on pagehide/visibilitychange so no save is lost.
export function scheduleCloudSave(profile) {
  if (!token || !gameSlug || typeof setTimeout === 'undefined') return;
  pendingDoc = JSON.parse(JSON.stringify(profile));
  setSyncStatus('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushCloudSave, SAVE_DEBOUNCE_MS);
}

export function flushCloudSave() {
  if (typeof clearTimeout === 'function') clearTimeout(saveTimer);
  saveTimer = null;
  if (!token || !gameSlug || !pendingDoc || flushInFlight) return flushInFlight;
  const doc = pendingDoc;
  flushInFlight = (async () => {
    try {
      const res = await fetch(`/api/v1/me/cloud-saves/${encodeURIComponent(gameSlug)}`, {
        method: 'PUT',
        keepalive: true,
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ dataBase64: encodeSave(doc) }),
      });
      if (!res.ok) throw new Error('http-' + res.status);
      if (pendingDoc === doc) pendingDoc = null;
      setSyncStatus('synced');
    } catch {
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      setSyncStatus(offline ? 'offline' : 'saving'); // stays pending; retried on next save/flush
    } finally {
      flushInFlight = null;
      if (pendingDoc && pendingDoc !== doc) flushCloudSave();
    }
  })();
  return flushInFlight;
}

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('pagehide', () => { flushCloudSave(); });
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushCloudSave(); });
  }
}

// --- daily challenge -------------------------------------------------------------------
export async function fetchDaily() {
  // Local dev: the game's own server publishes the day's seed. Hosted: the
  // daily seed derives from the UTC date key (same course for everyone), so
  // no dedicated platform route is needed; callers use the local content.
  if (!token && isLocalHost() && typeof fetch !== 'undefined') {
    try {
      const res = await fetch('/api/v1/daily', { cache: 'no-store' });
      if (!res.ok) return null;
      const body = await res.json();
      if (!Number.isInteger(body.seed)) return null;
      return { seed: body.seed, dateKey: body.dateKey, genOpts: body.genOpts, theme: body.theme };
    } catch {
      return null;
    }
  }
  return null;
}

// --- scores + leaderboards ---------------------------------------------------------------
// Clients can NEVER submit to a hosted leaderboard (script/elo-owned). The
// replay-validated board exists only on the game's own dev server.
export async function submitScore(submission) {
  if (token || !isLocalHost() || typeof fetch === 'undefined') return null;
  const res = await fetch('/api/v1/scores', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(submission),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || 'rejected');
    err.offline = false;
    throw err;
  }
  return body;
}

// Read-only. Hosted: platform game record -> leaderboard entries (nicknames
// resolved via the profile helper). Local dev: the game's own board store.
// Returns null whenever live data is unavailable (callers show local records).
export async function fetchLeaderboard(board = 'global') {
  if (token && gameSlug) {
    try {
      const g = await api(`/api/v1/games/${encodeURIComponent(gameSlug)}`);
      const lbId = g && (g.leaderboardId ?? g.leaderboard_id);
      if (!lbId) return null;
      const qs = new URLSearchParams({ friendsOnly: 'false', page: '1', pageSize: '20' });
      const e = await api(`/api/v1/leaderboards/${encodeURIComponent(lbId)}/entries?${qs}`);
      const list = Array.isArray(e) ? e : ((e && (e.entries || e.items)) || []);
      const rows = await Promise.all(list.slice(0, 20).map(async (entry) => {
        const uid = entry.userId ?? entry.user_id ?? entry.playerId ?? entry.player;
        return { player: await resolveNickname(uid), score: Number(entry.score ?? entry.total ?? 0) };
      }));
      return { entries: rows };
    } catch {
      return null;
    }
  }
  if (isLocalHost() && typeof fetch !== 'undefined') {
    try {
      const res = await fetch(`/api/v1/leaderboard?board=${encodeURIComponent(board)}`, { cache: 'no-store' });
      if (!res.ok) return null;
      const body = await res.json();
      return { entries: (body.entries || []).map((e) => ({ player: e.player, score: e.score })) };
    } catch {
      return null;
    }
  }
  return null;
}

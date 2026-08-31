// Relic Run - platform adapter: REST calls to the same-origin server with
// offline degradation, clock sync, and rate-limit handling.
let serverOnline = null; // null unknown, true/false after probe
let clockOffsetMs = 0;

async function api(path, opts = {}, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(path, { ...opts, signal: ctrl.signal });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.error || 'rate-limited');
      err.status = 429;
      err.retryAfter = body.retryAfter || 2;
      throw err;
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((body && body.error) || `http-${res.status}`);
      err.status = res.status;
      throw err;
    }
    serverOnline = true;
    return body;
  } catch (e) {
    if (e.status) throw e;
    serverOnline = false;
    const err = new Error('offline');
    err.offline = true;
    throw err;
  } finally {
    clearTimeout(t);
  }
}

export function isServerOnline() {
  return serverOnline === true;
}

export async function probeServer() {
  try {
    await syncTime();
    return true;
  } catch {
    return false;
  }
}

// Round-trip-adjusted clock sync with GET /api/v1/time.
export async function syncTime() {
  const t0 = Date.now();
  const body = await api('/api/v1/time');
  const t1 = Date.now();
  const rtt = t1 - t0;
  clockOffsetMs = body.serverTime + rtt / 2 - t1;
  return clockOffsetMs;
}

export function serverNow() {
  return Date.now() + clockOffsetMs;
}

export async function fetchDaily() {
  return api('/api/v1/daily');
}

export async function submitScore(payload) {
  return api('/api/v1/scores', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }, 8000);
}

export async function fetchLeaderboard(board = 'global', friends = '') {
  const q = friends ? `&friends=${encodeURIComponent(friends)}` : '';
  return api(`/api/v1/leaderboard?board=${encodeURIComponent(board)}${q}`);
}

export async function unlockAchievementRemote(key) {
  return api('/api/v1/achievements', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  });
}

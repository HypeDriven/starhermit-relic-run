// Relic Run - platform adapter. The only route guaranteed to exist on the
// host is GET /api/v1/time; every other /api/v1/* route returns 404 once
// deployed, so hosted features (daily fetch, scores, leaderboards, remote
// achievements) are local no-ops that never issue a request.
let serverOnline = null; // null unknown, true/false after probe
let clockOffsetMs = 0;

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

// Round-trip-adjusted clock sync with the one route the host guarantees.
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

// No daily route exists on the host - callers fall back to local content.
export async function fetchDaily() {
  return null;
}

// No scores route exists on the host - never issue a request.
export async function submitScore() {
  return null;
}

// No leaderboard route exists on the host - never issue a request.
export async function fetchLeaderboard() {
  return null;
}

// No achievements route exists on the host - never issue a request.
export async function unlockAchievementRemote() {
  return null;
}

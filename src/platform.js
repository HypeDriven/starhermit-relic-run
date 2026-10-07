// Relic Run - platform adapter over the StarHermit SDK (starhermit-sdk.js,
// loaded as a classic script before the modules; window.StarHermit).
// Hosted mode = the SDK holds a launch token (#game_token / #access_token).
// The SDK renews the token, owns the cloud-save slot (game:<slug>), the
// settings KV, controls, profiles and leaderboards. Without a token the game
// is fully local and makes no network request (device clock, local daily,
// local records). Finished runs are posted with submitScore() (hosted only).

const SH = () => globalThis.StarHermit || null;
if (SH()) SH().init(); // reads + strips the launch fragment before anything else

// Hosted mode iff the SDK holds a token.
export function hasIdentity() {
  const sh = SH();
  return !!(sh && sh.signedIn);
}

// --- sign-in / sign-out / invite ---------------------------------------------------
export function canSignIn() { const sh = SH(); return !!(sh && sh.canSignIn()); }
export function signIn() { const sh = SH(); return !!(sh && sh.signIn()); }
export function inviteLink() { const sh = SH(); return sh && sh.signedIn ? sh.inviteLink() : null; }
/** fn({ signedIn }) on sign-in / sign-out (renewal refused). Returns unsubscribe. */
export function onAuth(fn) {
  const sh = SH();
  if (!sh) return () => {};
  return sh.on('auth', (a) => {
    if (!a.signedIn) setSyncStatus('offline');
    fn(a);
  });
}

// --- profile / nickname ---------------------------------------------------------------
async function resolveNickname(userId) {
  const sh = SH();
  if (!userId || !sh) return null;
  const p = await sh.profile(userId).catch(() => null);
  return p ? p.displayName : 'Player ' + String(userId).slice(0, 8);
}

// The signed-in player's display name, or null when playing locally.
export async function fetchNickname() {
  const sh = SH();
  if (!hasIdentity() || !sh.userId) return null;
  return resolveNickname(sh.userId);
}

// --- cloud save: SDK slot game:<slug>; localStorage stays the offline cache ------------
let syncStatus = 'offline'; // offline | saving | synced
const syncListeners = new Set();

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

if (SH()) SH().on('saved', (ok) => setSyncStatus(ok ? 'synced' : 'saving'));

// Remote-preferred load: null when there is no save or hosted data is unavailable.
export async function cloudLoad() {
  const sh = SH();
  if (!hasIdentity()) return null;
  const doc = await sh.loadJSON();
  if (!doc) setSyncStatus('synced');
  return doc;
}

// Debounced checkpoint upload; flushed on pagehide/visibilitychange.
export function scheduleCloudSave(profile) {
  if (!hasIdentity()) return;
  setSyncStatus('saving');
  SH().saveJSON(profile, 2000);
}

export function flushCloudSave() {
  const sh = SH();
  if (!hasIdentity()) return Promise.resolve(false);
  return sh.flushSave(true);
}

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('pagehide', () => { flushCloudSave(); });
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushCloudSave(); });
  }
}

// --- per-player settings KV: one key per settings group --------------------------------
const SETTING_GROUPS = ['audio', 'graphics', 'controls', 'accessibility', 'camera'];
let sentSettings = {};
let settingsTimer = null;

/** Apply the platform's settings over `settings` (platform wins). Returns true if changed. */
export async function loadSettings(settings) {
  const sh = SH();
  if (!hasIdentity()) return false;
  const remote = await sh.getSettings().catch(() => ({}));
  let changed = false;
  for (const g of SETTING_GROUPS) {
    const v = remote && remote[g];
    if (v && typeof v === 'object' && settings[g] && typeof settings[g] === 'object') {
      settings[g] = { ...settings[g], ...v };
      changed = true;
    }
  }
  sentSettings = JSON.parse(JSON.stringify(pickGroups(settings)));
  return changed;
}
function pickGroups(settings) {
  return Object.fromEntries(SETTING_GROUPS.filter((g) => settings[g]).map((g) => [g, settings[g]]));
}
/** Mirror changed settings groups to the platform (debounced, diff only). */
export function mirrorSettings(settings) {
  const sh = SH();
  if (!hasIdentity()) return;
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    const now = pickGroups(settings);
    const diff = {};
    for (const [k, v] of Object.entries(now)) if (JSON.stringify(v) !== JSON.stringify(sentSettings[k])) diff[k] = v;
    if (!Object.keys(diff).length) return;
    sentSettings = JSON.parse(JSON.stringify(now));
    sh.patchSettings(diff);
  }, 600);
}

// --- controls: keyboard actions (KeyboardEvent.code), mirrored in starhermit.txt -------
export const DEFAULT_BINDINGS = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  jump: ['ArrowUp', 'KeyW', 'Space'],
  slide: ['ArrowDown', 'KeyS'],
  pause: ['Escape'],
  undo: ['KeyU'],
  hint: ['KeyH'],
  camera: ['KeyC'],
};
let bindings = JSON.parse(JSON.stringify(DEFAULT_BINDINGS));
export function getBindings() { return bindings; }
/** Load the player's bindings (platform overrides; defaults standalone, no call). */
export async function loadBindings() {
  const sh = SH();
  if (sh) bindings = await sh.loadBindings(DEFAULT_BINDINGS).catch(() => bindings);
  return bindings;
}
export function actionFor(code) {
  for (const [action, codes] of Object.entries(bindings)) if (codes.includes(code)) return action;
  return null;
}

// --- leaderboards -----------------------------------------------------------------------
// Post a finished run to the leaderboards (score-script.js) and read back the
// player's rank on the high-score board: { posted, rank }. Hosted only.
export async function submitScore(total) {
  const sh = SH();
  if (!hasIdentity()) return { posted: false, rank: null };
  try {
    const keys = await sh.submitScores({ 'high-score': total });
    if (!(keys || []).includes('high-score')) return { posted: false, rank: null };
    try {
      const r = await sh.leaderboard('high-score', { pageSize: 100 });
      const me = (r.items || []).find((e) => e.userId === sh.userId);
      return { posted: true, rank: me ? me.rank : null };
    } catch { return { posted: true, rank: null }; }
  } catch { return { posted: false, rank: null }; }
}

// Read-only, hosted only: platform game record -> leaderboard entries
// (nicknames resolved via the profile helper).
// Returns null whenever live data is unavailable (callers show local records).
export async function fetchLeaderboard() {
  const sh = SH();
  if (hasIdentity()) {
    const g = await sh.getGame();
    let lbId = g && (g.leaderboardId ?? g.leaderboard_id);
    if (!lbId) {
      const boards = await sh.leaderboards();
      lbId = boards && boards[0] && boards[0].id;
    }
    if (!lbId) return null;
    const e = await sh.leaderboardEntries(lbId, { page: 1, pageSize: 20 });
    const list = Array.isArray(e) ? e : ((e && (e.entries || e.items)) || []);
    const rows = await Promise.all(list.slice(0, 20).map(async (entry) => {
      const uid = entry.userId ?? entry.user_id ?? entry.playerId ?? entry.player;
      return { player: await resolveNickname(uid), score: Number(entry.score ?? entry.total ?? 0) };
    }));
    return { entries: rows };
  }
  return null;
}

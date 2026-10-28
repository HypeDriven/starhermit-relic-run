// Relic Run - the progress this client stores as the engine save, and what it
// reads from the browser build. Pure: shared by native/platform.ts and the
// node tests.
// - The engine save is the browser build's profile (src/store.js) without its
//   settings: the journey (highest unlocked stage, per stage the best score and
//   whether it was finished), achievements (id -> { unlockedAt }), best scores
//   per board key ('daily-<date>'), finished lessons, and the totals (runs,
//   fragments, the best score per daily date). Two copies merge as the browser
//   build's cloud conflicts did (mergeProfiles: the higher unlock, the better
//   score per stage and board, "finished" if either finished, the union of
//   lessons and achievements with the earliest unlock, the larger totals).
// - The browser build mirrored its whole profile (settings included) to the
//   cloud slot game:<slug> as JSON (StarHermit.saveJSON). The engine shows that
//   slot as foreign: readForeign() turns it into progress plus the game options
//   this client still owns.
// - Of the old settings, the left-handed tray, the colorblind-safe palette and
//   timing assistance stay the game's options (engine settings); volumes, mute,
//   graphics, reduced motion, high contrast, larger text, haptics and language
//   are the runtime's Options. isLegacyKey() names the per-player settings keys
//   the browser build (its settings mirror, sh-language.js and game-options.js)
//   wrote, to remove once read.

export const OPTION_KEYS = ['leftHanded', 'colorblind', 'timingAssist'];

export const ACHIEVEMENTS = [
  { id: 'first-finish', name: 'First Crossing', description: 'Finish your first run.' },
  { id: 'mechanic-mastery', name: 'Student of the Ruins', description: 'Complete every Learn lesson.' },
  { id: 'daily-streak-3', name: 'Pilgrim', description: 'Play the daily challenge on 3 different days.' },
  { id: 'hard-milestone', name: 'Relic Warden', description: 'Finish a hard Journey stage.' },
  { id: 'fragments-1000', name: 'Hoard of the Ancients', description: 'Collect 1000 fragments in total.' },
];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** A new player's progress. */
export function blank() { return normalize(null); }

/** Any stored or old document -> progress (unknown or broken input -> blank). */
export function normalize(raw) {
  const d = obj(raw);
  const journey = obj(d.journey);
  const out = {
    version: 1,
    journey: { unlocked: Math.min(40, Math.max(1, Math.floor(num(journey.unlocked)) || 1)), completed: {} },
    achievements: {},
    bestScores: {},
    tutorials: {},
    totals: { runs: 0, fragments: 0, dailies: {} },
  };
  for (const [id, r] of Object.entries(obj(journey.completed))) {
    if (r && typeof r === 'object') out.journey.completed[id] = { score: Math.round(num(r.score)), finished: !!r.finished };
  }
  for (const [k, v] of Object.entries(obj(d.achievements))) {
    if (!ACHIEVEMENTS.some((a) => a.id === k) || !v) continue;
    out.achievements[k] = { unlockedAt: typeof v.unlockedAt === 'string' ? v.unlockedAt : '' };
  }
  for (const [k, v] of Object.entries(obj(d.bestScores))) {
    if (!v || typeof v !== 'object' || !Number.isFinite(v.total)) continue;
    const r = { total: Math.round(v.total) };
    if (typeof v.date === 'string') r.date = v.date;
    if (v.breakdown && typeof v.breakdown === 'object') r.breakdown = v.breakdown;
    out.bestScores[k] = r;
  }
  for (const [k, v] of Object.entries(obj(d.tutorials))) if (v === true) out.tutorials[k] = true;
  const t = obj(d.totals);
  out.totals.runs = Math.max(0, Math.round(num(t.runs)));
  out.totals.fragments = Math.max(0, Math.round(num(t.fragments)));
  for (const [k, v] of Object.entries(obj(t.dailies))) if (Number.isFinite(v)) out.totals.dailies[k] = Math.round(v);
  return out;
}

/** Two copies merged without losing either side's progress (store.js mergeProfiles). */
export function merge(local, remote) {
  const a = normalize(local);
  const b = normalize(remote);
  const out = JSON.parse(JSON.stringify(a));
  out.journey.unlocked = Math.max(a.journey.unlocked, b.journey.unlocked);
  for (const [id, r] of Object.entries(b.journey.completed)) {
    const l = out.journey.completed[id];
    out.journey.completed[id] = l ? { score: Math.max(l.score, r.score), finished: l.finished || r.finished } : r;
  }
  for (const [k, r] of Object.entries(b.bestScores)) {
    const l = out.bestScores[k];
    if (!l || r.total > l.total) out.bestScores[k] = r;
  }
  for (const k of Object.keys(b.tutorials)) out.tutorials[k] = true;
  for (const [k, v] of Object.entries(b.achievements)) {
    const l = out.achievements[k];
    if (!l || (v.unlockedAt && l.unlockedAt && v.unlockedAt < l.unlockedAt)) out.achievements[k] = v;
  }
  out.totals.runs = Math.max(a.totals.runs, b.totals.runs);
  out.totals.fragments = Math.max(a.totals.fragments, b.totals.fragments);
  for (const [d, v] of Object.entries(b.totals.dailies)) out.totals.dailies[d] = Math.max(num(out.totals.dailies[d]), v);
  return out;
}

/** Whether two copies hold the same progress. */
export function same(a, b) {
  return JSON.stringify(sorted(normalize(a))) === JSON.stringify(sorted(normalize(b)));
}
function sorted(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const out = {};
  for (const k of Object.keys(v).sort()) out[k] = sorted(v[k]);
  return out;
}

/** Unlocks an achievement once (store.js unlockAchievement); true when it is new. */
export function unlock(progress, id, isoNow) {
  if (!ACHIEVEMENTS.some((a) => a.id === id) || progress.achievements[id]) return false;
  progress.achievements[id] = { unlockedAt: isoNow };
  return true;
}

/** Only well-typed option values. */
export function pickOptions(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of OPTION_KEYS) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  return out;
}

/** The browser build's settings groups -> this client's options. */
export function optionsFromSettings(settings) {
  const s = obj(settings);
  const controls = obj(s.controls), a11y = obj(s.accessibility);
  return pickOptions({ leftHanded: controls.leftHanded, colorblind: a11y.colorblindPalette, timingAssist: a11y.timingAssist });
}

/** The browser build's cloud slot (JSON text of its profile) -> { progress, options }, or null. */
export function readForeign(text) {
  if (typeof text !== 'string' || !text) return null;
  let o;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  return { progress: normalize(o), options: optionsFromSettings(o.settings) };
}

/** Every per-player settings key the browser build wrote (its five settings groups, language, sound and graphics panels). */
export function isLegacyKey(key) {
  return ['audio', 'graphics', 'controls', 'accessibility', 'camera'].includes(key) ||
    key === 'ui.language' || key === 'audio.options' || key.startsWith('graphics.');
}

// Relic Run - versioned, checksummed localStorage persistence.
// Stores settings, journey progress, achievements, best scores, tutorial
// completion. No credentials are ever stored here.
import { hashString } from './rules.js';

const PREFIX = 'relicrun.';
const VERSION = 1;

export const DEFAULT_SETTINGS = {
  audio: { music: 0.7, effects: 0.8, ambience: 0.5, master: 1.0, muted: false },
  // gfx: the graphics quality model (see gfx.js); category overrides are added as keys
  graphics: { reducedMotion: false, gfx: { preset: 'auto', render_scale: 1, adaptive: true, show_fps: false } },
  controls: { leftHanded: false, holdToSlide: false, haptics: true },
  accessibility: {
    colorblindPalette: false, highContrast: false, largeText: false,
    reducedMotion: false, timingAssist: false,
  },
  camera: { recentered: 0 },
};

const DEFAULT_DATA = {
  version: VERSION,
  settings: DEFAULT_SETTINGS,
  journey: { unlocked: 1, completed: {} }, // stageId -> { score, finished }
  achievements: {},                        // key -> { unlockedAt }
  bestScores: {},                          // boardKey -> { total, breakdown, date }
  tutorials: {},                           // lessonId -> true
  totals: { fragments: 0, runs: 0, dailies: {} }, // dailies: dateKey -> score
};

function checksum(obj) {
  return hashString(JSON.stringify(obj));
}

function readRaw(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const wrap = JSON.parse(raw);
    if (!wrap || wrap.v !== VERSION || typeof wrap.data !== 'object') return null;
    if (checksum(wrap.data) !== wrap.sum) return null; // corrupted
    return wrap.data;
  } catch {
    return null;
  }
}

function writeRaw(key, data) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ v: VERSION, sum: checksum(data), data }));
    return true;
  } catch {
    return false;
  }
}

// Merge any profile-shaped doc (localStorage or cloud-loaded) with defaults
// so new fields appear on older saves.
export function normalizeProfile(d) {
  if (!d || typeof d !== 'object') return JSON.parse(JSON.stringify(DEFAULT_DATA));
  const merged = JSON.parse(JSON.stringify(DEFAULT_DATA));
  deepMerge(merged, d);
  merged.version = VERSION;
  return merged;
}

/**
 * Merge two profiles (this device and the cloud copy another device wrote)
 * without losing progress on either side: the higher journey unlock, per
 * stage the better score and "finished" if either finished, the better best
 * score per board, the union of tutorials and achievements (earliest unlock),
 * the larger run/fragment totals and the better score per daily date.
 * Settings stay `local`'s (the platform settings KV syncs them).
 */
export function mergeProfiles(local, remote) {
  const a = normalizeProfile(local);
  const b = normalizeProfile(remote);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const out = JSON.parse(JSON.stringify(a));
  out.journey.unlocked = Math.max(num(a.journey.unlocked), num(b.journey.unlocked)) || 1;
  for (const [id, r] of Object.entries(b.journey.completed || {})) {
    const l = out.journey.completed[id];
    out.journey.completed[id] = l
      ? { ...l, score: Math.max(num(l.score), num(r.score)), finished: !!(l.finished || r.finished) }
      : r;
  }
  for (const [k, r] of Object.entries(b.bestScores || {})) {
    const l = out.bestScores[k];
    if (!l || num(r.total) > num(l.total)) out.bestScores[k] = r;
  }
  for (const [k, v] of Object.entries(b.tutorials || {})) if (v) out.tutorials[k] = true;
  for (const [k, v] of Object.entries(b.achievements || {})) {
    const l = out.achievements[k];
    if (!l || (v && v.unlockedAt && l.unlockedAt && v.unlockedAt < l.unlockedAt)) out.achievements[k] = v;
  }
  out.totals.runs = Math.max(num(a.totals.runs), num(b.totals.runs));
  out.totals.fragments = Math.max(num(a.totals.fragments), num(b.totals.fragments));
  for (const [d, v] of Object.entries(b.totals.dailies || {})) out.totals.dailies[d] = Math.max(num(out.totals.dailies[d]), num(v));
  return out;
}

export function loadProfile() {
  return normalizeProfile(readRaw('profile'));
}

export function hasSavedProfile() {
  return readRaw('profile') != null;
}

export function saveProfile(profile) {
  const data = { ...profile, version: VERSION };
  return writeRaw('profile', data);
}

function deepMerge(dst, src) {
  for (const k of Object.keys(src || {})) {
    if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) &&
        dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) {
      deepMerge(dst[k], src[k]);
    } else {
      dst[k] = src[k];
    }
  }
}

// --- achievements ------------------------------------------------------------------
if (typeof localStorage === "undefined") { globalThis.localStorage = undefined; }
export const ACHIEVEMENTS = [
  { id: 'first-finish', name: 'First Crossing', description: 'Finish your first run.' },
  { id: 'mechanic-mastery', name: 'Student of the Ruins', description: 'Complete every Learn lesson.' },
  { id: 'daily-streak-3', name: 'Pilgrim', description: 'Play the daily challenge on 3 different days.' },
  { id: 'hard-milestone', name: 'Relic Warden', description: 'Finish a hard Journey stage.' },
  { id: 'fragments-1000', name: 'Hoard of the Ancients', description: 'Collect 1000 fragments in total.' },
];

export function unlockAchievement(profile, key) {
  if (!ACHIEVEMENTS.some((a) => a.id === key)) return false;
  if (profile.achievements[key]) return false; // idempotent
  profile.achievements[key] = { unlockedAt: new Date().toISOString() };
  return true;
}

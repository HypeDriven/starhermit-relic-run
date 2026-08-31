// Relic Run - versioned, checksummed localStorage persistence.
// Stores settings, journey progress, achievements, best scores, tutorial
// completion. No credentials are ever stored here.
import { hashString } from './rules.mjs';

const PREFIX = 'relicrun.';
const VERSION = 1;

export const DEFAULT_SETTINGS = {
  audio: { music: 0.7, effects: 0.8, ambience: 0.5, master: 1.0, muted: false },
  graphics: { quality: 'medium', reducedMotion: false },
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

export function loadProfile() {
  const d = readRaw('profile');
  if (!d) return JSON.parse(JSON.stringify(DEFAULT_DATA));
  // merge with defaults so new fields appear on older saves
  const merged = JSON.parse(JSON.stringify(DEFAULT_DATA));
  deepMerge(merged, d);
  return merged;
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

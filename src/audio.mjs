// Relic Run - WebAudio: synthesized sounds, bus mixer, adaptive music.
// No assets; everything is generated. Seeded pitch variants keep replays
// consistent where the event is tied to simulation state.
import { mulberry32 } from './rules.mjs';

const STORAGE_KEY = 'relicrun.audio.v1';

let ctx = null;
let master, musicBus, fxBus, ambBus;
let settings = { music: 0.7, effects: 0.8, ambience: 0.5, master: 1.0, muted: false };
let ambNodes = null;
let musicTimer = null;
let musicState = { intensity: 0, step: 0, seed: 1 };
let started = false;

function loadSettings() {
  try {
    const raw = globalThis.localStorage && localStorage.getItem(STORAGE_KEY);
    if (raw) Object.assign(settings, JSON.parse(raw));
  } catch { /* storage unavailable */ }
}
loadSettings();

function persist() {
  try {
    if (globalThis.localStorage) localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* ignore */ }
}

export function getAudioSettings() {
  return { ...settings };
}

export function setVolume(bus, value) {
  const v = Math.max(0, Math.min(1, +value || 0));
  if (bus === 'music') settings.music = v;
  else if (bus === 'effects') settings.effects = v;
  else if (bus === 'ambience') settings.ambience = v;
  else if (bus === 'master') settings.master = v;
  applyVolumes();
  persist();
}

export function setMuted(muted) {
  settings.muted = !!muted;
  applyVolumes();
  persist();
}

function applyVolumes() {
  if (!ctx) return;
  const m = settings.muted ? 0 : settings.master;
  master.gain.value = m;
  musicBus.gain.value = settings.music;
  fxBus.gain.value = settings.effects;
  ambBus.gain.value = settings.ambience;
}

// Must be called from a user gesture at least once.
export function ensureAudio() {
  if (!ctx) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    musicBus = ctx.createGain();
    fxBus = ctx.createGain();
    ambBus = ctx.createGain();
    musicBus.connect(master);
    fxBus.connect(master);
    ambBus.connect(master);
    master.connect(ctx.destination);
    applyVolumes();
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  started = true;
  return true;
}

export function suspendAudio() {
  if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
}

// --- synth helpers --------------------------------------------------------------
function env(g, t0, peak, dur) {
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
}

function tone(bus, freq, dur, type = 'sine', peak = 0.3, slideTo = 0) {
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slideTo > 0) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  env(g, t0, peak, dur);
  o.connect(g).connect(bus);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

function noiseBurst(bus, dur, peak = 0.2, filterFreq = 1200) {
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const n = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const rng = mulberry32((musicState.seed ^ (musicState.step * 7919)) >>> 0);
  for (let i = 0; i < n; i++) data[i] = (rng() * 2 - 1) * (1 - i / n);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = filterFreq;
  const g = ctx.createGain();
  g.gain.value = peak;
  src.connect(f).connect(g).connect(bus);
  src.start(t0);
}

// --- authored sample one-shots ----------------------------------------------------
// Lazy fetch/decode/cache of sfx/<name>.opus. Samples play through the effects bus
// and obey the same master/mute/effects volume settings as synthesized sounds.
// An event runs its synthesized fallback while its sample is still loading or if
// the fetch/decode failed, so behavior is unchanged when no clip exists.
const SFX_BY_EVENT = {
  jump: 'jump-leap',
  turn: 'turn-swat',
  left: 'turn-swat',
  right: 'turn-swat',
  slide: 'slide-rush',
  collect: 'relic-pickup',
  setbonus: 'set-bonus-chime',
  branch: 'fork-branch',
  crash: 'vine-crash',
  fell: 'fall-whistle',
  finish: 'finish-fanfare',
  click: 'ui-click',
  invalid: 'ui-invalid',
  countdown: 'count-tick',
  go: 'run-go',
};
// name -> 'loading' | AudioBuffer | null (failed)
const sampleCache = new Map();

function ensureSample(name) {
  if (!ctx || sampleCache.has(name)) return;
  sampleCache.set(name, 'loading');
  fetch('sfx/' + name + '.opus')
    .then((r) => {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.arrayBuffer();
    })
    .then((ab) => ctx.decodeAudioData(ab))
    .then((buf) => sampleCache.set(name, buf))
    .catch(() => sampleCache.set(name, null));
}

// Returns true when a decoded sample was played (synthesis then skipped).
function playSample(name) {
  const entry = sampleCache.get(name);
  if (!entry || entry === 'loading') return false;
  const src = ctx.createBufferSource();
  src.buffer = entry;
  src.connect(fxBus);
  src.start();
  return true;
}

// --- gameplay events --------------------------------------------------------------
// variantSeed: deterministic pitch offset derived from sim tick for replay consistency.
export function playEvent(kind, variantSeed = 0) {
  if (!ctx || settings.muted) return;
  const sampleName = SFX_BY_EVENT[kind];
  if (sampleName) {
    ensureSample(sampleName);
    if (playSample(sampleName)) return;
  }
  const rng = mulberry32((variantSeed >>> 0) || 1);
  const pv = 1 + (rng() - 0.5) * 0.08; // +-4% pitch variant, seeded
  switch (kind) {
    case 'jump': tone(fxBus, 520 * pv, 0.16, 'triangle', 0.30, 880 * pv); break;
    case 'turn':
    case 'left':
    case 'right': tone(fxBus, 340 * pv, 0.08, 'triangle', 0.22, 420 * pv); break;
    case 'slide': noiseBurst(fxBus, 0.18, 0.16, 900); break;
    case 'collect':
      tone(fxBus, 780 * pv, 0.10, 'sine', 0.26);
      tone(fxBus, 1170 * pv, 0.16, 'sine', 0.18);
      break;
    case 'setbonus':
      tone(fxBus, 660, 0.12, 'sine', 0.24);
      tone(fxBus, 880, 0.12, 'sine', 0.24);
      tone(fxBus, 1320, 0.22, 'sine', 0.22);
      break;
    case 'branch': tone(fxBus, 240 * pv, 0.14, 'square', 0.16, 360 * pv); break;
    case 'crash':
      noiseBurst(fxBus, 0.3, 0.4, 500);
      tone(fxBus, 160, 0.3, 'sawtooth', 0.3, 60);
      break;
    case 'fell': tone(fxBus, 400, 0.5, 'sawtooth', 0.3, 70); break;
    case 'finish':
      tone(fxBus, 523, 0.14, 'triangle', 0.28);
      tone(fxBus, 659, 0.14, 'triangle', 0.28);
      tone(fxBus, 784, 0.3, 'triangle', 0.3);
      break;
    case 'click': tone(fxBus, 900, 0.04, 'square', 0.12); break;
    case 'invalid': tone(fxBus, 180, 0.1, 'square', 0.16); break;
    case 'countdown': tone(fxBus, 600, 0.09, 'sine', 0.25); break;
    case 'go': tone(fxBus, 900, 0.18, 'sine', 0.3); break;
    default: break;
  }
}

// --- ambience: quiet looping wind/leaves bed -------------------------------------
export function startAmbience() {
  if (!ctx || ambNodes) return;
  const n = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const rng = mulberry32(0xa4b);
  let v = 0;
  for (let i = 0; i < n; i++) {
    v = v * 0.98 + (rng() * 2 - 1) * 0.02; // brown-ish noise
    data[i] = v * 3;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 500;
  const g = ctx.createGain();
  g.gain.value = 0.5;
  src.connect(f).connect(g).connect(ambBus);
  src.start();
  ambNodes = { src, g };
}

export function stopAmbience() {
  if (!ambNodes) return;
  try { ambNodes.src.stop(); } catch { /* already stopped */ }
  ambNodes = null;
}

// --- adaptive music: a small pentatonic loop; intensity scales with speed --------
const SCALE = [0, 3, 5, 7, 10]; // minor pentatonic offsets
const ROOT = 196; // G3

export function startMusic(seed = 1) {
  if (!ctx || musicTimer) return;
  musicState = { intensity: 0.4, step: 0, seed: seed >>> 0 };
  const beatMs = 300;
  musicTimer = setInterval(() => {
    if (!ctx || settings.muted || document.hidden) return;
    const st = musicState.step++;
    const rng = mulberry32((musicState.seed + st * 131) >>> 0);
    // bass on every 4th step
    if (st % 4 === 0) {
      const deg = SCALE[Math.floor(rng() * SCALE.length)];
      tone(musicBus, ROOT / 2 * Math.pow(2, deg / 12), beatMs * 4 / 1000, 'sine', 0.10);
    }
    // melody density scales with intensity
    if (rng() < 0.35 + musicState.intensity * 0.5) {
      const deg = SCALE[Math.floor(rng() * SCALE.length)] + (rng() < 0.3 ? 12 : 0);
      tone(musicBus, ROOT * Math.pow(2, deg / 12), 0.22, 'triangle', 0.06 + musicState.intensity * 0.06);
    }
  }, beatMs);
}

export function setMusicIntensity(v) {
  musicState.intensity = Math.max(0, Math.min(1, +v || 0));
}

export function stopMusic() {
  if (musicTimer) clearInterval(musicTimer);
  musicTimer = null;
}

// Visibility policy: quiet when hidden.
export function handleVisibility(hidden) {
  if (!ctx) return;
  if (hidden) {
    if (master) master.gain.value = 0;
  } else {
    applyVolumes();
  }
}

export function audioStarted() {
  return started || !!ctx;
}

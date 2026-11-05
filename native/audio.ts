// Sound, as the browser build's src/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.md) per game event — jump, lane change /
// turn, slide, relic pickup, set bonus, fork choice, vine crash, fall, finish,
// UI click, invalid move, countdown tick and GO — the quiet wind bed (brown
// noise through a 500 Hz low-pass) and the pentatonic music loop (a sine bass
// note every fourth 300 ms step, a triangle melody note on about half of them,
// at the run's music intensity 0.3). The browser build synthesized the bed
// and the music live with WebAudio nodes; here the same graphs render once
// (OfflineAudioContext) into clips looped while a run plays — the music from
// one fixed seed rather than each course's (the old notes were picked per
// seed). The bed plays on the music bus at its old level. The runtime's
// Options own the volumes, mute and the voice limit; UI clicks play on the
// "interface" bus, the rest on "effects". A clip still loading is silent.
// Everything loads in onStart; only starting the loops waits for the mixer (in
// a browser, the first press).
import { context, createClip, loadClip, OfflineAudioContext, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
import { mulberry32 } from "../src/rules.js";

export type SfxEvent = "jump" | "left" | "right" | "slide" | "collect" | "setbonus" | "branch" | "crash" | "fell" | "finish" | "click" | "invalid" | "countdown" | "go";
const SFX_BY_EVENT: Record<SfxEvent, string> = {
  jump: "jump-leap", left: "turn-swat", right: "turn-swat", slide: "slide-rush", collect: "relic-pickup", setbonus: "set-bonus-chime",
  branch: "fork-branch", crash: "vine-crash", fell: "fall-whistle", finish: "finish-fanfare", click: "ui-click", invalid: "ui-invalid",
  countdown: "count-tick", go: "run-go",
};
const clips = new Map<string, AudioClip>();
let suspended = false;

/** audio.js playEvent(kind): the event's clip, once loaded. */
export function event(kind: SfxEvent): void {
  if (suspended) return;
  const clip = clips.get(SFX_BY_EVENT[kind]);
  if (!clip) return;
  try { playClip(clip, { bus: kind === "click" || kind === "invalid" ? "interface" : "effects" }); }
  catch { /* the mixer is full this frame: skip it */ }
}

/** A hidden window: everything quiet (audio.js handleVisibility). */
export function setSuspended(on: boolean): void { suspended = on; }

// -- the rendered loops ----------------------------------------------------------------------------
const RATE = 22050;
const rand = mulberry32 as (seed: number) => () => number;

const BED_SECONDS = 2;
const BED_GAIN = 0.4; // the old bed's level (rms 0.080)
/** The wind bed: brown noise low-passed at 500 Hz. Filtered periodic noise is periodic once settled: no crossfade. */
async function renderBed(): Promise<AudioClip> {
  const settle = Math.round(0.5 * RATE);
  const off = new OfflineAudioContext(1, settle + BED_SECONDS * RATE, RATE);
  const noise = off.createNoise({ color: "brown", seed: 0xa4b, seconds: BED_SECONDS });
  const lp = off.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 500;
  const g = off.createGain(); g.gain.value = BED_GAIN;
  noise.connect(lp).connect(g).connect(off.destination); noise.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(settle)], RATE);
}

/** The music: 32 steps of 300 ms (startMusic's interval) from a fixed seed, intensity 0.3. */
const STEP_S = 0.3, STEPS = 32, SCALE = [0, 3, 5, 7, 10], ROOT = 196, INTENSITY = 0.3, MUSIC_SEED = 0x51a6e0;
interface Note { t0: number; f: number; dur: number; peak: number; tri: boolean }
const notes: Note[] = [];
for (let st = 0; st < STEPS; st++) {
  const r = rand((MUSIC_SEED + st * 131) >>> 0);
  if (st % 4 === 0) {
    const deg = SCALE[Math.floor(r() * SCALE.length)]!;
    notes.push({ t0: st * STEP_S, f: (ROOT / 2) * Math.pow(2, deg / 12), dur: STEP_S * 4, peak: 0.1, tri: false });
  }
  if (r() < 0.35 + INTENSITY * 0.5) {
    const deg = SCALE[Math.floor(r() * SCALE.length)]! + (r() < 0.3 ? 12 : 0);
    notes.push({ t0: st * STEP_S, f: ROOT * Math.pow(2, deg / 12), dur: 0.22, peak: 0.06 + INTENSITY * 0.06, tri: true });
  }
}
const MUSIC_N = Math.round(STEPS * STEP_S * RATE);
/** audio.js env(): exponential 8 ms attack from 0.0001 to the peak, exponential decay to 0.0001 at dur. */
async function renderMusic(): Promise<AudioClip> {
  const off = new OfflineAudioContext(1, MUSIC_N, RATE);
  for (const n of notes) {
    const osc = off.createOscillator();
    if (n.tri) osc.type = "triangle";
    osc.frequency.value = n.f;
    const g = off.createGain();
    g.gain.setValueAtTime(0.0001, n.t0);
    g.gain.exponentialRampToValueAtTime(n.peak, n.t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, n.t0 + n.dur);
    osc.connect(g).connect(off.destination);
    osc.start(n.t0); osc.stop(n.t0 + n.dur);
  }
  return createClip(await off.startRendering());
}
let bedClip: AudioClip | null = null, musicClip: AudioClip | null = null;
let bedVoice: Sound | null = null, musicVoice: Sound | null = null;
let running = false;

/** audio.js startAmbience + startMusic / stopMusic + stopAmbience: the loops play while a run is on. */
export function setRunning(on: boolean): void { running = on; }

/** Loads every clip at once and renders the loops (onStart). */
export function loadSfx(): void {
  for (const name of new Set(Object.values(SFX_BY_EVENT))) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); });
  }
  const warn = (e: unknown): void => { console.warn(`audio: ${String(e)}`); };
  renderBed().then((c) => { bedClip = c; }, warn);
  renderMusic().then((c) => { musicClip = c; }, warn);
}

/** Each frame, once the mixer runs: the loops, then their levels. */
export function update(): void {
  if (context.state !== "running" || !bedClip || !musicClip) return;
  const on = running && !suspended;
  if (on && !bedVoice) {
    try { bedVoice = playClip(bedClip, { bus: "music", loop: true, gain: 0 }); } catch { bedVoice = null; }
    return;
  }
  if (on && !musicVoice) {
    try { musicVoice = playClip(musicClip, { bus: "music", loop: true, gain: 0 }); } catch { musicVoice = null; }
    return;
  }
  for (const v of [bedVoice, musicVoice]) {
    if (!v) continue;
    try { v.fade(on ? 1 : 0, 0.15); } catch { /* the mixer restarted */ }
  }
  if (!running) {
    // a run ended: stop the loops so the next run starts them from the top (as startMusic did)
    for (const v of [bedVoice, musicVoice]) { try { v?.stop(); } catch { /* gone */ } }
    bedVoice = null; musicVoice = null;
  }
}

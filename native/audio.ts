// Sound, as the browser build's src/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.md) per game event — jump, lane change /
// turn, slide, relic pickup, set bonus, fork choice, vine crash, fall, finish,
// UI click, invalid move, countdown tick and GO — the quiet wind bed (brown
// noise through a 500 Hz low-pass) and the pentatonic music loop (a sine bass
// note every fourth 300 ms step, a triangle melody note on about half of them,
// at the run's music intensity 0.3). The browser build synthesized the bed
// and the music live with WebAudio nodes; here both are rendered once into
// clips (createClip, a slice a frame) and looped while a run plays — the
// music from one fixed seed rather than each course's (the old notes were
// picked per seed). The bed plays on the music bus at its old level (the
// runtime has no ambience bus). The runtime's Options own the volumes, mute
// and the voice limit; UI clicks play on the "interface" bus, the rest on
// "effects". The oscillator fallbacks the browser build played while a
// sample decoded are not ported (a live synthesis graph makes clip loads fail
// on the engine's web runtime), so a clip still loading is silent. Clips load
// once the mixer runs (natively at once, in a browser after the first press),
// one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
import { mulberry32 } from "../src/rules.js";

export type SfxEvent = "jump" | "left" | "right" | "slide" | "collect" | "setbonus" | "branch" | "crash" | "fell" | "finish" | "click" | "invalid" | "countdown" | "go";
const SFX_BY_EVENT: Record<SfxEvent, string> = {
  jump: "jump-leap", left: "turn-swat", right: "turn-swat", slide: "slide-rush", collect: "relic-pickup", setbonus: "set-bonus-chime",
  branch: "fork-branch", crash: "vine-crash", fell: "fall-whistle", finish: "finish-fanfare", click: "ui-click", invalid: "ui-invalid",
  countdown: "count-tick", go: "run-go",
};
const clips = new Map<string, AudioClip>();
const queue: string[] = [...new Set(Object.values(SFX_BY_EVENT))];
let loading = false;
let suspended = false;

/** audio.js playEvent(kind): the event's clip, once loaded. */
export function event(kind: SfxEvent): void {
  if (suspended) return;
  const name = SFX_BY_EVENT[kind];
  const clip = clips.get(name);
  if (!clip) return;
  try { playClip(clip, { bus: kind === "click" || kind === "invalid" ? "interface" : "effects" }); }
  catch { clips.delete(name); if (!queue.includes(name)) queue.push(name); } // a clip the mixer lost: load it again
}

/** A hidden window: everything quiet (audio.js handleVisibility). */
export function setSuspended(on: boolean): void { suspended = on; }

// -- the rendered loops ----------------------------------------------------------------------------
const RATE = 22050;
const rand = mulberry32 as (seed: number) => () => number;

/** The wind bed: two seconds of brown noise (v = 0.98 v + 0.02 noise, × 3), low-passed at 500 Hz, gain 0.5. */
const BED_N = RATE * 2;
const bed = new Float32Array(BED_N);
let bedDone = 0;
const bedRng = rand(0xa4b);
let bedV = 0, bedLp = 0;
const LP_A = 1 - Math.exp((-2 * Math.PI * 500) / RATE);
function renderBed(count: number): boolean {
  const end = Math.min(BED_N, bedDone + count);
  for (let i = bedDone; i < end; i++) {
    bedV = bedV * 0.98 + (bedRng() * 2 - 1) * 0.02;
    bedLp += (bedV * 3 - bedLp) * LP_A;
    bed[i] = bedLp * 0.5;
  }
  bedDone = end;
  return bedDone >= BED_N;
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
const music = new Float32Array(MUSIC_N);
let musicDone = 0;
/** audio.js env(): exponential 8 ms attack from 0.0001 to the peak, exponential decay to 0.0001 at dur. */
function env(t: number, peak: number, dur: number): number {
  if (t < 0 || t > dur) return 0;
  if (t < 0.008) return 0.0001 * Math.pow(peak / 0.0001, t / 0.008);
  return peak * Math.pow(0.0001 / peak, (t - 0.008) / (dur - 0.008));
}
function renderMusic(count: number): boolean {
  const end = Math.min(MUSIC_N, musicDone + count);
  for (let i = musicDone; i < end; i++) {
    let s = 0;
    for (const n of notes) {
      // the loop wraps: a long bass note near the end rings into the start
      let t = i / RATE - n.t0;
      if (t < 0) t += MUSIC_N / RATE;
      if (t > n.dur) continue;
      const ph = (t * n.f) % 1;
      s += (n.tri ? (ph < 0.5 ? 4 * ph - 1 : 3 - 4 * ph) : Math.sin(2 * Math.PI * ph)) * env(t, n.peak, n.dur);
    }
    music[i] = s;
  }
  musicDone = end;
  return musicDone >= MUSIC_N;
}
let bedClip: AudioClip | null = null, musicClip: AudioClip | null = null;
let bedVoice: Sound | null = null, musicVoice: Sound | null = null;
let running = false;

/** audio.js startAmbience + startMusic / stopMusic + stopAmbience: the loops play while a run is on. */
export function setRunning(on: boolean): void { running = on; }

/** Each frame: the clips once the mixer runs (one at a time), then the loops, then their levels. */
export function update(): void {
  if (context.state !== "running") return;
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => { console.warn(`sfx ${name}: ${String(e)}`); loading = false; });
    }
    return;
  }
  if (loading) return;
  if (!bedClip) {
    if (!renderBed(8000)) return;
    try { bedClip = createClip([bed], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); bedDone = 0; }
    return;
  }
  if (!musicClip) {
    if (!renderMusic(3000)) return;
    try { musicClip = createClip([music], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); musicDone = 0; }
    return;
  }
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

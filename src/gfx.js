// Relic Run - graphics quality model: presets, per-category overrides, StarHermit
// hardware-level detection, per-preset budgets and a cost summary. Pure (no three.js) so the settings panel, the
// renderer and the unit tests agree on what a setting means.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category -> allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  foliage: ['sparse', 'normal', 'dense'],
  detail: ['plain', 'detailed'],
  particles: ['off', 'low', 'high'],
  wind: ['off', 'on'],
};

// Each preset: a row of tiers, a render scale (multiplies the capped device
// pixel ratio) and the device-pixel-ratio cap.
const TABLE = {
  low: { scale: 1, cap: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', foliage: 'sparse', detail: 'plain', particles: 'off', wind: 'off' },
  balanced: { scale: 1, cap: 1.5, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', foliage: 'normal', detail: 'detailed', particles: 'low', wind: 'on' },
  high: { scale: 1, cap: 2, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', foliage: 'dense', detail: 'detailed', particles: 'high', wind: 'on' },
  ultra: { scale: 1.25, cap: 2, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', foliage: 'dense', detail: 'detailed', particles: 'high', wind: 'on' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

// Auto picks the preset from the StarHermit hardware level (0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX
// 5090; src/gpu-level.js → window.StarHermitGpu, a classic script loaded before the game): Low from 0,
// Balanced from 4, High from 10, Ultra from 17. Phones, tablets and ≤ 4 GB machines are capped at level 9.
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };
const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system) {
  const G = gpuApi();
  const sys = { webgl: true, webgl2: true, ...(system || {}), gpu: String(gpu || '') };
  if (!gpu) sys.webgl = false; // no renderer string: no usable WebGL
  return G ? G.detectLevel(sys) : (gpu ? LEVELS.balanced : 0);
}

/** The preset Auto starts from for a hardware level. */
export function presetForLevel(level) {
  const G = gpuApi();
  return G ? G.presetForLevel(level, LEVELS) : PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU (the hardware level already caps phones/tablets at Balanced). */
export function detectPreset(gpu, system) {
  return presetForLevel(detectLevel(gpu, system));
}

/*
 * Per-preset asset and effect budget. Each preset holds 60 FPS on the weakest GPU Auto gives it (Low →
 * level 0, Balanced → 4, High → 10, Ultra → 17; measured with tests/gfx-bench.mjs). The course, lanes,
 * obstacles, relics and timing are identical on every preset — only visuals change.
 *   material  surface shading: lambert (Low) / standard (Balanced) / physical clear-coated relics and a
 *             sheen tunic (High, Ultra; Detail on)
 *   texture   procedural stone / block / moss texture size in px (Detail on)
 *   bump      bump-mapped stone and barriers (Detail on)
 *   seg       curved-mesh segment multiplier (pillars, bushes, trees, runner, sky dome)
 *   motes     fireflies and pollen at Particles "high" (low: 35 %), scaled with the level
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
  low: { material: 'lambert', texture: 128, bump: false, seg: 0.75, motes: 100, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: 'standard', texture: 256, bump: false, seg: 1, motes: 140, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: 'physical', texture: 256, bump: true, seg: 1, motes: 200, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: 'physical', texture: 512, bump: true, seg: 1.5, motes: 300, bloomRes: 1, aoRes: 1 },
};
export const MOTE_MAX = 600;
const PARTICLE_SHARE = { off: 0, low: 0.35, high: 1 };

/** A preset's concrete budget for a hardware level (particle counts scale ≤ 2× within the preset). */
export function budgetFor(preset, level) {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  const G = gpuApi(), floor = LEVELS[preset] || 0;
  const lv = Math.max(Number.isFinite(level) ? level : floor, floor);
  const k = G ? Math.min(2, G.scaleBudget(1, lv, floor)) : 1;
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return b;
}

/** Fireflies and pollen for a resolved setting (Particles tier share of the preset's budget). */
export function moteCount(r) {
  return Math.round(r.budget.motes * (PARTICLE_SHARE[r.particles] ?? 0));
}

/**
 * Resolve saved settings into concrete tiers.
 * saved: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: tier }.
 * A category key that is missing or invalid means "from preset".
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const renderScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
  const out = { preset, auto, renderScale, scale: row.scale * renderScale, cap: row.cap };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.level = Number.isFinite(level) ? level : LEVELS[preset];
  out.budget = budgetFor(preset, out.level);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // Post-processing runs only when something needs it; otherwise the canvas MSAA is used.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' ||
    out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** Choosing a preset (or Auto) clears every per-category override. */
export function applyPreset(saved, preset) {
  const next = { ...(saved || {}) };
  for (const cat of Object.keys(CATEGORIES)) delete next[cat];
  next.preset = PRESETS.includes(preset) ? preset : 'auto';
  return next;
}

/** The preset's own tier for a category (for "From preset (...)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset] ? TABLE[preset][cat] : undefined;
}

const WORDS = {
  noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'AO', fullAo: 'full AO', bloom: 'bloom', noAA: 'no AA',
};

/** Short cost summary: shadows, AO, bloom, anti-aliasing, pixel size. `words` localizes it. */
export function describe(r, pixels, words = WORDS) {
  const w = { ...WORDS, ...words };
  const parts = [
    r.shadows === 'off' ? w.noShadows : w.shadows.replace('{n}', SHADOW_MAP[r.shadows]),
    r.ao === 'off' ? null : r.ao === 'high' ? w.fullAo : w.ao,
    r.bloom === 'on' ? w.bloom : null,
    r.antialias === 'off' ? w.noAA : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}

// Relic Run - graphics quality model: presets, per-category overrides, GPU
// detection and a cost summary. Pure (no three.js) so the settings panel, the
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

/**
 * Best preset for this GPU from the WEBGL_debug_renderer_info unmasked renderer
 * string. Software renderers get Low; discrete GPUs / Apple M get High; the
 * rest Balanced. Touch/mobile devices are capped at Balanced.
 */
export function detectPreset(gpu, opts = {}) {
  const g = String(gpu || '').toLowerCase();
  let p = 'balanced';
  if (/swiftshader|llvmpipe|softpipe|software|basic render/.test(g)) p = 'low';
  else if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|amd radeon(?! graphics)|apple m\d/.test(g)) p = 'high';
  if (opts.mobile && (p === 'high' || p === 'ultra')) p = 'balanced';
  return p;
}

/**
 * Resolve saved settings into concrete tiers.
 * saved: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: tier }.
 * A category key that is missing or invalid means "from preset".
 */
export function resolve(saved, detected) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const renderScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
  const out = { preset, auto, renderScale, scale: row.scale * renderScale, cap: row.cap };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
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

// The look per graphics level: the browser build's four presets and budgets
// (src/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the fireflies scaled within the tier by the level (frame().levelIndex,
// at most 2×), as the browser build scaled them by its hardware level. The
// course, lanes, hazards, relics and timing are identical on every tier — only
// visuals change. The runtime owns the rest of the old Graphics panel: Auto
// and the level choice, render scale and the pixel-ratio cap, adaptive
// resolution, the frame-rate limit and readout. The panel's per-category
// overrides are not offered (Options choose a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Surface shading: Lambert (Low), standard (Balanced), clear-coated relics and a sheen tunic (High, Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Baked stone / block / moss texture size in px (Detail on). */
  texture: 256 | 512;
  /** Bump-mapped stone and barriers. */
  bump: boolean;
  /** Curved-mesh segment multiplier (pillars, bushes, trees, runner, sky dome). */
  seg: number;
  /** Fireflies and pollen at Particles high (low: 35 %). */
  motes: number;
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  /** Key-light shadow map (0 = off). */
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  foliage: "sparse" | "normal" | "dense";
  /** Textures, bump maps, the sky dome, the room reflections, satchel and lantern, tint variation, relic spin. */
  detailed: boolean;
  particles: "off" | "low" | "high";
  wind: boolean;
  budget: Budget;
  /** Live fireflies (the Particles tier's share of the budget). */
  moteCount: number;
}

const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget" | "moteCount">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", foliage: "sparse", detailed: false, particles: "off", wind: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", foliage: "normal", detailed: true, particles: "low", wind: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", foliage: "dense", detailed: true, particles: "high", wind: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", foliage: "dense", detailed: true, particles: "high", wind: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 256, bump: false, seg: 0.75, motes: 100, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", texture: 256, bump: false, seg: 1, motes: 140, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", texture: 256, bump: true, seg: 1, motes: 200, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", texture: 512, bump: true, seg: 1.5, motes: 300, bloomRes: 1, aoRes: 1 },
};
export const MOTE_MAX = 600;
const SHARE = { off: 0, low: 0.35, high: 1 };
/** The first level index of each tier. */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  // Levels are about 1.64× apart in GPU throughput: the mote count grows with
  // the level above the tier's first, at most 2× (gfx.js budgetFor).
  const k = Math.min(2, Math.pow(1.64, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  const t = TABLE[preset];
  return { preset, ...t, budget: b, moteCount: Math.round(b.motes * SHARE[t.particles]) };
}

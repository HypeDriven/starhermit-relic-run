// The look per graphics level. The engine's level (levelSettings()) owns the
// engine effects: shadow on/off and map size, AO, bloom, grade, anti-aliasing,
// the texture cap, and how far the fireflies scale within the tier (the level's
// particle budget over the tier's anchor level, at most 2×). The art stays the
// browser build's four presets (each tuned to hold 60 FPS), keyed by the level's
// quality tier. The course, obstacles and timing are identical on every tier.
// The runtime owns Auto and the level choice, render scale and the pixel-ratio
// cap, adaptive resolution, the frame-rate limit and readout.
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
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
}
interface Art {
  foliage: "sparse" | "normal" | "dense";
  /** Textures, bump maps, the sky dome, the room reflections, satchel and lantern, tint variation, relic spin. */
  detailed: boolean;
  particles: "off" | "low" | "high";
  wind: boolean;
}
export interface Look extends Art {
  preset: QualityTier;
  /** Key-light shadow map, the level's size (0 = off). */
  shadows: number;
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** Bloom's resolution, the level's (null = off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  budget: Budget;
  /** Live fireflies (the Particles tier's share of the budget). */
  moteCount: number;
}

const ART: Record<QualityTier, Art> = {
  low: { foliage: "sparse", detailed: false, particles: "off", wind: false },
  balanced: { foliage: "normal", detailed: true, particles: "low", wind: true },
  high: { foliage: "dense", detailed: true, particles: "high", wind: true },
  ultra: { foliage: "dense", detailed: true, particles: "high", wind: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 256, bump: false, seg: 0.75, motes: 100 },
  balanced: { material: "standard", texture: 256, bump: false, seg: 1, motes: 140 },
  high: { material: "physical", texture: 256, bump: true, seg: 1, motes: 200 },
  ultra: { material: "physical", texture: 512, bump: true, seg: 1.5, motes: 300 },
};
export const MOTE_MAX = 600;
const SHARE = { off: 0, low: 0.35, high: 1 };
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };

/** The look for a graphics level's settings. */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  const b = BUDGETS[preset];
  const motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  const art = ART[preset];
  return {
    preset, ...art,
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: { ...b, motes },
    moteCount: Math.round(motes * SHARE[art.particles]),
  };
}

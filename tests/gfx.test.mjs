// Relic Run - graphics quality model (pure, no three.js).
import { describe, it, expect } from 'vitest';
import { PRESETS, CATEGORIES, detectPreset, resolve, presetTier, applyPreset, describe as describeGfx } from '../src/gfx.js';
import { STRINGS, pickLocale } from '../src/gfx-ui.js';

describe('detectPreset', () => {
  it('software renderers get low', () => {
    expect(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)')).toBe('low');
    expect(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe('low');
  });
  it('discrete GPUs and Apple M get high', () => {
    expect(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('high');
    expect(detectPreset('Apple M2 Pro')).toBe('high');
    expect(detectPreset('AMD Radeon RX 6800')).toBe('high');
  });
  it('integrated / unknown GPUs get balanced', () => {
    expect(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)')).toBe('balanced');
    expect(detectPreset('AMD Radeon Graphics')).toBe('balanced');
    expect(detectPreset('')).toBe('balanced');
  });
  it('mobile devices are capped at balanced', () => {
    expect(detectPreset('Apple M1', { mobile: true })).toBe('balanced');
    expect(detectPreset('Adreno (TM) 740', { mobile: true })).toBe('balanced');
    expect(detectPreset('SwiftShader', { mobile: true })).toBe('low');
  });
});

describe('resolve', () => {
  it('auto follows the detected preset', () => {
    const r = resolve({ preset: 'auto' }, 'low');
    expect(r.auto).toBe(true);
    expect(r.preset).toBe('low');
    expect(r.shadows).toBe('off');
    expect(r.post).toBe(false); // Low renders straight to the canvas
  });
  it('an explicit preset wins over detection', () => {
    const r = resolve({ preset: 'ultra' }, 'low');
    expect(r.auto).toBe(false);
    expect(r.shadows).toBe(presetTier('ultra', 'shadows'));
    expect(r.post).toBe(true);
  });
  it('per-category overrides apply; invalid values fall back to the preset', () => {
    const r = resolve({ preset: 'high', bloom: 'off', shadows: 'bogus', particles: 'low' }, 'low');
    expect(r.bloom).toBe('off');
    expect(r.shadows).toBe(presetTier('high', 'shadows'));
    expect(r.particles).toBe('low');
  });
  it('render scale is clamped to 50-200%', () => {
    expect(resolve({ preset: 'high', render_scale: 5 }).renderScale).toBe(2);
    expect(resolve({ preset: 'high', render_scale: 0.1 }).renderScale).toBe(0.5);
    expect(resolve({ preset: 'ultra', render_scale: 1 }).scale).toBeCloseTo(1.25);
  });
  it('adaptive defaults on, fps readout off', () => {
    const r = resolve({}, 'balanced');
    expect(r.adaptive).toBe(true);
    expect(r.showFps).toBe(false);
    expect(resolve({ adaptive: false, show_fps: true }).adaptive).toBe(false);
  });
  it('every preset defines every category with a valid tier', () => {
    for (const p of PRESETS) for (const [cat, tiers] of Object.entries(CATEGORIES)) expect(tiers).toContain(presetTier(p, cat));
  });
});

describe('applyPreset', () => {
  it('choosing a preset clears overrides but keeps scale/adaptive/fps', () => {
    const next = applyPreset({ preset: 'high', bloom: 'off', ao: 'high', render_scale: 1.5, adaptive: false, show_fps: true }, 'low');
    expect(next).toEqual({ preset: 'low', render_scale: 1.5, adaptive: false, show_fps: true });
    expect(applyPreset({ shadows: 'high' }, 'nonsense').preset).toBe('auto');
  });
});

describe('describe + localization', () => {
  it('summarises cost', () => {
    const s = describeGfx(resolve({ preset: 'high' }), [1280, 720]);
    expect(s).toContain('2048² shadows');
    expect(s).toContain('SMAA');
    expect(s).toContain('1280×720 px');
  });
  it('every locale translates every panel string', () => {
    const need = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
    for (const loc of need) {
      const L = STRINGS[loc];
      expect(L, loc).toBeTruthy();
      for (const k of ['graphics', 'quality', 'auto', 'renderScale', 'adaptive', 'showFps', 'fromPreset', 'postFailed']) expect(L[k], loc + k).toBeTruthy();
      for (const p of PRESETS) expect(L.presets[p]).toBeTruthy();
      for (const [cat, tiers] of Object.entries(CATEGORIES)) {
        expect(L.cats[cat], loc + cat).toBeTruthy();
        for (const t of tiers) expect(L.tiers[t], loc + t).toBeTruthy();
      }
    }
    expect(pickLocale('de')).toBe('de-DE');
    expect(pickLocale('fr-CA')).toBe('fr-CA');
    expect(pickLocale('es-MX')).toBe('es-419');
    expect(pickLocale('ja-JP')).toBe('en-US');
  });
});

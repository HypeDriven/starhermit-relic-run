// Relic Run - graphics quality model (pure, no three.js).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// src/gpu-level.js is a classic script in the page (window.StarHermitGpu); evaluate it the same way here.
new Function('window', 'module', readFileSync(new URL('../src/gpu-level.js', import.meta.url), 'utf8'))(globalThis, undefined);
const { PRESETS, CATEGORIES, detectPreset, detectLevel, presetForLevel, budgetFor, moteCount, resolve, presetTier, applyPreset,
  describe: describeGfx, LEVELS, BUDGETS, MOTE_MAX } = await import('../src/gfx.js');
const { STRINGS, pickLocale } = await import('../src/gfx-ui.js');

const DESK = { cores: 8, memoryGb: 8 };
const PHONE = { mobile: true, cores: 8, memoryGb: 8 };

describe('hardware level → Auto preset (Low 0, Balanced 4, High 10, Ultra 17)', () => {
  it('maps desktop GPUs by level', () => {
    expect(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', DESK)).toBe('low');
    expect(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK)).toBe(0);
    expect(detectPreset('', DESK)).toBe('low');
    expect(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK)).toBe('low');
    expect(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK)).toBe('low');
    expect(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK)).toBe('balanced');
    expect(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK)).toBe('high');
    expect(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK)).toBe('ultra');
    expect(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK)).toBe(20);
    expect(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK)).toBe('ultra');
    for (const [p, lv] of Object.entries(LEVELS)) expect(presetForLevel(lv)).toBe(p);
    expect(presetForLevel(3)).toBe('low');
    expect(presetForLevel(16)).toBe('high');
  });
  it('caps phones and tablets at Balanced; software GPUs stay Low', () => {
    expect(detectPreset('Adreno (TM) 740', PHONE)).toBe('balanced');
    expect(detectLevel('Adreno (TM) 740', PHONE)).toBeLessThanOrEqual(9);
    expect(detectPreset('Apple M2', PHONE)).toBe('balanced');
    expect(detectPreset('SwiftShader', PHONE)).toBe('low');
  });
});

describe('per-preset budgets', () => {
  it('are explicit, grow from Low to Ultra and scale with the level', () => {
    const keys = ['material', 'texture', 'bump', 'seg', 'motes', 'bloomRes', 'aoRes'];
    for (const p of PRESETS) for (const k of keys) expect(BUDGETS[p][k], `${p}.${k}`).not.toBeUndefined();
    for (let i = 1; i < PRESETS.length; i++) for (const k of keys) {
      if (typeof BUDGETS.low[k] === 'number') expect(BUDGETS[PRESETS[i]][k], `${PRESETS[i]}.${k}`).toBeGreaterThanOrEqual(BUDGETS[PRESETS[i - 1]][k]);
    }
    expect(PRESETS.map((p) => BUDGETS[p].material)).toEqual(['lambert', 'standard', 'physical', 'physical']);
    expect(PRESETS.map((p) => BUDGETS[p].bloomRes)).toEqual([0.5, 0.5, 0.5, 1]);
    expect(resolve({ preset: 'high' }, 'low', 10).budget).toEqual(BUDGETS.high);
    expect(resolve({ preset: 'ultra' }, 'low', 0).budget).toEqual(resolve({ preset: 'ultra' }, 'ultra', 17).budget);
    expect(budgetFor('balanced', 9).motes).toBeGreaterThan(budgetFor('balanced', 4).motes);
    expect(budgetFor('ultra', 20).motes).toBeLessThanOrEqual(MOTE_MAX);
    expect(moteCount(resolve({ preset: 'high' }, 'low', 10))).toBe(BUDGETS.high.motes);
    expect(moteCount(resolve({ preset: 'balanced' }, 'low', 4))).toBe(Math.round(BUDGETS.balanced.motes * 0.35));
    expect(moteCount(resolve({ preset: 'low' }, 'low', 0))).toBe(0);
    expect(resolve({}, 'low', 0).budget.material).toBe('lambert');
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

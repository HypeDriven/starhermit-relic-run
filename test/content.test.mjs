// Content tests: registry shape, validator over all stages/lessons/challenges,
// daily seed determinism and immutability.
import { describe, it, expect } from 'vitest';
import * as C from '../src/content.mjs';
import * as R from '../src/rules.mjs';

describe('content registry', () => {
  it('has 40 journey stages with unique ids and increasing difficulty', () => {
    expect(C.STAGES.length).toBe(40);
    const ids = new Set(C.STAGES.map((s) => s.id));
    expect(ids.size).toBe(40);
    expect(C.STAGES[0].genOpts.length).toBeLessThan(C.STAGES[39].genOpts.length);
  });

  it('has 5 themes with unique ids', () => {
    expect(C.THEMES.length).toBe(5);
    expect(new Set(C.THEMES.map((t) => t.id)).size).toBe(5);
    for (const s of C.STAGES) expect(C.THEMES.some((t) => t.id === s.theme)).toBe(true);
  });

  it('lessons introduce one mechanic each', () => {
    expect(C.LESSONS.length).toBe(4);
    const mechs = C.LESSONS.map((l) => l.mechanic);
    expect(new Set(mechs).size).toBe(4);
    for (const l of C.LESSONS) {
      const m = l.genOpts.mechanics;
      const enabled = ['turn', 'jump', 'slide', 'collect'].filter((k) => m[k]);
      expect(enabled).toContain(l.mechanic === 'turn' ? 'turn' : l.mechanic);
    }
  });

  it('challenges declare constraints', () => {
    expect(C.CHALLENGES.length).toBeGreaterThanOrEqual(2);
    for (const c of C.CHALLENGES) expect(c.constraint.type).toMatch(/move-limit|speed-target/);
  });
});

describe('content validator', () => {
  it('passes all authored content', () => {
    const r = C.validateContent();
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('catches defective content', () => {
    const bad = [{
      id: 'bad-1', seed: 1,
      genOpts: { length: 10, speed: 99, timeLimitTicks: 5, gapRate: 5, lowRate: -1, relicRate: 0, branchCount: 0, riskGapRate: 0, riskLowRate: 0 },
    }];
    const r = C.validateContent({ STAGES: bad, LESSONS: [], CHALLENGES: [] });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe('daily mode', () => {
  it('daily seed is deterministic per UTC date', () => {
    const a = C.dailySeedFor('2026-08-30');
    const b = C.dailySeedFor('2026-08-30');
    expect(a).toBe(b);
    expect(C.dailySeedFor('2026-08-31')).not.toBe(a);
  });
  it('daily content validates for sample days', () => {
    for (const dk of ['2026-08-30', '2026-02-28', '2024-02-29']) {
      const d = C.dailyContent(dk);
      const r = C.validateContent({ STAGES: [d], LESSONS: [], CHALLENGES: [] });
      expect(r.ok).toBe(true);
    }
  });
});

describe('golden journey stages', () => {
  it('easy stage finishable by policy', () => {
    const st = C.STAGES[0];
    const s = R.createState(st.seed, st.genOpts);
    let guard = 0;
    while (!s.terminal && guard++ < 20000) {
      const legal = R.legalActions(s);
      if (R.activeBranch(s) >= 0) R.applyCommand(s, 'left');
      else {
        const ci = Math.floor(s.distUnits / R.UNITS_PER_CELL);
        for (let d = 1; d <= 2; d++) {
          const c = s.course.cells[Math.min(ci + d, s.course.cells.length - 1)];
          if (!c) continue;
          if (c.gap && legal.includes('jump')) { R.applyCommand(s, 'jump'); break; }
          if (c.low && legal.includes('slide')) { R.applyCommand(s, 'slide'); break; }
        }
      }
      R.step(s);
    }
    expect(s.terminal).toBe('finished');
  });
});

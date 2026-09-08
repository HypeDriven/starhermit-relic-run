// Rules engine tests: actions, invalid reasons, scoring, terminals,
// serialization, fuzz safety.
import { describe, it, expect } from 'vitest';
import * as R from '../src/rules.js';

function runSteps(s, n) { for (let i = 0; i < n && !s.terminal; i++) R.step(s); }

describe('legal actions', () => {
  it('offers lane moves and jump/slide on open ground', () => {
    const s = R.createState(1, { gapRate: 0, lowRate: 0, branchCount: 0, relicRate: 0 });
    const legal = R.legalActions(s);
    expect(legal).toContain('left');
    expect(legal).toContain('right');
    expect(legal).toContain('jump');
    expect(legal).toContain('slide');
  });

  it('applies each legal action', () => {
    const s = R.createState(2, { gapRate: 0, lowRate: 0, branchCount: 0, relicRate: 0 });
    expect(R.applyCommand(s, 'left').ok).toBe(true);
    expect(s.lane).toBe(0);
    expect(R.applyCommand(s, 'right').ok).toBe(true);
    expect(s.lane).toBe(1);
    expect(R.applyCommand(s, 'jump').ok).toBe(true);
    expect(s.airTicks).toBeGreaterThan(0);
    runSteps(s, 30);
    expect(R.applyCommand(s, 'slide').ok).toBe(true);
    expect(s.slideTicks).toBeGreaterThan(0);
  });

  it('offers route choice at a branch window', () => {
    const s = R.createState(3, { gapRate: 0, lowRate: 0, branchCount: 1, relicRate: 0 });
    // run until the branch window opens
    let guard = 0;
    while (R.activeBranch(s) < 0 && guard++ < 5000) R.step(s);
    expect(R.activeBranch(s)).toBeGreaterThanOrEqual(0);
    expect(R.legalActions(s)).toEqual(['left', 'right']);
    const r = R.applyCommand(s, 'right');
    expect(r.ok).toBe(true);
    expect(s.route).toBe('risk');
  });

  it('keeps the risk route after passing the fork and frees other actions', () => {
    const s = R.createState(3, { gapRate: 0, lowRate: 0, branchCount: 1, relicRate: 0 });
    const forkCell = s.course.cells.findIndex((c) => c.branch);
    expect(forkCell).toBeGreaterThan(0);
    let guard = 0;
    while (R.activeBranch(s) < 0 && guard++ < 5000) R.step(s);
    R.applyCommand(s, 'right');
    // the fork is settled: normal moves are legal again inside the window
    expect(R.activeBranch(s)).toBe(-1);
    expect(R.legalActions(s)).toContain('jump');
    // and the choice survives crossing the fork cell
    guard = 0;
    while (R.cellIndex(s) <= forkCell && !s.terminal && guard++ < 5000) R.step(s);
    expect(s.route).toBe('risk');
  });

  it('ends the risk route once the branch span is behind the player', () => {
    const s = R.createState(3, {
      gapRate: 0, lowRate: 0, riskGapRate: 0, riskLowRate: 0,
      branchCount: 1, relicRate: 0, length: 400,
    });
    const forkCell = s.course.cells.findIndex((c) => c.branch);
    const span = s.course.cells[forkCell].branch;
    let guard = 0;
    while (R.activeBranch(s) < 0 && guard++ < 5000) R.step(s);
    R.applyCommand(s, 'right');
    expect(forkCell + span + 2).toBeLessThan(s.course.cells.length);
    guard = 0;
    while (R.cellIndex(s) < forkCell + span && !s.terminal && guard++ < 5000) R.step(s);
    expect(s.route).toBe('risk'); // still doubled on the last cell of the span
    guard = 0;
    while (R.cellIndex(s) <= forkCell + span && !s.terminal && guard++ < 5000) R.step(s);
    expect(s.route).toBe('safe');
  });

  it('returns no actions when terminal', () => {
    const s = R.createState(4, { gapRate: 0, lowRate: 0, branchCount: 0, relicRate: 0 });
    s.terminal = 'finished';
    expect(R.legalActions(s)).toEqual([]);
    expect(R.applyCommand(s, 'jump').reason).toBe('session-over');
  });
});

describe('invalid action reasons', () => {
  it('lane-edge', () => {
    const s = R.createState(5, { gapRate: 0, lowRate: 0, branchCount: 0, relicRate: 0 });
    R.applyCommand(s, 'left');
    const r = R.applyCommand(s, 'left');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('lane-edge');
    expect(s.invalids).toBe(1);
  });
  it('airborne blocks jump and slide', () => {
    const s = R.createState(6, { gapRate: 0, lowRate: 0, branchCount: 0, relicRate: 0 });
    R.applyCommand(s, 'jump');
    expect(R.applyCommand(s, 'jump').reason).toBe('airborne');
    expect(R.applyCommand(s, 'slide').reason).toBe('airborne');
  });
  it('sliding blocks jump', () => {
    const s = R.createState(7, { gapRate: 0, lowRate: 0, branchCount: 0, relicRate: 0 });
    R.applyCommand(s, 'slide');
    expect(R.applyCommand(s, 'jump').reason).toBe('sliding');
  });
  it('branch-choice-required', () => {
    const s = R.createState(8, { gapRate: 0, lowRate: 0, branchCount: 1, relicRate: 0 });
    let guard = 0;
    while (R.activeBranch(s) < 0 && guard++ < 5000) R.step(s);
    expect(R.applyCommand(s, 'jump').reason).toBe('branch-choice-required');
  });
  it('unknown-action and mechanic-disabled', () => {
    const s = R.createState(9, { gapRate: 0, lowRate: 0, branchCount: 0, relicRate: 0 });
    expect(R.applyCommand(s, 'fly').reason).toBe('unknown-action');
    expect(R.applyCommand(s, 42).reason).toBe('unknown-action');
    const s2 = R.createState(9, { mechanics: { turn: true, jump: false, slide: true, collect: true } });
    expect(R.applyCommand(s2, 'jump').reason).toBe('mechanic-disabled');
  });
});

describe('scoring components', () => {
  it('distance score grows with progress', () => {
    const s = R.createState(10, { gapRate: 0, lowRate: 0, branchCount: 0, relicRate: 0 });
    runSteps(s, 24); // ~1 cell at speed 12 (2 ticks/cell)
    const bd = R.scoreBreakdown(s);
    expect(bd.distance).toBeGreaterThan(0);
    expect(bd.total).toBe(bd.distance + bd.fragments + bd.riskBonus + bd.setBonus);
  });

  it('fragment collection, set bonus, risk multiplier', () => {
    const s = R.createState(11, { gapRate: 0, lowRate: 0, branchCount: 0, relicRate: 0, length: 60 });
    // hand-place relics: 3 of set 0 in center lane + 1 of set 1
    const cells = s.course.cells;
    cells[10].relicLane = 1; cells[10].relicSet = 0;
    cells[12].relicLane = 1; cells[12].relicSet = 0;
    cells[14].relicLane = 1; cells[14].relicSet = 0;
    cells[16].relicLane = 1; cells[16].relicSet = 1;
    runSteps(s, 30 * 4);
    const bd = R.scoreBreakdown(s);
    expect(s.fragments).toBe(4);
    expect(s.setBonuses).toBe(1);
    expect(bd.fragments).toBe(4 * R.FRAGMENT_POINTS);
    expect(bd.setBonus).toBe(R.SET_BONUS_POINTS);
    expect(bd.riskBonus).toBe(0);

    // risk route doubles fragment value
    const s2 = R.createState(11, { gapRate: 0, lowRate: 0, branchCount: 0, relicRate: 0, length: 60 });
    s2.course.cells[10].relicLane = 1; s2.course.cells[10].relicSet = 1;
    s2.route = 'risk';
    runSteps(s2, 30 * 4);
    expect(s2.fragments).toBe(2);
    expect(s2.riskFragments).toBe(2);
    const bd2 = R.scoreBreakdown(s2);
    expect(bd2.riskBonus).toBe(2 * R.FRAGMENT_POINTS);
    expect(bd2.fragments).toBe(0);
  });
});

describe('terminal states', () => {
  it('finished', () => {
    const s = R.createState(12, { length: 30, gapRate: 0, lowRate: 0, branchCount: 0, relicRate: 0 });
    runSteps(s, 30 * 30);
    expect(s.terminal).toBe('finished');
  });
  it('fell when running into a gap grounded', () => {
    const s = R.createState(13, { length: 60, gapRate: 0, lowRate: 0, branchCount: 0, relicRate: 0 });
    s.course.cells[6].gap = true;
    runSteps(s, 30 * 10);
    expect(s.terminal).toBe('fell');
  });
  it('crashed after losing all hearts to barriers', () => {
    const s = R.createState(14, { length: 200, gapRate: 0, lowRate: 0, branchCount: 0, relicRate: 0, hearts: 1 });
    s.course.cells[6].low = true;
    runSteps(s, 30 * 10);
    expect(s.terminal).toBe('crashed');
  });
  it('time-up when the clock runs out', () => {
    const s = R.createState(15, { length: 2000, gapRate: 0, lowRate: 0, branchCount: 0, relicRate: 0, timeLimitTicks: 30 });
    runSteps(s, 60);
    expect(s.terminal).toBe('time-up');
  });
  it('jumping clears a gap', () => {
    const s = R.createState(16, { length: 60, gapRate: 0, lowRate: 0, branchCount: 0, relicRate: 0, speed: 12 });
    s.course.cells[6].gap = true;
    // jump when 2 cells away
    let guard = 0;
    while (!s.terminal && guard++ < 2000) {
      const ci = Math.floor(s.distUnits / R.UNITS_PER_CELL);
      if (ci === 4 && s.airTicks === 0) R.applyCommand(s, 'jump');
      R.step(s);
    }
    expect(s.terminal).toBe('finished');
  });
});

describe('serialization', () => {
  it('round-trips exactly', () => {
    const s = R.createState(17, {});
    runSteps(s, 100);
    R.applyCommand(s, 'jump');
    runSteps(s, 5);
    const d = R.serialize(s);
    const s2 = R.deserialize(d);
    expect(R.hashState(s2)).toBe(R.hashState(s));
    expect(R.serialize(s2)).toEqual(d);
  });
  it('round-trips with collected relics', () => {
    const s = R.createState(18, { relicRate: 0.8, gapRate: 0, lowRate: 0, branchCount: 0 });
    runSteps(s, 60);
    const d = R.serialize(s);
    const s2 = R.deserialize(d);
    expect(R.hashState(s2)).toBe(R.hashState(s));
  });
  it('migrates v1 snapshots (no hearts field)', () => {
    const s = R.createState(19, {});
    const d = R.serialize(s);
    d.version = 1;
    delete d.genOpts.hearts;
    const s2 = R.deserialize(d);
    expect(s2.genOpts.hearts).toBe(R.MAX_HEARTS);
  });
  it('rejects garbage snapshots', () => {
    expect(() => R.deserialize(null)).toThrow();
    expect(() => R.deserialize({ version: 99 })).toThrow();
    expect(() => R.deserialize('')).toThrow();
  });
});

describe('fuzz safety', () => {
  it('malformed commands never hang or corrupt state', () => {
    const s = R.createState(20, {});
    const junk = [null, undefined, '', 'x'.repeat(1000), {}, [], NaN, -1, 1e9, 'jump\0', 'LEFT'];
    for (const j of junk) {
      const r = R.applyCommand(s, j);
      expect(r.ok).toBe(false);
      R.step(s);
      expect(Number.isFinite(s.distUnits)).toBe(true);
      expect(s.tick).toBeLessThan(100000);
    }
  });
  it('random action streams terminate with no NaN', () => {
    const rng = R.mulberry32(42);
    for (let trial = 0; trial < 20; trial++) {
      const s = R.createState(100 + trial, {});
      let guard = 0;
      while (!s.terminal && guard++ < 30000) {
        const legal = R.legalActions(s);
        if (legal.length && rng() < 0.3) {
          R.applyCommand(s, legal[Math.floor(rng() * legal.length)]);
        }
        R.step(s);
        expect(Number.isFinite(s.distUnits)).toBe(true);
      }
      expect(s.terminal).not.toBeNull();
      expect(guard).toBeLessThan(30000);
    }
  });
});

describe('determinism', () => {
  it('same seed same course', () => {
    const a = R.createState(77, {});
    const b = R.createState(77, {});
    expect(R.hashState(a)).toBe(R.hashState(b));
    expect(a.course.cells).toEqual(b.course.cells);
  });
  it('hashState has no boolean-mixing bugs', () => {
    const s = R.createState(78, {});
    const h1 = R.hashState(s);
    s.lane = 0;
    const h2 = R.hashState(s);
    expect(h1).not.toBe(h2);
  });
});

// Session tests: command log, idempotency, replay property, envelopes,
// snapshots, away summaries, tie-breaks, golden sessions.
import { describe, it, expect } from 'vitest';
import * as R from '../src/rules.js';
import * as S from '../src/session.js';

function playWithPolicy(sess, maxTicks = 30000) {
  let guard = 0;
  while (!sess.over && guard++ < maxTicks) {
    const a = S.autoAction(sess.state);
    if (a) sess.nextCmdId && S.applySessionCommand(sess, { id: sess.nextCmdId, action: a });
    S.advance(sess, 1);
  }
  return sess;
}

describe('command log', () => {
  it('accepts validated commands with monotonic ids', () => {
    const sess = S.startSession(S.newSession(1, { gapRate: 0, lowRate: 0, branchCount: 0, relicRate: 0 }));
    const r1 = S.applySessionCommand(sess, { id: 1, action: 'left' });
    expect(r1.ok).toBe(true);
    const r2 = S.applySessionCommand(sess, { id: 2, action: 'right' });
    expect(r2.ok).toBe(true);
    expect(sess.commands.map((c) => c.id)).toEqual([1, 2]);
  });

  it('rejects duplicates idempotently', () => {
    const sess = S.startSession(S.newSession(2, { gapRate: 0, lowRate: 0, branchCount: 0, relicRate: 0 }));
    S.applySessionCommand(sess, { id: 1, action: 'left' });
    const dup = S.applySessionCommand(sess, { id: 1, action: 'right' });
    expect(dup.ok).toBe(false);
    expect(dup.deduped).toBe(true);
    expect(sess.commands.length).toBe(1);
    expect(sess.state.lane).toBe(0);
  });

  it('invalid commands do not mutate sim state (besides invalid counter)', () => {
    const sess = S.startSession(S.newSession(3, { gapRate: 0, lowRate: 0, branchCount: 0, relicRate: 0 }));
    const before = R.hashState(sess.state);
    const r = S.applySessionCommand(sess, { id: 1, action: 'fly' });
    expect(r.ok).toBe(false);
    expect(sess.state.invalids).toBe(1);
    expect(R.hashState({ ...sess.state, invalids: 0 })).toBe(before);
    expect(sess.commands.length).toBe(0);
  });
});

describe('replay property', () => {
  it('same seed + commands produce identical hashes across runs', () => {
    for (const seed of [11, 222, 3333]) {
      const hashes = [];
      for (let run = 0; run < 2; run++) {
        const sess = S.startSession(S.newSession(seed, {}));
        const rng = R.mulberry32(seed ^ 99);
        const script = [];
        let guard = 0;
        while (!sess.over && guard++ < 20000) {
          const legal = R.legalActions(sess.state);
          if (legal.length && rng() < 0.25) {
            const a = legal[Math.floor(rng() * legal.length)];
            const res = S.applySessionCommand(sess, { id: sess.nextCmdId, action: a });
            if (res.ok) script.push({ id: sess.commands[sess.commands.length - 1].id, tick: sess.state.tick, action: a });
          }
          S.advance(sess, 1);
        }
        hashes.push({ h: R.hashState(sess.state), script });
      }
      // re-simulate from the recorded script
      const replayed = S.replayTicks(seed, hashes[0].script, {});
      expect(R.hashState(replayed.state)).toBe(hashes[0].h);
      expect(hashes[0].h).toBe(hashes[1].h);
    }
  });

  it('replay envelope is complete', () => {
    const sess = S.startSession(S.newSession(5, {}));
    playWithPolicy(sess, 8000);
    const env = S.replayEnvelope(sess);
    expect(env.schemaVersion).toBe(R.SCHEMA_VERSION);
    expect(env.contentVersion).toBe(S.CONTENT_VERSION);
    expect(env.seed).toBe(5);
    expect(Number.isInteger(env.initialHash)).toBe(true);
    expect(Array.isArray(env.commands)).toBe(true);
    expect(Array.isArray(env.stateHashes)).toBe(true);
    expect(env.terminal).toBe(sess.state.terminal);
    expect(env.score.total).toBe(R.scoreBreakdown(sess.state).total);
  });
});

describe('snapshots', () => {
  it('snapshot/restore preserves exact state', () => {
    const sess = S.startSession(S.newSession(6, {}));
    S.applySessionCommand(sess, { id: 1, action: 'left' });
    S.advance(sess, 50);
    const snap = S.snapshot(sess);
    const restored = S.restore(snap);
    expect(R.hashState(restored.state)).toBe(R.hashState(sess.state));
    expect(restored.commands).toEqual(sess.commands);
    // continue identically from both
    S.advance(sess, 30);
    S.advance(restored, 30);
    expect(R.hashState(restored.state)).toBe(R.hashState(sess.state));
  });

  it('restore rejects garbage', () => {
    expect(() => S.restore(null)).toThrow();
    expect(() => S.restore({})).toThrow();
  });

  it('away summary reports deltas', () => {
    const sess = S.startSession(S.newSession(7, { gapRate: 0, lowRate: 0, branchCount: 0, relicRate: 0 }));
    const before = S.snapshot(sess).state;
    S.advance(sess, 60);
    const sum = S.awaySummary(before, sess.state);
    expect(sum.ticksElapsed).toBe(60);
    expect(sum.scoreDelta).toBeGreaterThan(0);
    expect(sum.terminal).toBeNull();
  });
});

describe('tie-break ordering', () => {
  it('orders by completion, invalids, ticks, session id', () => {
    const a = { finished: true, invalids: 0, ticks: 100, sessionId: 'b' };
    const b = { finished: true, invalids: 0, ticks: 100, sessionId: 'a' };
    expect(R.compareResults(a, b)).toBeGreaterThan(0);
    expect(R.compareResults(b, a)).toBeLessThan(0);
    expect(R.compareResults(a, { ...a })).toBe(0);
    const unfinished = { finished: false, invalids: 0, ticks: 10, sessionId: 'x' };
    expect(R.compareResults(a, unfinished)).toBeLessThan(0);
    const moreInvalids = { finished: true, invalids: 2, ticks: 50, sessionId: 'a' };
    expect(R.compareResults(a, moreInvalids)).toBeLessThan(0);
    const slower = { finished: true, invalids: 0, ticks: 200, sessionId: 'a' };
    expect(R.compareResults(a, slower)).toBeLessThan(0);
  });
});

describe('golden sessions', () => {
  const GOLDENS = [
    { name: 'easy-open', seed: 101, opts: { gapRate: 0.03, lowRate: 0.03, branchCount: 1, relicRate: 0.4, length: 120 } },
    { name: 'hard-dense', seed: 202, opts: { gapRate: 0.07, lowRate: 0.09, branchCount: 4, length: 320, speed: 16 } },
    { name: 'terminal-fell', seed: 303, opts: { gapRate: 0.08, lowRate: 0, branchCount: 0, length: 200 }, noInput: true },
  ];
  for (const g of GOLDENS) {
    it(`golden ${g.name} is stable`, () => {
      const sess = S.startSession(S.newSession(g.seed, g.opts));
      let guard = 0;
      while (!sess.over && guard++ < 30000) {
        if (!g.noInput) {
          const a = S.autoAction(sess.state);
          if (a) S.applySessionCommand(sess, { id: sess.nextCmdId, action: a });
        }
        S.advance(sess, 1);
      }
      const hash = R.hashState(sess.state);
      // golden: record once, then assert stability across recomputation
      const again = S.startSession(S.newSession(g.seed, g.opts));
      guard = 0;
      while (!again.over && guard++ < 30000) {
        if (!g.noInput) {
          const a = S.autoAction(again.state);
          if (a) S.applySessionCommand(again, { id: again.nextCmdId, action: a });
        }
        S.advance(again, 1);
      }
      expect(R.hashState(again.state)).toBe(hash);
      expect(sess.state.terminal).toBe(g.noInput ? 'fell' : 'finished');
    });
  }
});

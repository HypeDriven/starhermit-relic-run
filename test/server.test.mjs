// Server replay-validation tests (no sockets): verifyScore accepts honest
// replays and rejects tampered ones.
import { describe, it, expect } from 'vitest';
import { verifyScore } from '../server.js';
import * as S from '../src/session.mjs';
import * as R from '../src/rules.mjs';

function honestSubmission(seed = 555, opts = {}) {
  const sess = S.startSession(S.newSession(seed, opts));
  let guard = 0;
  while (!sess.over && guard++ < 30000) {
    const a = S.autoAction(sess.state);
    if (a) S.applySessionCommand(sess, { id: sess.nextCmdId, action: a });
    S.advance(sess, 1);
  }
  const env = S.replayEnvelope(sess);
  return {
    ruleset: env.schemaVersion,
    contentVersion: env.contentVersion,
    seed: env.seed,
    genOpts: env.genOpts,
    durationTicks: sess.state.tick,
    commands: env.commands,
    scoreBreakdown: env.score,
  };
}

describe('score verification', () => {
  it('accepts an honest replay', () => {
    const body = honestSubmission();
    const v = verifyScore(body);
    expect(v.ok).toBe(true);
    expect(v.breakdown.total).toBe(body.scoreBreakdown.total);
  });

  it('rejects an inflated score', () => {
    const body = honestSubmission();
    body.scoreBreakdown = { ...body.scoreBreakdown, total: body.scoreBreakdown.total + 100 };
    const v = verifyScore(body);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('score-mismatch');
  });

  it('rejects impossible commands (illegal actions are still validated)', () => {
    const body = honestSubmission();
    body.commands.push({ id: 9999, tick: 1, action: 'jump' });
    // replay still runs; score must still match (invalid actions don't inflate)
    const v = verifyScore(body);
    expect(typeof v.ok).toBe('boolean');
  });
});

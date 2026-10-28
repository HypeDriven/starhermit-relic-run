// The progress this client stores (src/progress.js): normalizing, merging two
// devices' copies as the browser build's cloud conflicts did, reading the
// browser build's cloud slot (its whole profile as JSON) and settings groups.
// The signed-in paths can't be played here, so their logic is covered here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/progress.js';

const oldProfile = {
  version: 1,
  settings: {
    audio: { music: 0.2, effects: 0.8, ambience: 0.5, master: 1, muted: false },
    graphics: { reducedMotion: false, gfx: { preset: 'high' } },
    controls: { leftHanded: true, holdToSlide: false, haptics: true },
    accessibility: { colorblindPalette: true, highContrast: false, largeText: false, reducedMotion: false, timingAssist: false },
  },
  journey: { unlocked: 5, completed: { 'journey-01': { score: 400, finished: true }, 'journey-02': { score: 120, finished: false } } },
  achievements: { 'first-finish': { unlockedAt: '2026-09-01T10:00:00.000Z' } },
  bestScores: { 'daily-2026-09-01': { total: 900, breakdown: { total: 900 }, date: '2026-09-01' } },
  tutorials: { 'learn-turn': true },
  totals: { fragments: 321, runs: 12, dailies: { '2026-09-01': 900 } },
};

test('a blank and a broken document normalize to a new player', () => {
  for (const raw of [null, 'x', 42, [], { journey: 'nope' }]) {
    const p = P.normalize(raw);
    assert.equal(p.journey.unlocked, 1);
    assert.deepEqual(p.journey.completed, {});
    assert.deepEqual(p.totals, { runs: 0, fragments: 0, dailies: {} });
  }
  assert.ok(P.same(P.blank(), null));
});

test('the browser build\'s cloud slot becomes progress and options', () => {
  const f = P.readForeign(JSON.stringify(oldProfile));
  assert.equal(f.progress.journey.unlocked, 5);
  assert.equal(f.progress.journey.completed['journey-01'].finished, true);
  assert.equal(f.progress.bestScores['daily-2026-09-01'].total, 900);
  assert.equal(f.progress.totals.runs, 12);
  assert.equal(f.progress.settings, undefined);
  assert.deepEqual(f.options, { leftHanded: true, colorblind: true, timingAssist: false });
  assert.equal(P.readForeign('not json'), null);
  assert.equal(P.readForeign(''), null);
});

test('two copies merge without losing either side', () => {
  const a = P.normalize(oldProfile);
  const b = P.normalize({
    journey: { unlocked: 3, completed: { 'journey-02': { score: 300, finished: true }, 'journey-03': { score: 50, finished: false } } },
    achievements: { 'first-finish': { unlockedAt: '2026-08-01T10:00:00.000Z' }, 'daily-streak-3': { unlockedAt: '2026-09-02T00:00:00.000Z' } },
    bestScores: { 'daily-2026-09-01': { total: 500 }, 'daily-2026-09-02': { total: 700 } },
    tutorials: { 'learn-jump': true },
    totals: { fragments: 400, runs: 3, dailies: { '2026-09-01': 500, '2026-09-02': 700 } },
  });
  const m = P.merge(a, b);
  assert.equal(m.journey.unlocked, 5);
  assert.deepEqual(m.journey.completed['journey-02'], { score: 300, finished: true });
  assert.ok(m.journey.completed['journey-03']);
  assert.equal(m.achievements['first-finish'].unlockedAt, '2026-08-01T10:00:00.000Z');
  assert.ok(m.achievements['daily-streak-3']);
  assert.equal(m.bestScores['daily-2026-09-01'].total, 900);
  assert.equal(m.bestScores['daily-2026-09-02'].total, 700);
  assert.deepEqual(Object.keys(m.tutorials).sort(), ['learn-jump', 'learn-turn']);
  assert.equal(m.totals.fragments, 400);
  assert.equal(m.totals.runs, 12);
  assert.deepEqual(m.totals.dailies, { '2026-09-01': 900, '2026-09-02': 700 });
  assert.ok(P.same(P.merge(m, a), m), 'merging again changes nothing');
});

test('achievements unlock once, unknown ones never', () => {
  const p = P.blank();
  assert.equal(P.unlock(p, 'first-finish', 'T1'), true);
  assert.equal(P.unlock(p, 'first-finish', 'T2'), false);
  assert.equal(p.achievements['first-finish'].unlockedAt, 'T1');
  assert.equal(P.unlock(p, 'nope', 'T'), false);
});

test('legacy settings keys and groups', () => {
  for (const k of ['audio', 'graphics', 'controls', 'accessibility', 'camera', 'ui.language', 'audio.options', 'graphics.gpu.x']) assert.ok(P.isLegacyKey(k), k);
  assert.ok(!P.isLegacyKey('leftHanded'));
  assert.deepEqual(P.optionsFromSettings({ controls: { leftHanded: false }, accessibility: { timingAssist: true } }), { leftHanded: false, timingAssist: true });
  assert.deepEqual(P.pickOptions({ leftHanded: 'yes', colorblind: true }), { colorblind: true });
});

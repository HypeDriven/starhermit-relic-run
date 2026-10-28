// The few vitest names the kept rules, session and content tests use
// (describe / it / test / expect), on node:test and node:assert, so they run
// unchanged under `node --test` without vitest.
import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';

export { describe, it, test };
export function expect(actual) {
  const m = {
    toBe: (v) => assert.strictEqual(actual, v),
    toEqual: (v) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(v))),
    toContain: (v) => assert.ok(actual.includes(v), `${JSON.stringify(actual)} contains ${JSON.stringify(v)}`),
    toBeNull: () => assert.strictEqual(actual, null),
    toBeGreaterThan: (v) => assert.ok(actual > v, `${actual} > ${v}`),
    toBeGreaterThanOrEqual: (v) => assert.ok(actual >= v, `${actual} >= ${v}`),
    toBeLessThan: (v) => assert.ok(actual < v, `${actual} < ${v}`),
    toMatch: (re) => assert.match(actual, re),
    toThrow: (want) => (want === undefined ? assert.throws(actual) : assert.throws(actual, (e) => (want instanceof RegExp ? want.test(e.message) : String(e.message).includes(want)))),
  };
  m.not = {
    toBe: (v) => assert.notStrictEqual(actual, v),
    toBeNull: () => assert.notStrictEqual(actual, null),
  };
  return m;
}

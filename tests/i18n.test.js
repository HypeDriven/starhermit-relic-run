// Localization coverage: every English key the native client draws (T("…")
// and N("…") in native/*.ts, and the content's names and texts it passes to
// T()) is translated in every full locale (en-GB → en-US, es-ES → es-419,
// fr-CA → fr-FR inherit), no table row is unused, placeholders survive, and
// the account strings cover the nine locales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { platformStrings } from '../src/platform-i18n.js';
import { STAGES, LESSONS, CHALLENGES, THEMES, PRACTICE_DIFFICULTIES } from '../src/content.js';
import { ACHIEVEMENTS } from '../src/progress.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
export const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
const FULL = ['es-419', 'de-DE', 'fr-FR', 'pt-BR', 'it-IT'];

export function tables() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read('src/strings.js'), sandbox);
  return sandbox.RR_STRINGS;
}
export function usedKeys() {
  const keys = new Set();
  const lit = String.raw`"((?:[^"\\]|\\.)*)"`;
  for (const f of readdirSync(new URL('native/', ROOT)).filter((n) => n.endsWith('.ts'))) {
    const src = read(`native/${f}`);
    for (const m of src.matchAll(new RegExp(String.raw`\b[TN]\(\s*${lit}`, 'g'))) keys.add(m[1].replace(/\\"/g, '"'));
  }
  for (const k of [
    ...STAGES.flatMap((s) => [s.name, s.difficulty, s.tutorial].filter(Boolean)),
    ...LESSONS.flatMap((l) => [l.name, l.intro, l.prompt, l.goalText]),
    ...CHALLENGES.flatMap((c) => [c.name, c.description]),
    ...THEMES.map((t) => t.name),
    ...Object.values(PRACTICE_DIFFICULTIES).map((d) => d.label),
    ...ACHIEVEMENTS.flatMap((a) => [a.name, a.description]),
    'jump', 'slide', // the invalid-move toast names the action (left, right are lane names too)
  ]) keys.add(k);
  return [...keys].filter((k) => /[A-Za-z]/.test(k)).sort();
}

test('every key the client draws is translated in every locale; no unused rows; placeholders intact', () => {
  const T = tables();
  const used = usedKeys();
  assert.ok(used.length > 150, `keys found: ${used.length}`);
  const problems = [];
  for (const loc of FULL) for (const k of used) if (!Object.prototype.hasOwnProperty.call(T[loc] || {}, k)) problems.push(`${loc} missing: ${k}`);
  for (const [loc, table] of Object.entries(T)) {
    if (!LOCALES.includes(loc)) problems.push(`unknown locale ${loc}`);
    for (const [k, v] of Object.entries(table)) {
      if (!used.includes(k)) { problems.push(`${loc} unused: ${k}`); continue; }
      const want = (k.match(/\{\w+\}/g) || []).sort().join(), got = (String(v).match(/\{\w+\}/g) || []).sort().join();
      if (want !== got) problems.push(`${loc} placeholders: ${k}`);
    }
  }
  for (const loc of ['en-GB', 'es-ES', 'fr-CA']) if (!T[loc]) problems.push(`no ${loc} table`);
  assert.deepEqual(problems, []);
});

test('the account strings cover all nine locales', () => {
  const keys = Object.keys(platformStrings('en-US'));
  for (const l of LOCALES) for (const k of keys) assert.ok(platformStrings(l)[k], `${l} ${k}`);
});

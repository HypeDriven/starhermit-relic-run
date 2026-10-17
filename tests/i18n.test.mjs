// Localization coverage: every English key the markup and code use is
// translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR
// inherit), placeholders survive, all content is covered, and the language
// follows sh-language.js and switches live.
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadTables, codeKeys, htmlKeys, audit, bootI18n, LOCALES } from './i18n-common.mjs';
import { STAGES, LESSONS, CHALLENGES, THEMES, PRACTICE_DIFFICULTIES } from '../src/content.js';
import { ACHIEVEMENTS } from '../src/store.js';
import { pickLocale } from '../src/sh-i18n.js';
import { shText } from '../src/sh-i18n.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

function contentKeys() {
  return [
    ...STAGES.flatMap((s) => [s.name, s.difficulty, s.tutorial].filter(Boolean)),
    ...LESSONS.flatMap((l) => [l.name, l.intro, l.prompt, l.goalText]),
    ...CHALLENGES.flatMap((c) => [c.name, c.description]),
    ...THEMES.map((t) => t.name),
    ...Object.values(PRACTICE_DIFFICULTIES).map((d) => d.label),
    ...ACHIEVEMENTS.flatMap((a) => [a.name, a.description]),
    'left', 'right', 'jump', 'slide', // invalid-move toast names the action
  ];
}

function usedKeys() {
  const keys = new Set(htmlKeys(read('index.html')));
  for (const f of ['src/main.js', 'src/ui.js', 'src/platform.js']) codeKeys(read(f)).forEach((k) => keys.add(k));
  contentKeys().forEach((k) => keys.add(k));
  return [...keys].sort();
}

test('every used key is translated in every locale; placeholders intact', () => {
  const used = usedKeys();
  expect(used.length).toBeGreaterThan(250);
  expect(audit(loadTables(ROOT, 'src/strings.js', 'RR_STRINGS'), used)).toEqual([]);
});

test('the locale follows sh-language and switches live', () => {
  const { I18N, events, doc } = bootI18n(ROOT, { strings: 'src/strings.js', i18n: 'src/i18n.js', global: 'RRI18N', languages: ['de-DE'] });
  expect(I18N.lang).toBe('de-DE');
  expect(doc.documentElement.lang).toBe('de-DE');
  expect(I18N.T('Paused')).toBe('Pausiert');
  I18N.language.setChoice('fr-CA');
  expect(I18N.lang).toBe('fr-CA');
  expect(events.at(-1)).toBe('fr-CA');
  expect(I18N.T('Friends & scores')).toBe('Amis et pointages');
  I18N.language.setChoice('en-GB');
  expect(I18N.T('Colorblind-safe palette')).toBe('Colourblind-safe palette');
  I18N.language.setChoice('it-IT');
  expect(I18N.T('gap in {n}', { n: 3 })).toBe('buco tra 3');
});

test('StarHermit strings cover all nine locales', () => {
  for (const l of LOCALES) expect(pickLocale(l)).toBe(l === 'en-GB' ? 'en-GB' : l);
  expect(shText('signIn')).toBe('Sign in with StarHermit');
});

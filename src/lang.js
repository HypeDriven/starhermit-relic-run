// Localization access for the game modules. The tables and the runtime live
// in src/strings.js + src/i18n.js (classic scripts loaded before src/main.js,
// global RRI18N); outside the browser (Node tests) English keys come back
// unchanged.

/** Translate an English source string; {name} placeholders are filled from vars. */
export function T(key, vars) {
  const I = globalThis.RRI18N;
  if (I) return I.T(key, vars);
  return vars ? String(key).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : String(key);
}

/** Marks an English key for a later T() (content tables). */
export const N = (key) => key;

/** The game's current locale (navigator language outside the runtime). */
export function lang() {
  return globalThis.RRI18N?.lang ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US');
}

/** Run cb whenever the game language changes (Settings → Language, account preference). */
export function onLanguage(cb) {
  if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('rr-language', () => cb());
}

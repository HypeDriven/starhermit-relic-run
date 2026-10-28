// Localization: the browser build's string tables (src/strings.js, English
// text as the key; en-GB, es-ES and fr-CA list only their differences from
// en-US, es-419 and fr-FR) and the account-control strings
// (src/platform-i18n.js), in the interface language the runtime reports
// (preferences().language: the player's choice in Options › Language, else
// the account's preferred language or the device's). The runtime's Options
// replaced the game's Language setting (sh-language.js) and the DOM
// re-labelling (src/i18n.js): every string is drawn through T() each frame,
// so a change shows on the next frame without touching the run.
import { onPreferencesChange, preferences } from "starhermit:engine";
import { loadClassic } from "starhermit:script";
import * as ui from "starhermit:ui";
import { pickPlatformLocale, platformStrings } from "../src/platform-i18n.js";

loadClassic("src/strings.js");
type Table = Record<string, string>;
const TABLES = (globalThis as unknown as { RR_STRINGS: Record<string, Table> }).RR_STRINGS;
const PARENT: Record<string, string> = { "en-GB": "en-US", "es-ES": "es-419", "fr-CA": "fr-FR" };
export const LOCALES = ["en-US", "en-GB", "es-419", "es-ES", "de-DE", "fr-FR", "fr-CA", "pt-BR", "it-IT"];

let locale = "en-US";
let applied = false;
function apply(tag: string): void {
  const next = pickPlatformLocale(tag) as string;
  if (next === locale && applied) return;
  applied = true;
  locale = LOCALES.includes(next) ? next : "en-US";
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));
export function currentLocale(): string { return locale; }

function lookup(key: string): string {
  for (let l: string | undefined = locale; l; l = PARENT[l]) {
    const t = TABLES[l];
    if (t && Object.prototype.hasOwnProperty.call(t, key)) return t[key]!;
  }
  return key;
}
export type Vars = Record<string, string | number>;
/** A game string by its English key in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string {
  const s = lookup(key);
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m)) : s;
}
/** Marks an English key; translated with T() where it is shown. */
export const N = (key: string): string => key;
/** The account controls' strings (sign in, invite, leaderboard line, …). */
export function S(key: string, vars?: Vars): string {
  let s = (platformStrings(locale) as Record<string, string>)[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

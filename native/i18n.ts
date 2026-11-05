// Localization: assets/strings.json (generated from the browser build's string
// tables, English text as the key; en-GB, es-ES and fr-CA list only their
// differences) on the engine's strings, which follow the interface language
// the runtime reports (the player's choice in Options › Language, else the
// account's preferred language or the device's) and own the locale fallback
// and the account-control strings (`starhermit.*`). Every string is drawn
// through T() each frame, so a change shows on the next frame without touching
// the run.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));

export type Vars = Record<string, string | number>;
/** A game string by its English key in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return strings.t(key, vars ?? undefined); }
/** Marks an English key; translated with T() where it is shown. */
export const N = (key: string): string => key;
/** The account controls' strings (sign in, invite, leaderboard line, …). */
export function S(key: string, vars?: Vars): string { return strings.t(`starhermit.${key}`, vars); }

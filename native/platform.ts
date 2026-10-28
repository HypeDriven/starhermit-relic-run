// The game's data and the StarHermit platform, on the runtime's modules:
// - progress (the Journey unlock and per-stage records, achievements, best
//   scores per board, finished lessons and the run/fragment/daily totals;
//   src/progress.js) is the game's save (starhermit:storage `saves`), on the
//   device and in the player's cloud slot; two devices' copies merge as the
//   browser build's cloud conflicts did. The slot the browser build wrote (the
//   JS SDK's saveJSON of its whole profile under game:<slug>) shows as
//   foreign: it is merged in (with the game's three options) and replaced once;
// - the game's own options (left-handed tray, colorblind-safe palette, timing
//   assistance) are engine `settings`; the browser build's values in the
//   account's settings KV (its controls and accessibility groups) are adopted
//   (unless set here since), then all its KV keys are removed (volumes, mute,
//   graphics, reduced motion, high contrast, larger text, haptics and language
//   are the runtime's Options; key bindings are the runtime's controls);
// - the player, the invite link, the platform's clock for the Daily's date,
//   posting a finished run's total through score-script.js (a practice
//   session whose socket carries { type: 'result', scores }, as the JS SDK's
//   submitScores did) with the rank on the high-score board, and the board's
//   top entries for the Friends screen.
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions, type Leaderboard,
} from "starhermit:platform";
import { saves, settings as store } from "starhermit:storage";
import { Progress, type GameOptions, type Progress as Doc } from "./game.ts";

type Key = keyof GameOptions;

// --- the game's options --------------------------------------------------------------------
export const options: GameOptions = { leftHanded: false, colorblind: false, timingAssist: false };
const optionListeners = new Set<() => void>();
export function onOptionsChange(fn: () => void): void { optionListeners.add(fn); }
function optionsChanged(): void { for (const fn of optionListeners) fn(); }
function readOption(key: Key): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = Progress.pickOptions({ [key]: v })[key];
  if (ok !== undefined) options[key] = ok;
}
/** Changes one of the game's options (device and account). */
export function setOption(key: Key, value: boolean): void {
  if (options[key] === value) return;
  options[key] = value;
  try { store.set(key, value); } catch (e) { console.warn(`option ${key}: ${String(e)}`); }
  optionsChanged();
}
/** A migrated value, kept unless this game set the key since. */
function adoptOptions(values: Partial<GameOptions>): void {
  let changed = false;
  for (const [k, v] of Object.entries(Progress.pickOptions(values)) as [Key, boolean][]) {
    try {
      if (store.get(k) !== undefined) continue;
      store.set(k, v);
      options[k] = v;
      changed = true;
    } catch { /* keep the device's */ }
  }
  if (changed) optionsChanged();
}
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  adoptOptions(Progress.optionsFromSettings({ controls: store.legacy("controls"), accessibility: store.legacy("accessibility") }));
  for (const k of keys) if (Progress.isLegacyKey(k)) store.removeLegacy(k);
}

// --- the save ------------------------------------------------------------------------------
let doc: Doc = Progress.blank();
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

/** The live progress (runs update it in place, then saveNow()). */
export function progress(): Doc { return doc; }
/** Saves the progress (device at once, the account debounced by the runtime). */
export function saveNow(opts: { replaceForeign?: boolean } = {}): void {
  try {
    saves.save(doc as unknown as JsonValue, { schema: 1, ...opts });
    lastSavedAt = saves.load()?.savedAt ?? lastSavedAt;
  } catch (e) { console.warn(`save: ${String(e)}`); }
}
/** Keeps the live object (screens hold it) and fills it from `next`. */
function replaceWith(next: Doc): void { Object.assign(doc, next); }
function adopt(other: unknown): boolean {
  const next = Progress.merge(doc, other);
  if (Progress.same(next, doc)) return false;
  replaceWith(next);
  saveNow();
  return true;
}
saves.onConflict((mine, remote) => ({ merged: Progress.merge(mine?.data ?? null, remote.data) as unknown as JsonValue }));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  // the account's save replaced the device's (another device saved last): merge it in
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(cur.data)) merged();
  }
});
/** The browser build's cloud mirror: merged with this device's progress, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const prev = Progress.normalize(doc);
  const foreign = Progress.readForeign(old.text ?? null);
  if (foreign) {
    replaceWith(Progress.merge(doc, foreign.progress));
    adoptOptions(foreign.options);
  }
  saveNow({ replaceForeign: true });
  if (!Progress.same(prev, doc)) merged();
}

/** For the title's profile line: saving | synced | offline (null for a guest). */
export function syncState(): "saving" | "synced" | "offline" | null {
  if (!player()) return null;
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "offline";
  if (st === "loading" || st === "foreign" || st === "uploading" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

/** Reads the device's save and the game's options (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  doc = Progress.normalize(cur?.data ?? null);
  for (const k of Progress.OPTION_KEYS) readOption(k);
  store.onChange((k) => {
    if (!(Progress.OPTION_KEYS as string[]).includes(k)) return;
    readOption(k as Key);
    optionsChanged();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  optionsChanged();
  refreshPlayer();
  void serverTime().catch(() => undefined);
}

// --- the player and the clock ------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = undefined;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
const playerListeners = new Set<(signedIn: boolean) => void>();
export function onPlayer(fn: (signedIn: boolean) => void): void { playerListeners.add(fn); }
onPlayerChange(() => { refreshPlayer(); for (const fn of playerListeners) fn(!!player()); });

/** Now in ms by the platform's clock when it has answered, else the device's (the Daily's UTC day). */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}

// --- the high-score board ------------------------------------------------------------------
let board: Leaderboard | null | undefined;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board !== undefined) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
export interface Posted { posted: boolean; rank: number | null }

/** Signed in only: post a finished run's total through score-script.js; { posted, rank }. Never rejects. */
export async function postScore(total: number): Promise<Posted> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (data) => {
        const d = data as { type?: string; accepted?: string[] } | null;
        if (d && d.type === "result-ack") finish(Array.isArray(d.accepted) ? d.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}

export interface BoardRow { rank: number; name: string; score: number; mine: boolean }
/** The board's top entries (Friends & scores), or null when there is no board. Never rejects. */
export async function boardTop(pageSize = 20): Promise<BoardRow[] | null> {
  const me = player();
  try {
    const b = await highScoreBoard();
    if (!b) return null;
    const r = await leaderboards.entries(b.id, { pageSize });
    return r.items.map((e, i) => ({ rank: e.rank ?? i + 1, name: e.displayName || e.username, score: e.score, mine: !!me && e.userId === me.userId }));
  } catch { return null; }
}

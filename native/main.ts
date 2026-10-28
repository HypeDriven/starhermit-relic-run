// Relic Run on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (src/rules.js), the session
// (src/session.js) and the content (src/content.js) are the browser build's,
// unchanged; this module is what src/main.js did around them — the game flow
// (title → modes → stage, lesson, difficulty, challenge or today's Daily →
// 3-2-1 countdown → run ⇄ pause → results), input (left, right, jump and
// slide from keys, pads, the tray and the rail buttons, swipes and taps on the
// course; undo in Practice, hints, the camera reset), the challenge move
// limit, invalid-move toasts, sounds per rules event and the barrier shake,
// progression and achievements, posting a finished Journey, Daily or
// Challenge run to the high-score board, the Friends board, the gliding
// backdrop behind the menus, and the lifecycle (a hidden window pauses the
// run, as visibilitychange did, and resuming says what happened while away).
// Screens are drawn by screens.ts (starhermit:ui), the ruins by render.ts
// (starhermit:scene).
//
// Time is the runtime's fixed steps at 60 Hz: a rules tick (30 a second,
// TICKS_PER_SECOND) every second step, or every third with timing assistance
// (the old 1.5× tick length), so pauses, a hidden window and slow frames never
// cost time and play scripts replay exactly. The countdown counts the same
// steps (48 a number, its 0.8 s). A command applies at the start of the next
// step, before that step's tick, as the browser build applied it between
// ticks. The runner is drawn between ticks by the frame's interpolation.
import "./i18n.ts";
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onTouch, primaryPointer, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import { Content, Progress, Rules, Session, type Action, type Breakdown, type Challenge, type Daily, type GenOpts, type Lesson, type Snapshot, type Stage, type Terminal } from "./game.ts";
import * as audio from "./audio.ts";
import { N, S, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyContrast, initStyles } from "./style.ts";

export type Screen = "title" | "mode" | "journey" | "learn" | "practice" | "challenge" | "daily" | "pause" | "results" | "help" | "settings" | "friends" | "profile";
export type Machine = "title" | "countdown" | "active" | "paused" | "results";
export type Mode = "journey" | "learn" | "daily" | "practice" | "challenge";
export interface RunConfig {
  mode: Mode; seed: number; genOpts: Partial<GenOpts>; theme: string; ranked: boolean;
  label: () => string; objective: () => string;
  stage?: Stage; lesson?: Lesson; challenge?: Challenge; difficulty?: string; daily?: Daily;
}
export interface Results {
  headline: () => string;
  breakdown: Breakdown;
  progress: (() => string) | null;
  achievements: string[];
  canNext: boolean;
}

export const app = {
  /** The screen shown (null: the run's HUD). */
  screen: "title" as Screen | null,
  machine: "title" as Machine,
  /** Where Help and Settings go back to (backTarget). */
  back: "title" as Screen,
  /** Frame the screen opened on (the press that opened it must not also act on it). */
  openedFrame: 0,
  focusNext: null as string | null,
  run: null as RunConfig | null,
  sess: null as ReturnType<typeof Session.newSession> | null,
  countdown: 0,
  daily: null as Daily | null,
  results: null as Results | null,
  lb: null as platform.Posted | "posting" | null,
  board: null as platform.BoardRow[] | "none" | "loading" | null,
  accountNote: null as (() => string) | null,
  awaySummary: null as (() => string) | null,
  toast: null as { text: () => string; invalid: boolean; until: number } | null,
  moveCount: 0,
  /** Fixed steps into the current tick (0 … stepsPerTick - 1), for interpolation. */
  sub: 0,
};
const queued: Action[] = [];
let countdownSteps = 0;
let undoRing: Snapshot[] = [];
let hiddenSnapshot: Snapshot | null = null;
let hiddenAt = 0;

// ------------------------------------------------------------------ helpers
let lastAnnouncement = "";
/** The live regions (ui.announce); repeated text is skipped. */
export function announce(text: string, assertive = false): void {
  if (!text || text === lastAnnouncement) return;
  lastAnnouncement = text;
  try { ui.announce(text.slice(0, 500), { politeness: assertive ? "assertive" : "polite" }); } catch { /* too many this frame */ }
}
export function click(): void { audio.event("click"); }
/** ui.toast: 2.6 s at the bottom of the stage (invalid ones in the danger colour, also announced). */
export function toast(text: () => string, invalid = false): void {
  app.toast = { text, invalid, until: frame().time + 2.6 };
  if (invalid) announce(text(), true);
}
/** Pure-touch devices (a phone reports no pointer before its first touch). */
export function touchOnly(): boolean {
  const pp = primaryPointer();
  if (pp !== "none") return pp === "coarse";
  const f = frame(), sc = ui.preferences().scale;
  const w = f.width / sc, h = f.height / sc;
  return (w <= 700 && h >= w) || (w > h && h <= 500);
}
function utcDay(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
/** The Daily's UTC day by the platform's clock (the device's when offline). */
export function today(): string { return utcDay(platform.nowMs()); }
export function progress(): ReturnType<typeof platform.progress> { return platform.progress(); }
function persist(): void { platform.saveNow(); }

// ------------------------------------------------------------------ navigation
export function show(screen: Screen | null, focus: string | null = null): void {
  app.screen = screen;
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  ui.setFocus(null);
}
const FIRST: Partial<Record<Screen, string>> = {
  title: "btn-play", mode: "mode-journey", journey: "stage-1", learn: "lesson-1", practice: "practice-easy", challenge: "challenge-1",
  daily: "btn-daily-start", pause: "btn-resume", results: "btn-retry", help: "btn-back", settings: "set-leftHanded", friends: "btn-back", profile: "btn-back",
};
/** A screen, focusing its first control (none on touch devices: a later Enter must not press it; screens.ts decides when it draws). */
export function open(screen: Screen): void {
  show(screen, FIRST[screen] ?? null);
}
/** Help / Settings from the title or the pause screen (backTarget). */
export function openOverlay(screen: "help" | "settings", from: "title" | "pause"): void {
  click();
  app.back = from;
  open(screen);
}
export function overlayBack(): void { click(); open(app.back === "pause" && app.sess ? "pause" : "title"); }

// ------------------------------------------------------------------ run configurations
export function stageRun(st: Stage): RunConfig {
  return {
    mode: "journey", stage: st, seed: st.seed, genOpts: st.genOpts, theme: st.theme, ranked: true,
    label: () => T("Journey: {name}", { name: T(st.name) }),
    objective: () => (st.goals.fragments ? T("Reach the end and collect {n} fragments.", { n: st.goals.fragments }) : T("Reach the end.")) +
      (st.tutorial ? " " + T("New mechanic: {mechanic}.", { mechanic: T(st.tutorial) }) : ""),
  };
}
export function lessonRun(l: Lesson): RunConfig {
  return { mode: "learn", lesson: l, seed: l.seed, genOpts: l.genOpts, theme: "emerald-overgrowth", ranked: false, label: () => T("Lesson: {name}", { name: T(l.name) }), objective: () => T(l.goalText) };
}
export function practiceRun(diff: string): RunConfig {
  const d = Content.PRACTICE_DIFFICULTIES[diff]!;
  const seed = (Date.now() % 0x7fffffff) >>> 0;
  return {
    mode: "practice", difficulty: diff, seed, genOpts: d.genOpts, theme: "moss-cistern", ranked: false,
    label: () => T("Practice ({level})", { level: T(d.label) }), objective: () => T("Reach the end. U undoes a few seconds."),
  };
}
export function challengeRun(c: Challenge): RunConfig {
  return { mode: "challenge", challenge: c, seed: c.seed, genOpts: c.genOpts, theme: c.theme, ranked: true, label: () => T("Challenge: {name}", { name: T(c.name) }), objective: () => T(c.description) };
}
function dailyRun(d: Daily): RunConfig {
  return {
    mode: "daily", daily: d, seed: d.seed, genOpts: d.genOpts, theme: d.theme, ranked: true,
    label: () => T("Daily {date}", { date: d.dateKey }), objective: () => T("Finish the daily course. One shared seed for everyone today."),
  };
}
/** openDaily: today's course (one seed per UTC day). */
export function openDaily(): void {
  click();
  app.daily = Content.dailyContent(today());
  open("daily");
}
export function startDaily(): void { if (app.daily) { click(); startRun(dailyRun(app.daily)); } }
export async function openFriends(): Promise<void> {
  click();
  app.board = platform.signedIn() ? "loading" : null;
  open("friends");
  if (platform.signedIn()) app.board = (await platform.boardTop(20)) ?? "none";
}

/** Progress lines (left rail). */
export function idleProgressText(): string {
  const p = progress();
  const done = Object.values(p.journey.completed).filter((r) => r.finished).length;
  return T("{done} of {total} stages finished · {runs} runs · {fragments} fragments.", { done, total: Content.STAGES.length, runs: p.totals.runs, fragments: p.totals.fragments });
}
const CONSTRAINT_NAMES: Record<string, string> = { "move-limit": N("move limit"), "speed-target": N("speed target") };
export function runProgressText(cfg: RunConfig): string {
  const p = progress();
  if (cfg.mode === "journey") return T("Stage {n} of {total} · unlocked through stage {unlocked}.", { n: cfg.stage!.index + 1, total: Content.STAGES.length, unlocked: p.journey.unlocked });
  if (cfg.mode === "learn") return T("Lesson {n} of {total}.", { n: Content.LESSONS.indexOf(cfg.lesson!) + 1, total: Content.LESSONS.length });
  if (cfg.mode === "daily") return T("Daily {date} · ranked.", { date: cfg.daily!.dateKey });
  if (cfg.mode === "practice") return T("Practice · unranked · press U to undo.");
  const type = cfg.challenge!.constraint.type;
  return T("Challenge · {type}.", { type: T(CONSTRAINT_NAMES[type] ?? type) });
}

// ------------------------------------------------------------------ the run
function buildScene(seed: number, genOpts: Partial<GenOpts>, themeId: string): void {
  const theme = Content.THEMES.find((t) => t.id === themeId) ?? Content.THEMES[0]!;
  render.buildCourse(Rules.createState(seed, genOpts).course.cells, theme, (seed ^ 0xdec0) >>> 0);
}

/** main.js startRun: a fresh session, the course, the countdown. */
export function startRun(cfg: RunConfig): void {
  app.run = cfg;
  app.moveCount = 0;
  undoRing = [];
  queued.length = 0;
  app.sess = Session.startSession(Session.newSession(cfg.seed, cfg.genOpts));
  app.sub = 0;
  app.results = null;
  app.lb = null;
  app.awaySummary = null;
  hiddenSnapshot = null;
  hiddenAt = 0;
  buildScene(cfg.seed, cfg.genOpts, cfg.theme);
  show(null);
  announce(T("{label}. {objective}", { label: cfg.label(), objective: cfg.objective() }));
  if (cfg.lesson) toast(() => T(cfg.lesson!.intro) + " " + T(cfg.lesson!.prompt));
  app.countdown = 3;
  countdownSteps = 0;
  app.machine = "countdown";
  audio.event("countdown");
  audio.setRunning(true);
}
export function retry(): void { if (app.run) { click(); startRun(app.run.mode === "practice" ? practiceRun(app.run.difficulty!) : app.run); } }

export function pauseRun(): void {
  if (app.machine !== "active") return;
  app.machine = "paused";
  hiddenSnapshot = Session.snapshot(app.sess!);
  app.awaySummary = null;
  open("pause");
  announce(T("Paused."));
  click();
}
export function resumeRun(): void {
  if (app.machine !== "paused") return;
  // while-you-were-away summary
  if (hiddenSnapshot && hiddenAt) {
    const awaySec = Math.round((Date.now() - hiddenAt) / 1000);
    const sum = Session.awaySummary(Session.restore(hiddenSnapshot).state, app.sess!.state);
    const delta = `${sum.scoreDelta >= 0 ? "+" : ""}${sum.scoreDelta}`;
    app.awaySummary = awaySec >= 5 ? () => T("While you were away ({n}s): the run was paused - nothing moved. Score unchanged ({delta}).", { n: awaySec, delta }) : null;
    if (app.awaySummary) announce(app.awaySummary());
  }
  hiddenAt = 0;
  app.machine = "active";
  queued.length = 0;
  show(null);
}
export function leaveRun(): void {
  click();
  app.machine = "title";
  app.sess = null;
  app.run = null;
  audio.setRunning(false);
  open("title");
}
export function backToTitle(): void { leaveRun(); }

export function nextRecommended(): void {
  click();
  const run = app.run;
  if (run && run.mode === "journey") {
    const idx = run.stage!.index;
    const next = Content.STAGES[idx + 1];
    if (next && idx + 2 <= progress().journey.unlocked) { startRun(stageRun(next)); return; }
  }
  if (run && run.mode === "learn") {
    const next = Content.LESSONS[Content.LESSONS.indexOf(run.lesson!) + 1];
    if (next) { startRun(lessonRun(next)); return; }
  }
  app.machine = "title";
  app.sess = null;
  audio.setRunning(false);
  open("mode");
}

// ------------------------------------------------------------------ commands
/** A command from the player, applied at the start of the next fixed step (main.js command()). */
export function command(action: Action): void {
  if (app.machine !== "active" || !app.sess) return;
  queued.push(action);
}
function applyCommand(action: Action): void {
  const sess = app.sess!, run = app.run!;
  // challenge constraint: move limit
  if (run.challenge && run.challenge.constraint.type === "move-limit" && app.moveCount >= run.challenge.constraint.limit) {
    const limit = run.challenge.constraint.limit;
    toast(() => T("Move limit reached ({n}). No inputs left.", { n: limit }), true);
    audio.event("invalid");
    return;
  }
  const res = Session.applySessionCommand(sess, { id: sess.nextCmdId, action });
  if (!res.ok) {
    if (!res.deduped) {
      const reason = res.reason ?? "";
      toast(() => invalidText(reason, action), true);
      audio.event("invalid");
    }
    return;
  }
  app.moveCount++;
  audio.event(res.effect === "route" ? "branch" : action);
  vibrate(12);
}
function invalidText(reason: string, action: Action): string {
  switch (reason) {
    case "lane-edge": return T("Already at the edge lane.");
    case "airborne": return T("Already in the air.");
    case "sliding": return T("Already sliding.");
    case "branch-choice-required": return T("A fork is ahead - choose left (safe) or right (risk).");
    case "mechanic-disabled": return T("That move is not part of this stage.");
    case "session-over": return T("The run is over.");
    default: return T("Cannot {action} here ({reason}).", { action: T(action), reason });
  }
}
const LANE_NAMES = [N("left"), N("center"), N("right")];
export function showHint(): void {
  if (!app.sess) return;
  const s = app.sess.state;
  const ci = Math.floor(s.distUnits / Rules.UNITS_PER_CELL);
  const cells = s.course.cells;
  if (Rules.activeBranch(s) >= 0) { toast(() => T("Fork ahead: LEFT for the safe route, RIGHT for double-fragment risk route.")); return; }
  for (let i = ci + 1; i <= Math.min(ci + 5, cells.length - 1); i++) {
    const c = cells[i]!, n = i - ci;
    if (c.gap) { toast(() => T("Gap in {n} - jump (UP) just before it.", { n })); return; }
    if (c.low) { toast(() => T("Low barrier in {n} - slide (DOWN) under it.", { n })); return; }
    if (c.relicLane >= 0) { const lane = LANE_NAMES[c.relicLane]!; toast(() => T("Fragment in {n}, {lane} lane.", { n, lane: T(lane) })); return; }
  }
  toast(() => T("Path is clear. Keep running."));
}
function practiceUndo(): void {
  if (!app.run || app.run.mode !== "practice" || app.machine !== "active") { toast(() => T("Undo is only available in Practice."), true); return; }
  const snap = undoRing.pop();
  if (!snap) { toast(() => T("Nothing to undo yet."), true); return; }
  app.sess = Session.restore(snap);
  queued.length = 0;
  toast(() => T("Undid a few seconds."));
  click();
}
function recenterCamera(): void {
  if (!app.sess) return;
  render.recenter(app.sess.state);
  toast(() => T("Camera recentered."));
}

/** The "Ahead" text model of upcoming hazards (ui.updateMirror). */
export function mirrorText(): string {
  if (!app.sess) return "";
  const s = app.sess.state;
  const ci = Math.floor(s.distUnits / Rules.UNITS_PER_CELL);
  const cells = s.course.cells;
  const parts: string[] = [];
  for (let i = ci + 1; i <= Math.min(ci + 8, cells.length - 1); i++) {
    const c = cells[i]!, d = i - ci;
    // an already-chosen fork is no longer a decision: don't keep prompting
    if (c.branch) { if (i >= s.branchResolved) parts.push(T("fork in {n} (left=safe, right=risk)", { n: d })); }
    else if (c.gap) parts.push(T("gap in {n}", { n: d }));
    else if (c.low) parts.push(T("barrier in {n}", { n: d }));
    else if (c.relicLane >= 0) parts.push(T("fragment in {n} ({lane} lane)", { n: d, lane: T(LANE_NAMES[c.relicLane]!) }));
  }
  const route = s.route === "risk" ? T("On the risk route (x2 fragments). ") : "";
  return parts.length ? route + T("Ahead: {list}", { list: parts.join("; ") }) : route + T("Path clear ahead.");
}

// ------------------------------------------------------------------ the end of a run
function onTerminal(terminal: Terminal): void {
  app.machine = "results";
  audio.setRunning(false);
  audio.event(terminal === "finished" ? "finish" : terminal === "fell" ? "fell" : "crash");
  const sess = app.sess!, run = app.run!, s = sess.state;
  const bd = Session.scoreOf(sess);
  const p = progress();
  const earned: string[] = [];
  const iso = new Date(platform.nowMs()).toISOString();
  const grant = (id: string): void => { if (Progress.unlock(p, id, iso)) earned.push(id); };
  p.totals.runs++;
  p.totals.fragments += s.fragments;
  if (terminal === "finished") grant("first-finish");
  if (p.totals.fragments >= 1000) grant("fragments-1000");

  let prog: (() => string) | null = null;
  let canNext = false;
  if (run.mode === "journey") {
    const st = run.stage!;
    const prev = p.journey.completed[st.id];
    p.journey.completed[st.id] = { score: Math.max(bd.total, prev ? prev.score : 0), finished: terminal === "finished" || !!(prev && prev.finished) };
    if (terminal === "finished" && st.index + 2 > p.journey.unlocked) p.journey.unlocked = Math.min(Content.STAGES.length, st.index + 2);
    if (terminal === "finished" && st.difficulty === "hard") grant("hard-milestone");
    canNext = terminal === "finished" && st.index + 1 < Content.STAGES.length;
    const vars = { n: st.index + 1, total: Content.STAGES.length, unlocked: p.journey.unlocked };
    prog = () => T("Stage {n} of {total}. Unlocked through stage {unlocked}.", vars);
  } else if (run.mode === "learn") {
    if (terminal === "finished") {
      p.tutorials[run.lesson!.id] = true;
      if (Content.LESSONS.every((l) => p.tutorials[l.id])) grant("mechanic-mastery");
      canNext = Content.LESSONS.indexOf(run.lesson!) + 1 < Content.LESSONS.length;
      prog = () => T("Lesson complete.");
    }
  } else if (run.mode === "daily") {
    const date = run.daily!.dateKey, key = "daily-" + date;
    p.totals.dailies[date] = Math.max(bd.total, p.totals.dailies[date] ?? 0);
    if (Object.keys(p.totals.dailies).length >= 3) grant("daily-streak-3");
    const best = p.bestScores[key];
    if (!best || bd.total > best.total) {
      p.bestScores[key] = { total: bd.total, breakdown: bd, date };
      const was = best?.total;
      prog = was !== undefined ? () => T("New daily best (was {n}).", { n: was }) : () => T("First daily score recorded.");
    }
  } else if (run.mode === "practice") {
    prog = () => T("Practice run - unranked.");
  } else {
    prog = terminal === "finished" ? () => T("Constraint held. Well done.") : () => T("The course won this time.");
  }
  persist();

  const headlineKey = ({ finished: N("You reached the relic gate!"), crashed: N("The vines brought you down."), fell: N("You fell into the ruins."), "time-up": N("The light faded - time up.") } as Record<string, string>)[terminal] ?? N("Run over");
  app.results = { headline: () => T("{headline} - {n} pts", { headline: T(headlineKey), n: bd.total }), breakdown: bd, progress: prog, achievements: earned, canNext };
  open("results");
  announce(T("{headline}. Final score {n}.", { headline: T(headlineKey), n: bd.total }), true);
  // signed in: Journey, Daily and Challenge runs post their total; the results show the rank
  if (platform.signedIn() && (run.mode === "journey" || run.mode === "daily" || run.mode === "challenge")) {
    app.lb = "posting";
    const mine = app.sess;
    void platform.postScore(Math.max(0, bd.total)).then((r) => { if (app.sess === mine) app.lb = r; });
  }
}
export function leaderboardLine(): string | null {
  const r = app.lb;
  if (!r) return null;
  if (r === "posting") return S("lbPosting");
  return !r.posted ? S("lbNotPosted") : r.rank ? S("lbRank", { rank: r.rank }) : S("lbPosted");
}
export function resetLessons(): void {
  click();
  progress().tutorials = {};
  persist();
  toast(() => T("Lessons reset. Tutorials will play again."));
}

// ------------------------------------------------------------------ account
export function copyInvite(): void {
  click();
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); app.accountNote = () => S("inviteCopied"); }
  catch { app.accountNote = () => S("inviteLink", { url: link }); }
}
export function signIn(): void { click(); void requestSignIn().catch(() => undefined); }

// ------------------------------------------------------------------ input
/** Rectangles (window pixels) of the HUD, tray and rails, set by screens.ts each frame: presses there are not course gestures. */
export const uiRects: { x: number; y: number; width: number; height: number }[] = [];
/** The stage (window pixels): the gesture surface. */
export const stageRect = { x: 0, y: 0, width: 0, height: 0 };
interface Press { id: number; x: number; y: number; t: number }
const downs = new Map<number, Press>();
const gestures: { dx: number; dy: number; dt: number; x: number; y: number }[] = [];
let lastTouch = -1e9;
onTouch((e) => {
  lastTouch = frame().time;
  if (e.control) return;
  if (e.phase === "start") downs.set(e.id, { id: e.id, x: e.x, y: e.y, t: frame().time });
  else if (e.phase === "end") {
    const d = downs.get(e.id);
    downs.delete(e.id);
    if (d) gestures.push({ dx: e.x - d.x, dy: e.y - d.y, dt: frame().time - d.t, x: d.x, y: d.y });
  } else if (e.phase === "cancel") downs.delete(e.id);
});
onPointerButton((e) => {
  if (e.button !== 0 || frame().time - lastTouch < 0.6) return;
  if (e.pressed) downs.set(-1, { id: -1, x: e.x, y: e.y, t: frame().time });
  else {
    const d = downs.get(-1);
    downs.delete(-1);
    if (d) gestures.push({ dx: e.x - d.x, dy: e.y - d.y, dt: frame().time - d.t, x: d.x, y: d.y });
  }
});
/** bindPointer: swipes on the course (tap = jump), decided once the frame's UI is built. */
function gestureInput(): void {
  const live = app.machine === "active" && app.screen === null;
  const px = ui.preferences().scale;
  for (const g of gestures.splice(0)) {
    if (!live) continue;
    const inside = (r: { x: number; y: number; width: number; height: number }): boolean => g.x >= r.x && g.y >= r.y && g.x <= r.x + r.width && g.y <= r.y + r.height;
    if (!inside(stageRect) || uiRects.some(inside)) continue;
    ui.setFocus(null);
    const dist = Math.hypot(g.dx, g.dy) / px;
    if (dist < 14 && g.dt < 0.4) { command("jump"); continue; }
    if (Math.abs(g.dx) > Math.abs(g.dy)) command(g.dx > 0 ? "right" : "left");
    else command(g.dy > 0 ? "slide" : "jump");
  }
}

const RUN_ACTIONS = new Set(["left", "right", "jump", "slide"]);
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  if (RUN_ACTIONS.has(e.action)) {
    if (app.machine === "active" && app.screen === null) {
      // game keys must not also walk or activate the UI focus over the HUD
      ui.setFocus(null);
      command(e.action as Action);
    }
    return;
  }
  if (frame().frame === app.openedFrame) return;
  switch (e.action) {
    case "pause":
      if (app.machine === "active") pauseRun();
      else if (app.machine === "paused" && app.screen === "pause") { click(); resumeRun(); }
      else if (app.screen === "help" || app.screen === "settings") overlayBack();
      else if (app.screen === "results") backToTitle();
      else if (app.screen && app.screen !== "title" && app.screen !== "pause") { click(); open("title"); }
      break;
    case "undo": if (app.sess) practiceUndo(); break;
    case "hint": if (app.machine === "active") showHint(); break;
    case "camera": if (app.machine === "active") recenterCamera(); break;
  }
});
export function hintPressed(): void { ui.setFocus(null); showHint(); }

const pendingActs: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built (state changes mid-build would break later widgets). */
export function later(fn: () => void): void { pendingActs.push(fn); }

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
function applyOptions(): void { render.setColorblind(platform.options.colorblind); }

onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  render.setReducedMotion(preferences().reducedMotion);
  applyOptions();
  applyLook();
  // idle backdrop scene so the title isn't a void
  const idle = Content.STAGES[0]!;
  buildScene(idle.seed, idle.genOpts, idle.theme);
  open("title");
  announce(T("Relic Run loaded. Press Play to choose a mode."));
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onOptionsChange(applyOptions);
platform.onPlayer((on) => { if (!on) app.accountNote = () => S("signedOut"); });
onSessionEnded(() => { app.accountNote = () => S("signedOut"); }); // keep playing locally
let hidden = false;
onSuspend(() => {
  hidden = true;
  platform.flush();
  if (app.machine === "active") { pauseRun(); hiddenAt = Date.now(); }
  audio.setSuspended(true);
});
onResume(() => {
  hidden = false;
  audio.setSuspended(false);
});

/** Fixed steps a rules tick takes: 2 (30 ticks a second), 3 with timing assistance. */
const stepsPerTick = (): number => (platform.options.timingAssist ? 3 : 2);
onFixedUpdate(() => {
  if (hidden) return;
  if (app.machine === "countdown") {
    if (++countdownSteps >= 48) {
      countdownSteps = 0;
      app.countdown -= 1;
      if (app.countdown <= 0) {
        app.machine = "active";
        app.sub = 0;
        audio.event("go");
        announce(T("Go!"), true);
      } else audio.event("countdown");
    }
    return;
  }
  if (app.machine !== "active" || !app.sess) return;
  for (const a of queued.splice(0)) applyCommand(a);
  if (++app.sub < stepsPerTick()) return;
  app.sub = 0;
  const sess = app.sess, before = sess.state;
  const prevFrag = before.fragments, prevBonus = before.setBonuses, prevHearts = before.hearts;
  Session.advance(sess, 1);
  const s = sess.state;
  if (app.run!.mode === "practice" && s.tick % 60 === 0 && !s.terminal) {
    undoRing.push(Session.snapshot(sess));
    if (undoRing.length > 6) undoRing.shift();
  }
  if (s.fragments > prevFrag) {
    audio.event("collect");
    if (s.setBonuses > prevBonus) audio.event("setbonus");
  }
  if (s.hearts < prevHearts) {
    audio.event("crash");
    render.addShake(0.3);
    announce(T("Hit a barrier. {n} hearts left.", { n: s.hearts }), true);
  }
  if (s.terminal) onTerminal(s.terminal);
});

let frameDt = 0;
onUpdate((dt) => {
  frameDt = Math.min(0.1, dt);
  applyLook();
  applyContrast(ui.preferences().highContrast);
  audio.update();
  if (app.toast && frame().time > app.toast.until) app.toast = null;
});
onRender(() => {
  uiRects.length = 0;
  drawScreens();
  for (const fn of pendingActs.splice(0)) fn();
  gestureInput();
  if (app.sess && app.machine !== "title") {
    const frac = app.machine === "active" ? Math.min(1, app.sub / stepsPerTick()) : 0;
    render.drawRun(app.sess.state, frac, frameDt);
  } else render.drawIdle(frameDt);
});

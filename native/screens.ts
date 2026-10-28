// The browser build's DOM shell (index.html + src/ui.js) as starhermit:ui,
// built every frame over the ruins: the status bar (Relic Run, the player,
// the mode, sync and network state, the UTC clock); on windows 1024 px and
// wider the two rails (Objective, Progress, Next up; Actions, Status) with
// the 3D stage between them; the menu screens over the stage behind their
// wash (title, modes, Journey list, lessons, Practice, Challenges, Daily,
// pause, results, help, settings, friends & scores, profile); and in a run
// the HUD (objective, score · fragments · hearts · speed, Pause), the tray
// (◀ Left, Jump ▲, Slide ▼, Right ▶; mirrored for the left-handed), the
// "Ahead" hazard mirror, the countdown and the toasts. The old media queries
// are layouts picked by the stage's logical size: rails from 1024 px, the
// portrait phone (≤ 700 px wide: stats and Pause above a full-width
// objective, the tray buttons sharing the width) and short landscape (≤ 500
// px tall: smaller status text, the tray at the end).
import { frame, openMenu } from "starhermit:engine";
import { bindings } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { Content, Progress, Rules, Session, type Action } from "./game.ts";
import { N, S, T } from "./i18n.ts";
import * as platform from "./platform.ts";
import * as render from "./render.ts";
import {
  app, backToTitle, challengeRun, click, command, copyInvite, hintPressed, idleProgressText, later, leaderboardLine, lessonRun, leaveRun,
  mirrorText, nextRecommended, open, openDaily, openFriends, openOverlay, overlayBack, pauseRun, practiceRun, progress, resetLessons,
  resumeRun, retry, runProgressText, touchOnly, signIn, stageRect, stageRun, startDaily, startRun, today, uiRects,
} from "./main.ts";

// ------------------------------------------------------------------ layout
interface Layout {
  lw: number; lh: number; sc: number; ox: number; oy: number;
  wide: boolean; portrait: boolean; short: boolean;
  /** The stage (logical, from the safe area's corner). */
  sx: number; sy: number; sw: number; sh: number;
}
const lastSize = new Map<string, number>();
const RAIL = 250;
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  const wide = lw >= 1024;
  const sbH = lastSize.get("statusbar") ?? 33;
  const sx = wide ? RAIL : 0;
  return {
    lw, lh, sc, ox: sa.left, oy: sa.top, wide, portrait: lw <= 700 && lh > lw, short: lh <= 500 && lw > lh,
    sx, sy: sbH, sw: lw - (wide ? 2 * RAIL : 0), sh: Math.max(1, lh - sbH),
  };
}
const fresh = (): boolean => frame().frame !== app.openedFrame;
function textWidth(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style }).width / ui.preferences().scale;
}
interface Btn { id: string; text: string; style?: string; act: () => void; disabled?: boolean; name?: string }
/** A button `width` wide (null: its text's); a label too long for it wraps inside. */
function button(b: Btn, width: number | null = null): void {
  const style = b.style ?? "btn-secondary";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  const inline: ui.Style = width != null ? { width } : {};
  if (width != null && textWidth(b.text, style, "button") > width) {
    const inner = Math.max(20, width - 40);
    opts.content = () => { ui.style({ text: { align: "center" } }).paragraph(b.text, inner); };
  } else if (b.name) opts.content = () => { ui.label(b.text); };
  if (ui.style(style, inline).id(b.id).button(b.name ?? b.text, opts) && fresh() && !b.disabled) later(b.act);
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "muted", id?: string, align: "start" | "center" = "start"): void {
  if (!text) return;
  let u = ui.style(cls, { text: { align } });
  if (id) u = u.id(id);
  if (textWidth(text, cls) <= width) u.label(text);
  else u.paragraph(text, width);
}
function heading(cls: string, text: string, width: number, align: "start" | "center" = "start"): void {
  if (textWidth(text, cls, "heading") <= width) ui.style(cls).heading(text);
  else ui.style(cls, { text: { align } }).paragraph(text, width);
}
const gap = (h: number): void => { ui.widget("", { role: "none", size: { width: 1, height: h } }); };
/** Window rectangle of a logical stage-relative box. */
function win(L: Layout, x: number, y: number, w: number, h: number): { x: number; y: number; width: number; height: number } {
  return { x: L.ox + x * L.sc, y: L.oy + y * L.sc, width: w * L.sc, height: h * L.sc };
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const f = frame();
  // the stage: the old canvas between the status bar and the rails
  const st = win(L, L.sx, L.sy, L.sw, L.sh);
  Object.assign(stageRect, st);
  render.setView(f.width, f.height, st.x, st.y, st.width, st.height);
  if (L.wide) rails(L);
  statusBar(L);
  if (app.screen === null) {
    if (app.machine === "countdown" || app.machine === "active") runView(L);
  } else {
    wash(L);
    switch (app.screen) {
      case "title": page("title", L, titleScreen, 1040, false); break;
      case "mode": page("mode", L, modeScreen, 640); break;
      case "journey": page("journey", L, journeyScreen, 640); break;
      case "learn": page("learn", L, learnScreen, 640); break;
      case "practice": page("practice", L, practiceScreen, 640); break;
      case "challenge": page("challenge", L, challengeScreen, 640); break;
      case "daily": page("daily", L, dailyScreen, 640); break;
      case "pause": page("pause", L, pauseScreen, 640); break;
      case "results": page("results", L, resultsScreen, 640); break;
      case "help": page("help", L, helpScreen, 640); break;
      case "settings": page("settings", L, settingsScreen, 640); break;
      case "friends": page("friends", L, friendsScreen, 640); break;
      case "profile": page("profile", L, profileScreen, 640); break;
    }
  }
  toastView(L);
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1 && !touchOnly()) ui.setFocus(app.focusNext);
    if (age >= 10) app.focusNext = null;
  }
}

// ------------------------------------------------------------------ status bar and rails
const SYNC: Record<string, string> = { synced: N("progress synced"), saving: N("saving…"), offline: N("local progress") };
function statusBar(L: Layout): void {
  const cls = L.short ? "sb-text-small" : "sb-text";
  const name = platform.signedIn() ? platform.displayName() : "";
  const mode = app.run && app.machine !== "title" ? app.run.label() : "";
  const sync = T(SYNC[platform.syncState() ?? "offline"]!);
  const net = platform.signedIn() ? T("online") : T("offline");
  const clock = new Date(platform.nowMs()).toISOString().slice(11, 19) + " UTC";
  const left = ["Relic Run", name, mode].filter(Boolean);
  const right = [sync, net, clock];
  const widths = (list: string[]): number => list.reduce((a, t, i) => a + textWidth(t, i === 0 && list === left ? "sb-title" : cls) + 16, 0);
  const oneLine = widths(left) + widths(right) + 28 <= L.lw;
  const r = ui.place("statusbar", { anchor: "top-start", x: 0, y: 0 }, () => {
    const leftRow = (): void => {
      ui.style("sb-title").id("sb-title").label("Relic Run");
      if (name) ui.style(cls).id("sb-name").label(name);
      if (mode) ui.style(cls).id("sb-mode").label(mode);
    };
    const rightRow = (): void => {
      ui.style(cls).id("sb-sync").label(sync);
      ui.style(cls).id("sb-net").label(net);
      ui.style(cls).id("sb-clock").label(clock);
    };
    if (oneLine) {
      ui.row("sb-row", () => { leftRow(); ui.spacer(); rightRow(); }, { width: L.lw, spacing: 16, align: "center", style: "statusbar", padding: { top: L.short ? 2 : 6, bottom: L.short ? 2 : 6, start: 14, end: 14 } });
    } else {
      ui.column("sb-col", () => {
        ui.row("sb-r1", leftRow, { spacing: 16, align: "center" });
        ui.row("sb-r2", rightRow, { spacing: 16, align: "center" });
      }, { width: L.lw, spacing: 4, style: "statusbar", padding: { top: L.short ? 2 : 6, bottom: L.short ? 2 : 6, start: 14, end: 14 } });
    }
  });
  lastSize.set("statusbar", r.height / L.sc);
}

function rails(L: Layout): void {
  const inner = RAIL - 28;
  const h = L.lh - L.sy;
  const sess = app.sess && app.machine !== "title" ? app.sess : null;
  const objective = app.run && sess ? app.run.objective() : T("Choose a mode to begin.");
  const prog = app.machine === "results" && app.results?.progress ? app.results.progress() : app.run && sess ? runProgressText(app.run) : idleProgressText();
  const left = ui.place("rail-left", { anchor: "top-start", x: 0, y: L.sy }, () => {
    ui.column("rail-left-col", () => {
      heading("rail-heading", T("Objective"), inner);
      para(objective, inner, "rail-text", "rail-objective");
      gap(6);
      heading("rail-heading", T("Progress"), inner);
      para(prog, inner, "rail-text", "rail-progress");
      gap(6);
      heading("rail-heading", T("Next up"), inner);
      if (sess) para(mirrorText(), inner, "rail-text", "rail-mirror");
    }, { width: RAIL, height: h, spacing: 6, style: "rail-left" });
  });
  uiRects.push(left);
  const live = app.machine === "active" && app.screen === null;
  const right = ui.place("rail-right", { anchor: "top-end", x: 0, y: L.sy }, () => {
    ui.column("rail-right-col", () => {
      heading("rail-heading", T("Actions"), inner);
      const acts: [string, string, () => void][] = [
        ["rail-left-btn", T("Turn / Left"), () => command("left")], ["rail-right-btn", T("Turn / Right"), () => command("right")],
        ["rail-jump", T("Jump"), () => command("jump")], ["rail-slide", T("Slide"), () => command("slide")],
        ["btn-hint", T("Hint (H)"), hintPressed],
      ];
      for (const [id, text, act] of acts) button({ id, text, act: () => { ui.setFocus(null); if (live || id === "btn-hint") act(); } }, inner);
      gap(4);
      heading("rail-heading", T("Status"), inner);
      if (sess) {
        const s = sess.state, bd = Session.scoreOf(sess);
        para(T("Score {score} · Fragments {fragments} · Hearts {hearts}/{max}", { score: bd.total, fragments: s.fragments, hearts: s.hearts, max: s.genOpts.hearts || Rules.MAX_HEARTS }), inner, "rail-text", "rail-status");
      }
    }, { width: RAIL, height: h, spacing: 10, style: "rail-right" });
  });
  uiRects.push(right);
}

// ------------------------------------------------------------------ menu screens
/** .screen.menu: the wash over the stage. */
function wash(L: Layout): void {
  const f = frame();
  const r = win(L, L.sx, L.sy, L.sw, L.sh);
  ui.place("wash", { anchor: "top-start", x: L.sx, y: L.sy }, () => {
    ui.widget("", { role: "none", size: { width: L.sw, height: L.sh }, draw: () => draw.box(r.x, r.y, Math.min(r.width, f.width), r.height, "menu-wash") });
  });
}
/** A menu screen over the stage: a card (or the title's bare column) centred, scrolling from its top when taller than the stage. */
function page(key: string, L: Layout, build: (w: number, L: Layout) => void, maxW: number, card = true): void {
  const padOuter = L.short ? 12 : 24;
  const outer = Math.min(maxW, L.sw * 0.94, L.sw - 2 * 8);
  const avail = Math.max(80, L.sh - 2 * (L.short ? 6 : 12));
  const h = lastSize.get(key) ?? 0;
  const scroll = h > avail;
  const pad = card ? (L.portrait ? 16 : 20) : 0;
  const inner = outer - 2 * pad - (scroll ? 14 : 0);
  const opening = frame().frame - app.openedFrame <= 6;
  const y = L.sy + (scroll ? (L.short ? 6 : 12) : Math.max(padOuter * 0, (L.sh - h) / 2));
  const x = L.sx + (L.sw - outer) / 2;
  ui.place(`page-${key}`, { anchor: "top-start", x, y }, () => {
    const body = (): void => {
      const r = ui.column(`${key}-col`, () => build(inner, L), {
        width: outer - (scroll ? 14 : 0), spacing: L.short ? 8 : 12, padding: pad, align: card ? "start" : "center", ...(card ? { style: "card" } : {}),
      });
      lastSize.set(key, r.height / L.sc);
    };
    if (scroll) ui.scrollArea(`${key}-scroll`, { width: outer, height: avail }, body, opening ? { scrollTo: { top: 0 } } : undefined);
    else body();
  });
}
function backButton(act: () => void = () => { click(); open("title"); }): void {
  ui.row("back-row", () => { button({ id: "btn-back", text: T("Back"), act }); }, { spacing: 10 });
}
/** .list .item: a name and a muted line beside its badge and action button. */
function item(key: string, w: number, name: string, sub: string, right: { badge?: { text: string; done: boolean }; btn?: Btn } = {}): void {
  const bw = right.btn ? textWidth(right.btn.text, right.btn.style ?? "btn", "button") + 4 : 0;
  const badgeW = right.badge ? textWidth(right.badge.text, "badge") + 18 : 0;
  const rw = bw + badgeW + (bw && badgeW ? 10 : 0);
  const iw = w - 30 - (rw ? rw + 10 : 0);
  ui.row(key, () => {
    ui.column(`${key}-info`, () => {
      para(name, iw, "item-name");
      para(sub, iw, "item-sub");
    }, { spacing: 2, width: iw });
    ui.spacer();
    if (right.badge) ui.style(right.badge.done ? "badge-done" : "badge").label(right.badge.text);
    if (right.btn) button(right.btn);
  }, { style: "item", width: w, spacing: 10, align: "center" });
}

function titleScreen(cw: number): void {
  const w = Math.min(340, cw);
  ui.style("h1").id("title-heading").heading("Relic Run");
  para(T("Run the overgrown ruins. Turn at forks, leap the gaps, slide the vines, gather the relics."), cw, "muted", "tagline", "center");
  gap(4);
  const list: Btn[] = [
    { id: "btn-play", text: T("Play"), style: "btn-play", act: () => { click(); open("mode"); } },
    { id: "btn-daily", text: T("Daily Challenge"), act: openDaily },
    { id: "btn-journey", text: T("Journey"), act: () => { click(); open("journey"); } },
    { id: "btn-learn", text: T("Learn"), act: () => { click(); open("learn"); } },
    { id: "btn-profile", text: T("Profile"), act: () => { click(); open("profile"); } },
  ];
  ui.column("menu-buttons", () => {
    for (const b of list) button(b, w);
    ui.row("menu-row", () => {
      button({ id: "btn-help", text: T("Help"), act: () => openOverlay("help", "title") });
      button({ id: "btn-settings", text: T("Settings"), act: () => openOverlay("settings", "title") });
      button({ id: "btn-friends", text: T("Friends"), act: () => void openFriends() });
    }, { spacing: 10, justify: "center", width: w });
    if (platform.inviteLink()) button({ id: "btn-invite", text: S("invite"), act: copyInvite }, w);
    if (!platform.signedIn()) button({ id: "btn-signin", text: S("signIn"), act: signIn }, w);
  }, { spacing: 10, width: w, align: "center" });
  if (app.accountNote) para(app.accountNote(), cw, "muted", "account-note", "center");
}

function modeScreen(w: number): void {
  heading("h2", T("Choose a mode"), w);
  ui.column("mode-list", () => {
    const open1 = (id: string, act: () => void): Btn => ({ id, text: T("Open"), style: "btn", act });
    item("mode-j", w, T("Journey"), T("40 authored stages · ~1-2 min each · ranked"), { btn: { ...open1("mode-journey", () => { click(); open("journey"); }), name: `${T("Open")} — ${T("Journey")}` } });
    item("mode-d", w, T("Daily Challenge"), T("One shared seed per UTC day · ranked"), { btn: { ...open1("mode-daily", openDaily), name: `${T("Open")} — ${T("Daily Challenge")}` } });
    item("mode-l", w, T("Learn"), T("Four short lessons · one mechanic at a time"), { btn: { ...open1("mode-learn", () => { click(); open("learn"); }), name: `${T("Open")} — ${T("Learn")}` } });
    item("mode-p", w, T("Practice"), T("Selectable difficulty · restart & undo · unranked"), { btn: { ...open1("mode-practice", () => { click(); open("practice"); }), name: `${T("Open")} — ${T("Practice")}` } });
    item("mode-c", w, T("Challenge"), T("Constrained variants: move limits, speed targets · ranked"), { btn: { ...open1("mode-challenge", () => { click(); open("challenge"); }), name: `${T("Open")} — ${T("Challenge")}` } });
  }, { spacing: 8, width: w });
  backButton();
}

function journeyScreen(w: number, L: Layout): void {
  heading("h2", T("Journey"), w);
  const p = progress();
  const done = Content.STAGES.filter((st) => p.journey.completed[st.id]?.finished).length;
  para(T("{done} of {total} stages finished. Finish a stage to unlock the next.", { done, total: Content.STAGES.length }), w, "muted", "journey-summary");
  const listW = w - 14;
  const list = (): void => {
    Content.STAGES.forEach((st, i) => {
      const rec = p.journey.completed[st.id];
      const theme = Content.THEMES.find((t) => t.id === st.theme);
      const sub = [T(st.difficulty), theme ? T(theme.name) : "", T("par {n}", { n: st.par.score }), st.mastery ? T("mastery") : null,
        st.tutorial ? T("introduces {mechanic}", { mechanic: T(st.tutorial) }) : null].filter((x) => x != null).join(" · ");
      const locked = i + 1 > p.journey.unlocked;
      item(`stage-${i + 1}-item`, listW, `${i + 1}. ${T(st.name)}`, sub, {
        ...(rec && rec.finished ? { badge: { text: T("done · {score}", { score: rec.score }), done: true } } : {}),
        btn: { id: `stage-${i + 1}`, text: locked ? T("Locked") : T("Run"), style: locked ? "btn-secondary" : "btn", disabled: locked, name: `${locked ? T("Locked") : T("Run")} — ${i + 1}. ${T(st.name)}`, act: () => { click(); startRun(stageRun(st)); } },
      });
    });
  };
  // #journey-list: at most 46 % of the window tall, scrolling inside
  ui.scrollArea("journey-list", { width: w, height: Math.max(150, L.lh * 0.46) }, () => ui.column("journey-col", list, { spacing: 8, width: listW }),
    frame().frame - app.openedFrame <= 6 ? { scrollTo: { top: 0 } } : undefined);
  backButton(() => { click(); open("mode"); });
}

function learnScreen(w: number): void {
  heading("h2", T("Learn the ruins"), w);
  const p = progress();
  ui.column("learn-list", () => {
    Content.LESSONS.forEach((l, i) => item(`lesson-${i + 1}-item`, w, T(l.name), T(l.intro), {
      ...(p.tutorials[l.id] ? { badge: { text: T("learned"), done: true } } : {}),
      btn: { id: `lesson-${i + 1}`, text: T("Start"), style: "btn", name: `${T("Start")} — ${T(l.name)}`, act: () => { click(); startRun(lessonRun(l)); } },
    }));
  }, { spacing: 8, width: w });
  backButton(() => { click(); open("mode"); });
}

function practiceScreen(w: number): void {
  heading("h2", T("Practice"), w);
  para(T("Unranked. Restart freely; press U to undo a few seconds."), w, "muted");
  ui.column("practice-list", () => {
    for (const [key, d] of Object.entries(Content.PRACTICE_DIFFICULTIES)) {
      item(`practice-${key}-item`, w, T(d.label), T("restart & undo allowed · unranked"), {
        btn: { id: `practice-${key}`, text: T("Run"), style: "btn", name: `${T("Run")} — ${T(d.label)}`, act: () => { click(); startRun(practiceRun(key)); } },
      });
    }
  }, { spacing: 8, width: w });
  backButton(() => { click(); open("mode"); });
}

function challengeScreen(w: number): void {
  heading("h2", T("Challenges"), w);
  ui.column("challenge-list", () => {
    Content.CHALLENGES.forEach((c, i) => item(`challenge-${i + 1}-item`, w, T(c.name), T(c.description), {
      btn: { id: `challenge-${i + 1}`, text: T("Run"), style: "btn", name: `${T("Run")} — ${T(c.name)}`, act: () => { click(); startRun(challengeRun(c)); } },
    }));
  }, { spacing: 8, width: w });
  backButton(() => { click(); open("mode"); });
}

function dailyScreen(w: number): void {
  heading("h2", T("Daily Challenge"), w);
  const d = app.daily ?? Content.dailyContent(today());
  para(T("Seed for {date} (UTC). Same course for every player today. Ranked.", { date: d.dateKey }), w, "muted", "daily-info");
  const best = progress().bestScores["daily-" + d.dateKey];
  para(best ? T("Your best today: {n} pts.", { n: best.total }) : T("No attempt recorded today."), w, "text", "daily-best");
  ui.row("daily-row", () => {
    button({ id: "btn-daily-start", text: T("Run today's seed"), style: "btn", act: startDaily });
    button({ id: "btn-back", text: T("Back"), act: () => { click(); open("mode"); } });
  }, { spacing: 10 });
}

function pauseScreen(w: number): void {
  heading("h2", T("Paused"), w);
  if (app.awaySummary) para(app.awaySummary(), w, "muted", "away-summary");
  const bw = Math.min(w, 340);
  ui.column("pause-buttons", () => {
    button({ id: "btn-resume", text: T("Resume"), style: "btn", act: () => { click(); resumeRun(); } }, bw);
    button({ id: "btn-pause-settings", text: T("Settings"), act: () => openOverlay("settings", "pause") }, bw);
    button({ id: "btn-pause-help", text: T("Help"), act: () => openOverlay("help", "pause") }, bw);
    button({ id: "btn-leave", text: T("Leave run"), style: "btn-danger", act: leaveRun }, bw);
  }, { spacing: 10, width: bw });
}

function grid2(key: string, w: number, rows: [string, string | number][]): void {
  const c1 = Math.max(...rows.map(([k]) => textWidth(k, "grid-key"))) + 16;
  ui.column(key, () => rows.forEach(([k, v], i) => ui.row(`${key}-${i}`, () => {
    ui.style("grid-key", { width: c1 }).label(k);
    ui.style("grid-value").id(`${key}-${i}-v`).label(String(v));
  }, { spacing: 10, width: w })), { spacing: 10, width: w });
}

function resultsScreen(w: number): void {
  const R = app.results;
  if (!R) return;
  heading("h2", T("Run complete"), w);
  para(R.headline(), w, "text", "results-headline");
  const b = R.breakdown;
  grid2("results-breakdown", w, [[T("Distance"), b.distance], [T("Fragments"), b.fragments], [T("Risk bonus"), b.riskBonus], [T("Set bonus"), b.setBonus], [T("Total"), b.total]]);
  if (R.progress) para(R.progress(), w, "muted", "results-progress");
  const lb = leaderboardLine();
  if (lb) para(lb, w, "muted", "results-lb");
  for (const id of R.achievements) {
    const a = Progress.ACHIEVEMENTS.find((x) => x.id === id);
    if (a) para(T("Achievement unlocked: {name}", { name: T(a.name) }), w, "text");
  }
  const bw = Math.min(w, 340);
  gap(2);
  ui.column("results-buttons", () => {
    button({ id: "btn-retry", text: T("Retry"), style: "btn", act: retry }, bw);
    button({ id: "btn-next", text: T("Next recommended"), disabled: !R.canNext, act: nextRecommended }, bw);
    button({ id: "btn-results-home", text: T("Back to title"), act: backToTitle }, bw);
  }, { spacing: 10, width: bw });
}

// ------------------------------------------------------------------ help and settings
const KEY_NAMES: Record<string, string> = { "Arrow Up": "ArrowUp", "Arrow Down": "ArrowDown", "Arrow Left": "ArrowLeft", "Arrow Right": "ArrowRight" };
/** The effective keys of an action ("ArrowLeft / A"), as the old help listed KeyboardEvent codes. */
function keysFor(action: string): string {
  let list: string[] = [];
  try {
    list = bindings(action).filter((b) => b.device === "keyboard").map((b) => (b.label === "Space" ? T("Space") : KEY_NAMES[b.label] ?? b.label));
  } catch { /* not yet */ }
  return [...new Set(list)].join(" / ") || "—";
}
const KEY_MAPPINGS: { action?: string; keys?: string; label: string }[] = [
  { action: "left", label: N("Turn left / move to left lane (safe route at forks)") },
  { action: "right", label: N("Turn right / move to right lane (risk route at forks)") },
  { action: "jump", label: N("Jump") },
  { action: "slide", label: N("Slide") },
  { keys: N("Enter"), label: N("Confirm") },
  { action: "pause", label: N("Pause / cancel") },
  { action: "undo", label: N("Undo (practice only)") },
  { action: "hint", label: N("Hint") },
  { action: "camera", label: N("Reset camera") },
];
function helpScreen(w: number): void {
  heading("h2", T("How to play"), w);
  ui.column("help-cards", () => {
    KEY_MAPPINGS.forEach((m, i) => item(`help-${i}`, w, m.action ? keysFor(m.action) : T(m.keys!), T(m.label)));
  }, { spacing: 8, width: w });
  heading("h3", T("The rules"), w);
  ui.column("help-rules", () => {
    for (const line of [
      N("Run forward automatically. Reach the end of the course before time runs out."),
      N("At a fork, choose: left is the safe route, right is the risky route where fragments count double."),
      N("Jump gaps - falling in ends the run. Slide under vine barriers - each hit costs a heart."),
      N("Steer between lanes to collect relic fragments. Three of a kind earn a set bonus."),
    ]) para(`•  ${T(line)}`, w - 8, "text");
  }, { spacing: 6, width: w });
  ui.row("help-back", () => button({ id: "btn-back", text: T("Back"), act: overlayBack }), { spacing: 10 });
}

function settingsScreen(w: number): void {
  heading("h2", T("Settings"), w);
  ui.column("settings-grid", () => {
    const check = (key: "leftHanded" | "colorblind" | "timingAssist", text: string): void => {
      const cur = platform.options[key];
      const next = ui.id(`set-${key}`).checkbox(T(text), cur);
      if (next !== cur) later(() => { platform.setOption(key, next); click(); });
    };
    heading("h3", T("Controls"), w);
    check("leftHanded", N("Left-handed layout"));
    heading("h3", T("Accessibility"), w);
    check("colorblind", N("Colorblind-safe palette"));
    check("timingAssist", N("Timing assistance"));
    ui.row("set-tutorial-row", () => {
      ui.style("text").label(T("Replay tutorials"));
      button({ id: "set-tutorial", text: T("Reset lessons"), act: resetLessons });
    }, { spacing: 16, align: "center" });
    gap(4);
    para(T("Sound, graphics, language, haptics, reduced motion, high contrast and larger text are in the StarHermit Options."), w, "muted", "options-note");
    button({ id: "btn-options", text: T("Open Options"), act: () => { click(); openMenu(); } });
  }, { spacing: 10, width: w });
  ui.row("settings-back", () => button({ id: "btn-back", text: T("Back"), act: overlayBack }), { spacing: 10 });
}

// ------------------------------------------------------------------ friends and profile
function boardName(key: string): string {
  const m = /^daily-(.+)$/.exec(key);
  if (m) return T("Daily {date}", { date: m[1]! });
  const st = Content.STAGES.find((x) => x.id === key);
  return st ? T("Journey {stage}", { stage: T(st.name) }) : key;
}
function friendsScreen(w: number): void {
  heading("h2", T("Friends & scores"), w);
  const online = platform.signedIn();
  para(online ? T("Connected - live leaderboard below your personal records.") : T("Offline - showing locally saved records."), w, "muted", "friends-status");
  const p = progress();
  const locals = Object.entries(p.bestScores).map(([k, v]) => ({ name: boardName(k), score: v.total })).sort((a, b) => b.score - a.score).slice(0, 8);
  ui.column("friends-list", () => {
    if (!locals.length) item("friends-none", w, "", T("No personal records yet. Finish a ranked run to set one."));
    locals.forEach((r, i) => scoreRow(`local-${i}`, w, r.name, r.score));
  }, { spacing: 8, width: w });
  heading("h3", T("Leaderboard"), w);
  ui.column("board-list", () => {
    const b = app.board;
    if (Array.isArray(b) && b.length) b.forEach((e, i) => scoreRow(`board-${i}`, w, e.name, e.score));
    else item("board-none", w, "", T("No live board data. Personal bests stay in your profile and cloud save."));
  }, { spacing: 8, width: w });
  backButton();
}
function scoreRow(key: string, w: number, name: string, score: number): void {
  ui.row(key, () => {
    para(name, w - 120, "item-name");
    ui.spacer();
    ui.style("grid-value").label(String(score));
  }, { style: "item", width: w, spacing: 10, align: "center" });
}
function profileScreen(w: number): void {
  heading("h2", T("Profile"), w);
  const p = progress();
  grid2("profile-stats", w, [
    [T("Total runs"), p.totals.runs], [T("Total fragments"), p.totals.fragments],
    [T("Stages finished"), Object.values(p.journey.completed).filter((r) => r.finished).length], [T("Daily days played"), Object.keys(p.totals.dailies).length],
  ]);
  heading("h3", T("Achievements"), w);
  ui.column("profile-achievements", () => {
    for (const a of Progress.ACHIEVEMENTS) {
      const got = !!p.achievements[a.id];
      item(`ach-${a.id}`, w, T(a.name), T(a.description), { badge: { text: got ? T("unlocked") : T("locked"), done: got } });
    }
  }, { spacing: 8, width: w });
  backButton();
}

// ------------------------------------------------------------------ the run
function runView(L: Layout): void {
  const sess = app.sess;
  if (!sess || !app.run) return;
  const s = sess.state, bd = Session.scoreOf(sess);
  const live = app.machine === "active";
  const maxHearts = s.genOpts.hearts || Rules.MAX_HEARTS;
  const hearts = T("hearts") + " " + "●".repeat(Math.max(0, s.hearts)) + "○".repeat(Math.max(0, maxHearts - s.hearts));
  const stats = `${bd.total} ${T("pts")} · ${s.fragments} ${T("fragments")} · ${hearts} · ${T("speed {v} m/s", { v: (s.speed / 2).toFixed(1) })}`;
  const objective = app.run.objective();
  const textCls = L.short ? "hud-text-small" : "hud-text";
  const pad = 10;
  const avail = L.sw - 2 * pad;
  const pauseW = textWidth(T("Pause"), "btn-secondary", "button") + 4 + 16;
  const statsFull = textWidth(stats, textCls) + 24;
  const twoRows = L.portrait;
  const statsW = Math.min(statsFull, twoRows ? avail - pauseW - 6 : Math.max(200, avail * 0.36));
  const objW = twoRows ? avail : Math.min(textWidth(objective, textCls) + 24, 40 * 8.4 + 24, avail - statsW - pauseW - 12);
  const box = (key: string, w: number, text: string, cls = textCls): ui.Rect => ui.column(key, () => para(text, w - 24, cls, `${key}-text`), { style: "hud-box", width: w });
  const pauseBox = (): ui.Rect => ui.column("hud-pause", () => {
    button({ id: "btn-pause-hud", text: T("Pause"), act: () => { ui.setFocus(null); if (live) pauseRun(); } });
  }, { style: "hud-box", padding: 8 });
  const hud = ui.place("hud", { anchor: "top-start", x: L.sx + pad, y: L.sy + 8 }, () => {
    if (twoRows) {
      ui.column("hud-col", () => {
        ui.row("hud-r1", () => { box("hud-stats", statsW, stats); ui.spacer(); pauseBox(); }, { width: avail, spacing: 6, align: "start" });
        box("hud-objective", avail, objective, "hud-text-small");
      }, { spacing: 6, width: avail });
    } else {
      ui.row("hud-row", () => { box("hud-objective", objW, objective); ui.spacer(); box("hud-stats", statsW, stats); ui.spacer(); pauseBox(); }, { width: avail, spacing: 0, align: "start" });
    }
  });
  // the HUD boxes take presses (pointer-events: auto); the gaps between them are the course
  uiRects.push(hud);

  // #tray: ◀ Left, Jump ▲, Slide ▼, Right ▶ (row-reverse for the left-handed)
  const trayList: { a: Action; text: string; name: string }[] = [
    { a: "left", text: T("◀ Left"), name: T("Turn / Left") }, { a: "jump", text: T("Jump ▲"), name: T("Jump") },
    { a: "slide", text: T("Slide ▼"), name: T("Slide") }, { a: "right", text: T("Right ▶"), name: T("Turn / Right") },
  ];
  if (platform.options.leftHanded) trayList.reverse();
  const trayGap = 10;
  const portraitW = Math.min(120, (avail - 3 * trayGap) / 4);
  const tray = ui.place("tray", { anchor: "top-start", x: L.sx, y: L.sy + L.sh - (lastSize.get("tray") ?? 64) }, () => {
    const r = ui.row("tray-row", () => {
      for (const t of trayList) {
        const size = L.portrait ? Math.max(12.8, Math.min(17.6, L.lw * 0.036)) : 17.6;
        const opts: ui.ButtonOptions = {};
        const inline: ui.Style = L.portrait ? { width: portraitW, padding: { top: 10, bottom: 10, start: 4, end: 4 }, text: { size } } : {};
        if (ui.style("btn-tray", inline).id(`tray-${t.a}`).button(t.name, { ...opts, content: () => { ui.style({ text: { size: L.portrait ? size : 17.6 } }).label(t.text); } }) && fresh() && live) {
          later(() => { ui.setFocus(null); command(t.a); });
        }
      }
    }, { width: L.sw, spacing: trayGap, justify: L.short ? "end" : "center", padding: 10 });
    lastSize.set("tray", r.height / L.sc);
  });
  uiRects.push(tray);

  // #mirror: the "Ahead" text model, bottom-left above the tray
  const mtext = mirrorText();
  const trayH = lastSize.get("tray") ?? 64;
  if (mtext) {
    const mw = Math.min(L.sw - 16, 44 * 7.6 + 24);
    const mh = lastSize.get("mirror") ?? 40;
    const m = ui.place("mirror", { anchor: "top-start", x: L.sx + 8, y: L.sy + L.sh - trayH - (L.portrait ? 50 : 6) - mh }, () => {
      const r = ui.column("mirror-col", () => para(mtext, Math.min(mw, textWidth(mtext, "mirror-text") + 2), "mirror-text", "mirror-text"), { style: "mirror" });
      lastSize.set("mirror", r.height / L.sc);
    });
    uiRects.push(m);
  }

  if (app.machine === "countdown") {
    const ch = lastSize.get("countdown") ?? 96;
    ui.place("countdown", { anchor: "top-start", x: L.sx, y: L.sy + (L.sh - ch) / 2 }, () => {
      const r = ui.column("countdown-col", () => ui.style(ui.preferences().reducedMotion ? "countdown-plain" : "countdown").id("countdown-text").label(String(Math.max(1, app.countdown))), { width: L.sw, align: "center" });
      lastSize.set("countdown", r.height / L.sc);
    });
  }
}

function toastView(L: Layout): void {
  const t = app.toast;
  if (!t) return;
  const text = t.text();
  const tw = Math.min(L.lw - 32, 70 * 7.6, textWidth(text, "toast-text") + 34);
  const th = lastSize.get("toast") ?? 44;
  ui.place("toast", { anchor: "top-start", x: (L.lw - tw) / 2, y: L.lh - 80 - th }, () => {
    const r = ui.column("toast-col", () => para(text, tw - 34, "toast-text", "toast-text"), { style: t.invalid ? "toast-invalid" : "toast", width: tw });
    lastSize.set("toast", r.height / L.sc);
  });
}

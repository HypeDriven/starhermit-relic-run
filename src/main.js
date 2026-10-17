// Relic Run - bootstrap + game controller. Wires rules/session/content/render/
// audio/ui/store/platform together. Only validated commands mutate rules state.
import { TICKS_PER_SECOND, UNITS_PER_CELL, MAX_HEARTS, hashState, activeBranch, createState } from './rules.js';
import * as Session from './session.js';
import * as Content from './content.js';
import * as Render from './render.js';
import * as Audio from './audio.js';
import * as Store from './store.js';
import * as Platform from './platform.js';
import { createUI, bindSettings } from './ui.js';
import { bindGraphics } from './gfx-ui.js';
import { shText } from './sh-i18n.js';
import { T, N, onLanguage } from './lang.js';

const TICK_MS = 1000 / TICKS_PER_SECOND;
let gfxPanel = null; // Settings > Graphics (gfx-ui.js), relabelled on a language change

// --- app state -------------------------------------------------------------------
const app = {
  machine: 'boot',
  reason: 'init',
  profile: Store.loadProfile(),
  renderer: null,
  webgl: true,
  sess: null,
  run: null,          // { mode, label, objective, ranked, seed, genOpts, theme, constraint, stage, lesson }
  accMs: 0,
  lastTs: 0,
  countdownLeft: 0,
  undoRing: [],       // practice undo snapshots
  hiddenSnapshot: null,
  hiddenAt: 0,
  mirrorTick: -1,
  daily: null,
  moveCount: 0,
};

function setMachine(next, reason) {
  app.machine = next;
  app.reason = reason;
}

// --- boot --------------------------------------------------------------------------
const ui = createUI({
  click: () => { Audio.ensureAudio(); Audio.playEvent('click'); },
  action: (a) => { Audio.ensureAudio(); command(a); },
  pause: () => pauseRun('user'),
  resume: () => resumeRun(),
  leave: () => leaveRun(),
  retry: () => { if (app.run) startRun(app.run); },
  next: () => nextRecommended(),
  hint: () => showHint(),
  openDaily: () => openDaily(),
  startDaily: () => { if (app.daily) startRun(dailyRunConfig()); },
  openFriends: () => openFriends(),
  signIn: () => Platform.signIn(),
  invite: () => copyInvite(),
  bindings: () => Platform.getBindings(),
  renderProfile: () => ui.renderProfile(app.profile),
  resetTutorials: () => {
    app.profile.tutorials = {};
    persistProfile();
    ui.renderLearn(app.profile, startLesson);
    ui.toast(T('Lessons reset. Tutorials will play again.'));
  },
});

async function boot() {
  setMachine('boot', 'init');
  // hosted: pull cloud progress first so the UI binds to the merged profile
  if (Platform.hasIdentity()) {
    const remote = await Platform.cloudLoad();
    if (remote) {
      // Merge the cloud copy with this device's progress (best of each side)
      // and write the merge back when this device added anything.
      const merged = Store.mergeProfiles(app.profile, Store.normalizeProfile(remote));
      const grew = JSON.stringify(merged) !== JSON.stringify(Store.normalizeProfile(remote));
      app.profile = merged;
      Store.saveProfile(app.profile);
      if (grew) Platform.scheduleCloudSave(app.profile);
    } else if (Store.hasSavedProfile()) {
      Platform.scheduleCloudSave(app.profile); // empty slot: seed it from the local copy
    }
    // another device saved since our load: merge its progress in, keep the run
    Platform.onConflict((remote) => {
      // merged in place: the settings panels keep their reference to profile.settings
      if (remote) Object.assign(app.profile, { ...Store.mergeProfiles(app.profile, Store.normalizeProfile(remote)), settings: app.profile.settings });
      Store.saveProfile(app.profile);
      if (!app.sess) {
        ui.renderJourney(app.profile, (st) => startRun(stageRunConfig(st)));
        ui.renderLearn(app.profile, startLesson);
      }
      return app.profile;
    });
    // per-player settings KV wins over local values
    if (await Platform.loadSettings(app.profile.settings)) Store.saveProfile(app.profile);
  }
  await Platform.loadBindings();
  bindSettings(app.profile.settings, onSettingsChanged);
  applyAudioSettings();
  ui.renderJourney(app.profile, (st) => startRun(stageRunConfig(st)));
  ui.renderLearn(app.profile, startLesson);
  ui.renderPractice((diff) => startRun(practiceRunConfig(diff)));
  ui.renderChallenges((c) => startRun(challengeRunConfig(c)));
  ui.renderHelp();

  // renderer (may be unavailable -> compat message, menus still work)
  const canvas = document.getElementById('game');
  try {
    app.renderer = Render.createRenderer(canvas, {
      gfx: app.profile.settings.graphics.gfx,
      reducedMotion: app.profile.settings.accessibility.reducedMotion,
      colorblind: app.profile.settings.accessibility.colorblindPalette,
    });
    Render.setGraphics(app.renderer, app.profile.settings.graphics.gfx);
    Render.resize(app.renderer, canvas.clientWidth || 640, canvas.clientHeight || 480);
  } catch (e) {
    app.webgl = false;
    ui.showCompat(true);
  }
  gfxPanel = bindGraphics(app.profile.settings, onSettingsChanged, () => (app.renderer ? Render.graphicsInfo(app.renderer) : null));

  // idle backdrop scene so the title isn't a void
  if (app.webgl) {
    const idle = Content.STAGES[0];
    buildScene(idle.seed, idle.genOpts, idle.theme);
  }

  ui.setNet(Platform.hasIdentity());
  if (Platform.hasIdentity()) {
    Platform.onSyncStatus(ui.setSync);
    Platform.fetchNickname()
      .then((name) => { if (name) ui.setName(name); })
      .catch(() => {});
  } else {
    ui.setSync('offline');
  }
  refreshAccount();
  Platform.onAuth((a) => {
    if (!a.signedIn) { ui.setName(''); ui.toast(shText('signedOut')); }
    refreshAccount();
  });
  setMachine('title', 'boot-complete');
  setMachine('profile-ready', 'profile-loaded');
  ui.resetRail();
  ui.setProgress(idleProgressText());
  ui.show('title');
  ui.announce(T('Relic Run loaded. Press Play to choose a mode.'));
  requestAnimationFrame(loop);
}

// StarHermit account chrome: sign-in when possible, invite link when signed in.
function refreshAccount() {
  ui.setAccount({ signedIn: Platform.hasIdentity(), canSignIn: Platform.canSignIn() });
}
async function copyInvite() {
  const url = Platform.inviteLink();
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    ui.toast(shText('inviteCopied'));
  } catch {
    ui.toast(shText('inviteLink', { url }));
  }
}

// left-rail "Progress" copy: run context while playing, profile totals at rest.
function persistProfile() {
  Store.saveProfile(app.profile);
  Platform.scheduleCloudSave(app.profile); // no-op unless hosted
}

// Progress lines are functions so they re-render in a new language.
function idleProgressText() {
  return () => {
    const done = Object.values(app.profile.journey.completed).filter((r) => r.finished).length;
    return T('{done} of {total} stages finished · {runs} runs · {fragments} fragments.', { done, total: Content.STAGES.length, runs: app.profile.totals.runs, fragments: app.profile.totals.fragments });
  };
}

const CONSTRAINT_NAMES = { 'move-limit': N('move limit'), 'speed-target': N('speed target') };
function runProgressText(cfg) {
  if (cfg.mode === 'journey') {
    const vars = { n: cfg.stage.index + 1, total: Content.STAGES.length, unlocked: app.profile.journey.unlocked };
    return () => T('Stage {n} of {total} · unlocked through stage {unlocked}.', vars);
  }
  if (cfg.mode === 'learn') {
    const vars = { n: Content.LESSONS.indexOf(cfg.lesson) + 1, total: Content.LESSONS.length };
    return () => T('Lesson {n} of {total}.', vars);
  }
  if (cfg.mode === 'daily') { const date = app.daily ? app.daily.dateKey : ''; return () => T('Daily {date} · ranked.', { date }); }
  if (cfg.mode === 'practice') return () => T('Practice · unranked · press U to undo.');
  if (cfg.mode === 'challenge') return () => T('Challenge · {type}.', { type: cfg.constraint ? T(CONSTRAINT_NAMES[cfg.constraint.type] || cfg.constraint.type) : T('ranked') });
  return '';
}

function buildScene(seed, genOpts, themeId) {
  const theme = Content.THEMES.find((t) => t.id === themeId) || Content.THEMES[0];
  const course = ContentPreview.courseOf(seed, genOpts);
  Render.buildCourseScene(app.renderer, course, theme, (seed ^ 0xdec0) >>> 0);
}

// course without a full state (uses rules generator through a throwaway state)
const ContentPreview = {
  courseOf(seed, genOpts) {
    return createState(seed, genOpts).course;
  },
};

// --- run configuration -------------------------------------------------------------
function stageRunConfig(st) {
  return {
    mode: 'journey', stage: st, seed: st.seed, genOpts: st.genOpts, theme: st.theme,
    ranked: true, label: () => T('Journey: {name}', { name: T(st.name) }),
    objective: () => (st.goals.fragments ? T('Reach the end and collect {n} fragments.', { n: st.goals.fragments }) : T('Reach the end.')) +
      (st.tutorial ? ' ' + T('New mechanic: {mechanic}.', { mechanic: T(st.tutorial) }) : ''),
  };
}
function startLesson(lesson) {
  startRun({
    mode: 'learn', lesson, seed: lesson.seed, genOpts: lesson.genOpts, theme: 'emerald-overgrowth',
    ranked: false, label: () => T('Lesson: {name}', { name: T(lesson.name) }), objective: () => T(lesson.goalText),
  });
}
function practiceRunConfig(diff) {
  const d = Content.PRACTICE_DIFFICULTIES[diff];
  const seed = (Date.now() % 0x7fffffff) >>> 0;
  return {
    mode: 'practice', difficulty: diff, seed, genOpts: d.genOpts, theme: 'moss-cistern',
    ranked: false, label: () => T('Practice ({level})', { level: T(d.label) }), objective: () => T('Reach the end. U undoes a few seconds.'),
  };
}
function challengeRunConfig(c) {
  return {
    mode: 'challenge', challenge: c, seed: c.seed, genOpts: c.genOpts, theme: c.theme,
    ranked: true, constraint: c.constraint, label: () => T('Challenge: {name}', { name: T(c.name) }), objective: () => T(c.description),
  };
}
function dailyRunConfig() {
  const d = app.daily;
  return {
    mode: 'daily', seed: d.seed, genOpts: d.genOpts, theme: d.theme,
    ranked: true, label: () => T('Daily {date}', { date: d.dateKey }), objective: () => T('Finish the daily course. One shared seed for everyone today.'),
  };
}

function openDaily() {
  // The daily seed derives from the device clock's UTC date (same course for
  // everyone); no server route is involved.
  const local = Content.dailyContent();
  const d = { seed: local.seed, dateKey: local.dateKey, genOpts: local.genOpts, theme: local.theme };
  app.daily = d;
  const best = app.profile.bestScores['daily-' + d.dateKey];
  ui.setDailyInfo(
    () => T('Seed for {date} (UTC). Same course for every player today. Ranked.', { date: d.dateKey }),
    best ? () => T('Your best today: {n} pts.', { n: best.total }) : () => T('No attempt recorded today.'),
  );
  ui.show('daily');
}

async function openFriends() {
  let board = null;
  try { board = await Platform.fetchLeaderboard(); } catch { /* offline */ }
  ui.renderFriends(app.profile, Platform.hasIdentity(), board);
  ui.show('friends');
}

// --- run lifecycle -------------------------------------------------------------------
function startRun(config) {
  if (!app.webgl) { ui.showCompat(true); return; }
  Audio.ensureAudio();
  setMachine('preparing', 'start-' + config.mode);
  app.run = config;
  app.moveCount = 0;
  app.undoRing = [];
  app.sess = Session.startSession(Session.newSession(config.seed, config.genOpts));
  buildScene(config.seed, config.genOpts, config.theme);
  ui.setModeLabel(config.label);
  ui.setHUD({ objective: config.objective, score: 0, fragments: 0, hearts: app.sess.state.hearts, maxHearts: MAX_HEARTS, speed: app.sess.state.speed });
  ui.setProgress(runProgressText(config));
  ui.showPlay();
  ui.announce(T('{label}. {objective}', { label: config.label(), objective: config.objective() }));
  if (config.lesson) ui.toast(T(config.lesson.intro) + ' ' + T(config.lesson.prompt));
  // countdown
  app.countdownLeft = 3;
  setMachine('countdown', 'run-ready');
  ui.setCountdown('3');
  Audio.playEvent('countdown');
  Audio.startAmbience();
  Audio.startMusic(config.seed);
  Audio.setMusicIntensity(0.3);
}

function beginActive() {
  setMachine('active', 'countdown-done');
  ui.setCountdown(null);
  Audio.playEvent('go');
  app.accMs = 0;
  app.lastTs = performance.now();
}

function pauseRun(reason) {
  if (app.machine !== 'active') return;
  setMachine('paused', reason);
  app.hiddenSnapshot = Session.snapshot(app.sess);
  ui.setAwaySummary('');
  ui.show('pause');
  ui.announce(T('Paused.'));
  Audio.playEvent('click');
}

function resumeRun() {
  if (app.machine !== 'paused') return;
  // while-you-were-away summary
  if (app.hiddenSnapshot && app.hiddenAt) {
    const awaySec = Math.round((Date.now() - app.hiddenAt) / 1000);
    const sum = Session.awaySummary(app.hiddenSnapshot.state, app.sess.state);
    const delta = `${sum.scoreDelta >= 0 ? '+' : ''}${sum.scoreDelta}`;
    const away = awaySec >= 5 ? () => T('While you were away ({n}s): the run was paused - nothing moved. Score unchanged ({delta}).', { n: awaySec, delta }) : '';
    ui.setAwaySummary(away);
    if (away) ui.announce(away());
  }
  app.hiddenAt = 0;
  setMachine('active', 'resume');
  ui.showPlay();
  app.lastTs = performance.now();
  app.accMs = 0;
}

function leaveRun() {
  setMachine('title', 'leave');
  app.sess = null;
  app.run = null;
  Audio.stopMusic();
  Audio.stopAmbience();
  ui.resetRail();
  ui.setProgress(idleProgressText());
  ui.show('title');
}

function nextRecommended() {
  if (app.run && app.run.mode === 'journey') {
    const idx = app.run.stage.index;
    const next = Content.STAGES[idx + 1];
    if (next && idx + 2 <= app.profile.journey.unlocked) return startRun(stageRunConfig(next));
  }
  if (app.run && app.run.mode === 'learn') {
    const idx = Content.LESSONS.indexOf(app.run.lesson);
    const next = Content.LESSONS[idx + 1];
    if (next) return startLesson(next);
  }
  ui.show('mode');
}

// --- commands -------------------------------------------------------------------------
function command(action) {
  if (!app.sess) return;
  if (app.machine === 'countdown') return;
  if (app.machine !== 'active') return;
  const sess = app.sess;

  // challenge constraint: move limit
  if (app.run && app.run.constraint && app.run.constraint.type === 'move-limit') {
    if (app.moveCount >= app.run.constraint.limit) {
      ui.toast(T('Move limit reached ({n}). No inputs left.', { n: app.run.constraint.limit }), true);
      Audio.playEvent('invalid');
      return;
    }
  }
  const id = sess.nextCmdId; // double-commit prevention by command id
  const res = Session.applySessionCommand(sess, { id, action });
  if (!res.ok) {
    if (!res.deduped) {
      ui.toast(invalidText(res.reason, action), true);
      Audio.playEvent('invalid');
      updateHUDNow();
    }
    return;
  }
  app.moveCount++;
  Audio.playEvent(res.effect === 'route' ? 'branch' : action, sess.state.tick ^ sess.seed);
  if (app.profile.settings.controls.haptics && navigator.vibrate) navigator.vibrate(12);
  updateHUDNow();
}

function invalidText(reason, action) {
  switch (reason) {
    case 'lane-edge': return T('Already at the edge lane.');
    case 'airborne': return T('Already in the air.');
    case 'sliding': return T('Already sliding.');
    case 'branch-choice-required': return T('A fork is ahead - choose left (safe) or right (risk).');
    case 'mechanic-disabled': return T('That move is not part of this stage.');
    case 'session-over': return T('The run is over.');
    default: return T('Cannot {action} here ({reason}).', { action: T(action), reason });
  }
}

function showHint() {
  if (!app.sess) return;
  const s = app.sess.state;
  const ci = Math.floor(s.distUnits / UNITS_PER_CELL);
  const cells = s.course.cells;
  if (activeBranch(s) >= 0) {
    ui.toast(T('Fork ahead: LEFT for the safe route, RIGHT for double-fragment risk route.'));
    return;
  }
  for (let i = ci + 1; i <= Math.min(ci + 5, cells.length - 1); i++) {
    const c = cells[i];
    if (c.gap) { ui.toast(T('Gap in {n} - jump (UP) just before it.', { n: i - ci })); return; }
    if (c.low) { ui.toast(T('Low barrier in {n} - slide (DOWN) under it.', { n: i - ci })); return; }
    if (c.relicLane >= 0) { ui.toast(T('Fragment in {n}, {lane} lane.', { n: i - ci, lane: T([N('left'), N('center'), N('right')][c.relicLane]) })); return; }
  }
  ui.toast(T('Path is clear. Keep running.'));
}

function practiceUndo() {
  if (!app.run || app.run.mode !== 'practice' || app.machine !== 'active') {
    ui.toast(T('Undo is only available in Practice.'), true);
    return;
  }
  const snap = app.undoRing.pop();
  if (!snap) { ui.toast(T('Nothing to undo yet.'), true); return; }
  app.sess = Session.restore(snap);
  ui.toast(T('Undid a few seconds.'));
  Audio.playEvent('click');
  updateHUDNow();
}

// --- main loop -------------------------------------------------------------------------
function loop(ts) {
  requestAnimationFrame(loop);
  const dtMs = Math.min(100, ts - (app.lastTs || ts));
  app.lastTs = ts;

  if (app.machine === 'countdown') {
    countdownTick(dtMs);
  } else if (app.machine === 'active' && app.sess) {
    app.accMs += dtMs;
    const rate = app.profile.settings.accessibility.timingAssist ? TICK_MS * 1.5 : TICK_MS;
    let stepped = false;
    while (app.accMs >= rate) {
      app.accMs -= rate;
      const before = app.sess.state.terminal;
      const prevFrag = app.sess.state.fragments;
      const prevBonus = app.sess.state.setBonuses;
      const prevHearts = app.sess.state.hearts;
      Session.advance(app.sess, 1);
      const s = app.sess.state;
      stepped = true;
      if (app.run && app.run.mode === 'practice' && s.tick % 60 === 0 && !s.terminal) {
        app.undoRing.push(Session.snapshot(app.sess));
        if (app.undoRing.length > 6) app.undoRing.shift();
      }
      if (s.fragments > prevFrag) {
        Audio.playEvent('collect', s.tick ^ s.seed);
        if (s.setBonuses > prevBonus) Audio.playEvent('setbonus');
      }
      if (s.hearts < prevHearts) {
        Audio.playEvent('crash');
        Render.addShake(app.renderer, 0.3);
        ui.announce(T('Hit a barrier. {n} hearts left.', { n: s.hearts }), true);
      }
      if (s.terminal && !before) {
        onTerminal(s.terminal);
      }
    }
    if (stepped && app.sess && app.sess.state.tick !== app.mirrorTick) {
      app.mirrorTick = app.sess.state.tick;
      if (app.sess.state.tick % 10 === 0) updateHUDNow();
    }
  }

  // render
  if (app.webgl && app.renderer && !document.hidden) {
    if (app.sess) {
      Render.updateFrame(app.renderer, app.sess.state, 0, dtMs / 1000);
    } else {
      Render.updateIdle(app.renderer, dtMs / 1000);
    }
    Render.render(app.renderer);
  }
  pollGamepad();
}

function countdownTick(dtMs) {
  app.countdownAcc = (app.countdownAcc || 0) + dtMs;
  if (app.countdownAcc >= 800) {
    app.countdownAcc = 0;
    app.countdownLeft--;
    if (app.countdownLeft <= 0) {
      beginActive();
    } else {
      ui.setCountdown(String(app.countdownLeft));
      Audio.playEvent('countdown');
    }
  }
}

function updateHUDNow() {
  if (!app.sess) return;
  const s = app.sess.state;
  const bd = Session.scoreOf(app.sess);
  ui.setHUD({
    objective: app.run ? app.run.objective : '',
    score: bd.total, fragments: s.fragments,
    hearts: s.hearts, maxHearts: app.sess.state.genOpts.hearts || MAX_HEARTS,
    speed: s.speed,
  });
  ui.updateMirror(s, UNITS_PER_CELL);
}

// --- terminal / results ------------------------------------------------------------------
// Signed in, a finished Journey, Daily or Challenge run posts its total to the
// StarHermit high-score board and the results screen shows the player's rank.
function postToLeaderboard(mode, total) {
  const line = document.getElementById('results-lb');
  if (!line) return;
  if (!Platform.hasIdentity() || !['journey', 'daily', 'challenge'].includes(mode)) { line.hidden = true; line.textContent = ''; return; }
  line.hidden = false;
  app.lbResult = { pending: true };
  renderLeaderboardLine();
  Platform.submitScore(total).then((r) => {
    app.lbResult = r;
    renderLeaderboardLine();
  });
}
function renderLeaderboardLine() {
  const line = document.getElementById('results-lb');
  const r = app.lbResult;
  if (!line || line.hidden || !r) return;
  line.textContent = r.pending ? shText('lbPosting') : !r.posted ? shText('lbNotPosted')
    : r.rank ? shText('lbRank', { rank: r.rank }) : shText('lbPosted');
}

function onTerminal(terminal) {
  setMachine('resolving', terminal);
  Audio.stopMusic();
  Audio.stopAmbience();
  if (terminal === 'finished') Audio.playEvent('finish');
  else if (terminal === 'fell') Audio.playEvent('fell');
  else Audio.playEvent('crash');

  const sess = app.sess;
  const bd = Session.scoreOf(sess);
  const s = sess.state;
  const run = app.run;

  // progress + achievements (local by design; unlocks ride the cloud-saved doc)
  const earned = [];
  const grant = (key) => {
    if (Store.unlockAchievement(app.profile, key)) {
      const meta = Store.ACHIEVEMENTS.find((a) => a.id === key);
      earned.push(meta);
    }
  };
  app.profile.totals.runs++;
  app.profile.totals.fragments += s.fragments;
  if (terminal === 'finished') grant('first-finish');
  if (app.profile.totals.fragments >= 1000) grant('fragments-1000');

  let progress = '';
  let canNext = false;
  if (run.mode === 'journey') {
    const prev = app.profile.journey.completed[run.stage.id];
    const rec = { score: Math.max(bd.total, prev ? prev.score : 0), finished: terminal === 'finished' || (prev && prev.finished) };
    app.profile.journey.completed[run.stage.id] = rec;
    if (terminal === 'finished' && run.stage.index + 2 > app.profile.journey.unlocked) {
      app.profile.journey.unlocked = Math.min(Content.STAGES.length, run.stage.index + 2);
    }
    if (terminal === 'finished' && run.stage.difficulty === 'hard') grant('hard-milestone');
    canNext = terminal === 'finished' && run.stage.index + 1 < Content.STAGES.length;
    const vars = { n: run.stage.index + 1, total: Content.STAGES.length, unlocked: app.profile.journey.unlocked };
    progress = () => T('Stage {n} of {total}. Unlocked through stage {unlocked}.', vars);
  } else if (run.mode === 'learn') {
    if (terminal === 'finished') {
      app.profile.tutorials[run.lesson.id] = true;
      const all = Content.LESSONS.every((l) => app.profile.tutorials[l.id]);
      if (all) grant('mechanic-mastery');
      canNext = Content.LESSONS.indexOf(run.lesson) + 1 < Content.LESSONS.length;
      progress = () => T('Lesson complete.');
    }
  } else if (run.mode === 'daily') {
    const key = 'daily-' + app.daily.dateKey;
    app.profile.totals.dailies[app.daily.dateKey] = Math.max(bd.total, app.profile.totals.dailies[app.daily.dateKey] || 0);
    if (Object.keys(app.profile.totals.dailies).length >= 3) grant('daily-streak-3');
    const best = app.profile.bestScores[key];
    if (!best || bd.total > best.total) {
      app.profile.bestScores[key] = { total: bd.total, breakdown: bd, date: app.daily.dateKey };
      progress = best ? () => T('New daily best (was {n}).', { n: best.total }) : () => T('First daily score recorded.');
    }
  } else if (run.mode === 'practice') {
    progress = () => T('Practice run - unranked.');
  } else if (run.mode === 'challenge') {
    progress = terminal === 'finished' ? () => T('Constraint held. Well done.') : () => T('The course won this time.');
  }

  persistProfile();

  // Bests stay in the (cloud-saved) profile; hosted Journey, Daily and Challenge
  // runs are also posted to the StarHermit high-score board (below).

  const headlineKey = {
    finished: N('You reached the relic gate!'),
    crashed: N('The vines brought you down.'),
    fell: N('You fell into the ruins.'),
    'time-up': N('The light faded - time up.'),
  }[terminal] || N('Run over');

  setMachine('results', terminal);
  ui.setProgress(progress || idleProgressText());
  ui.renderResults({ headline: () => T('{headline} - {n} pts', { headline: T(headlineKey), n: bd.total }), breakdown: bd, progress, achievements: earned, canNext });
  ui.show('results');
  ui.announce(T('{headline}. Final score {n}.', { headline: T(headlineKey), n: bd.total }), true);
  postToLeaderboard(run.mode, bd.total);
  ui.renderJourney(app.profile, (st) => startRun(stageRunConfig(st)));
  ui.renderLearn(app.profile, startLesson);
}

// --- settings ------------------------------------------------------------------------------
function onSettingsChanged(settings) {
  persistProfile();
  Platform.mirrorSettings(app.profile.settings);
  applyAudioSettings();
  if (app.renderer) {
    Render.setReducedMotion(app.renderer, settings.accessibility.reducedMotion);
    Render.setGraphics(app.renderer, settings.graphics.gfx);
    Render.setColorblind(app.renderer, settings.accessibility.colorblindPalette);
  }
}

function applyAudioSettings() {
  const a = app.profile.settings.audio;
  Audio.setVolume('master', a.master);
  Audio.setVolume('music', a.music);
  Audio.setVolume('effects', a.effects);
  Audio.setVolume('ambience', a.ambience);
  Audio.setMuted(a.muted);
}

// --- input ----------------------------------------------------------------------------------
// Keydown is routed by KeyboardEvent.code through the player's platform bindings
// (control.* in starhermit.txt; defaults in platform.js).
const RUN_ACTIONS = new Set(['left', 'right', 'jump', 'slide']);

document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  Audio.ensureAudio();
  const action = Platform.actionFor(e.code);
  if (RUN_ACTIONS.has(action)) {
    if (app.machine === 'active') { e.preventDefault(); command(action); }
    return;
  }
  switch (action) {
    case 'pause':
      if (app.machine === 'active') pauseRun('esc');
      else if (app.machine === 'paused') resumeRun();
      else if (ui.currentScreen && ui.currentScreen !== 'title') ui.show(ui.backTarget === 'pause' && app.sess ? 'pause' : 'title');
      break;
    case 'undo': practiceUndo(); break;
    case 'hint': showHint(); break;
    case 'camera':
      if (app.renderer && app.sess) {
        const s = app.sess.state;
        app.renderer.camPos.set(0, Render.CAMERA.height, (s.distUnits / UNITS_PER_CELL) * 2 - Render.CAMERA.back);
        ui.toast(T('Camera recentered.'));
      }
      break;
    // Enter/Space already activate a focused button natively; handling them
    // here as well would fire every button twice.
    default: break;
  }
});

// pointer/touch swipes on the canvas: tap vs drag thresholds, pointer capture
(function bindPointer() {
  const el = document.getElementById('stage');
  let startX = 0, startY = 0, startT = 0, pid = null;
  el.addEventListener('pointerdown', (e) => {
    if (app.machine !== 'active') return;
    // Only the canvas is a gesture surface: presses on HUD/tray controls (and
    // any other interactive descendant) are theirs alone, never a jump/swipe.
    if (e.target !== el && e.target.closest('button, a, input, select, textarea, [role="button"], #hud, #tray, .tray')) return;
    pid = e.pointerId;
    startX = e.clientX; startY = e.clientY; startT = performance.now();
    el.setPointerCapture(pid);
  });
  el.addEventListener('pointerup', (e) => {
    if (pid !== e.pointerId) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    const dist = Math.hypot(dx, dy);
    const dt = performance.now() - startT;
    pid = null;
    if (dist < 14 && dt < 400) { command('jump'); return; } // tap = jump
    if (Math.abs(dx) > Math.abs(dy)) command(dx > 0 ? 'right' : 'left');
    else command(dy > 0 ? 'slide' : 'jump');
  });
  el.addEventListener('pointercancel', () => { pid = null; });
  el.addEventListener('lostpointercapture', () => { pid = null; });
})();

// gamepad: edge-detected buttons/axes during play
let padPrev = {};
function pollGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = pads && pads[0];
  if (!gp) return;
  const cur = {
    left: gp.buttons[14] && gp.buttons[14].pressed || gp.axes[0] < -0.5,
    right: gp.buttons[15] && gp.buttons[15].pressed || gp.axes[0] > 0.5,
    jump: gp.buttons[0] && gp.buttons[0].pressed || gp.buttons[12] && gp.buttons[12].pressed || gp.axes[1] < -0.5,
    slide: gp.buttons[1] && gp.buttons[1].pressed || gp.buttons[13] && gp.buttons[13].pressed || gp.axes[1] > 0.5,
    pause: gp.buttons[9] && gp.buttons[9].pressed,
  };
  for (const k of ['left', 'right', 'jump', 'slide']) {
    if (cur[k] && !padPrev[k] && app.machine === 'active') command(k);
  }
  if (cur.pause && !padPrev.pause) {
    if (app.machine === 'active') pauseRun('gamepad');
    else if (app.machine === 'paused') resumeRun();
  }
  padPrev = cur;
}

// --- lifecycle: resize, visibility --------------------------------------------------------
window.addEventListener('resize', () => {
  if (!app.renderer) return;
  const holder = document.getElementById('stage');
  Render.resize(app.renderer, holder.clientWidth, holder.clientHeight);
});

document.addEventListener('visibilitychange', () => {
  Audio.handleVisibility(document.hidden);
  if (document.hidden) {
    if (app.machine === 'active') {
      pauseRun('backgrounded');
      app.hiddenAt = Date.now();
    }
  }
});

// clock display (device clock)
setInterval(() => {
  const d = new Date();
  ui.setClock(d.toISOString().slice(11, 19) + ' UTC');
}, 1000);

// Language change (Settings → Language or the account preference arriving):
// src/i18n.js re-applied the static markup; re-render what code wrote, in
// place, without touching the run.
onLanguage(() => {
  ui.relabel();
  if (gfxPanel) gfxPanel.relabel();
  ui.renderJourney(app.profile, (st) => startRun(stageRunConfig(st)));
  ui.renderLearn(app.profile, startLesson);
  ui.renderPractice((diff) => startRun(practiceRunConfig(diff)));
  ui.renderChallenges((c) => startRun(challengeRunConfig(c)));
  if (ui.currentScreen === 'profile') ui.renderProfile(app.profile);
  if (app.sess) ui.updateMirror(app.sess.state, UNITS_PER_CELL);
  renderLeaderboardLine();
});

// start the app
boot();

// debug/test handle
window.__rr = app;

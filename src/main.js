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

const TICK_MS = 1000 / TICKS_PER_SECOND;

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
  renderProfile: () => ui.renderProfile(app.profile),
  resetTutorials: () => {
    app.profile.tutorials = {};
    Store.saveProfile(app.profile);
    ui.renderLearn(app.profile, startLesson);
    ui.toast('Lessons reset. Tutorials will play again.');
  },
});

async function boot() {
  setMachine('boot', 'init');
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
      quality: app.profile.settings.graphics.quality,
      reducedMotion: app.profile.settings.accessibility.reducedMotion,
      colorblind: app.profile.settings.accessibility.colorblindPalette,
    });
    Render.resize(app.renderer, canvas.clientWidth || 640, canvas.clientHeight || 480);
  } catch (e) {
    app.webgl = false;
    ui.showCompat(true);
  }

  // idle backdrop scene so the title isn't a void
  if (app.webgl) {
    const idle = Content.STAGES[0];
    buildScene(idle.seed, idle.genOpts, idle.theme);
  }

  const online = await Platform.probeServer();
  ui.setNet(online);
  setMachine('title', 'boot-complete');
  setMachine('profile-ready', 'profile-loaded');
  ui.resetRail();
  ui.setProgress(idleProgressText());
  ui.show('title');
  ui.announce('Relic Run loaded. Press Play to choose a mode.');
  requestAnimationFrame(loop);
}

// left-rail "Progress" copy: run context while playing, profile totals at rest.
function idleProgressText() {
  const done = Object.values(app.profile.journey.completed).filter((r) => r.finished).length;
  return `${done} of ${Content.STAGES.length} stages finished · ${app.profile.totals.runs} runs · ${app.profile.totals.fragments} fragments.`;
}

function runProgressText(cfg) {
  if (cfg.mode === 'journey') {
    return `Stage ${cfg.stage.index + 1} of ${Content.STAGES.length} · unlocked through stage ${app.profile.journey.unlocked}.`;
  }
  if (cfg.mode === 'learn') {
    return `Lesson ${Content.LESSONS.indexOf(cfg.lesson) + 1} of ${Content.LESSONS.length}.`;
  }
  if (cfg.mode === 'daily') return `Daily ${app.daily ? app.daily.dateKey : ''} · ranked.`;
  if (cfg.mode === 'practice') return 'Practice · unranked · press U to undo.';
  if (cfg.mode === 'challenge') return `Challenge · ${cfg.constraint ? cfg.constraint.type : 'ranked'}.`;
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
    ranked: true, label: `Journey: ${st.name}`,
    objective: `Reach the end${st.goals.fragments ? ` and collect ${st.goals.fragments} fragments` : ''}. ${st.tutorial ? 'New mechanic: ' + st.tutorial + '.' : ''}`,
  };
}
function startLesson(lesson) {
  startRun({
    mode: 'learn', lesson, seed: lesson.seed, genOpts: lesson.genOpts, theme: 'emerald-overgrowth',
    ranked: false, label: `Lesson: ${lesson.name}`, objective: lesson.goalText,
  });
}
function practiceRunConfig(diff) {
  const d = Content.PRACTICE_DIFFICULTIES[diff];
  const seed = (Date.now() % 0x7fffffff) >>> 0;
  return {
    mode: 'practice', difficulty: diff, seed, genOpts: d.genOpts, theme: 'moss-cistern',
    ranked: false, label: `Practice (${d.label})`, objective: 'Reach the end. U undoes a few seconds.',
  };
}
function challengeRunConfig(c) {
  return {
    mode: 'challenge', challenge: c, seed: c.seed, genOpts: c.genOpts, theme: c.theme,
    ranked: true, constraint: c.constraint, label: `Challenge: ${c.name}`, objective: c.description,
  };
}
function dailyRunConfig() {
  const d = app.daily;
  return {
    mode: 'daily', seed: d.seed, genOpts: d.genOpts, theme: d.theme,
    ranked: true, label: `Daily ${d.dateKey}`, objective: 'Finish the daily course. One shared seed for everyone today.',
  };
}

async function openDaily() {
  let d = null;
  try {
    d = await Platform.fetchDaily();
  } catch { /* offline: compute locally */ }
  if (!d) {
    const local = Content.dailyContent();
    d = { seed: local.seed, dateKey: local.dateKey, genOpts: local.genOpts, theme: local.theme };
  }
  app.daily = d;
  const best = app.profile.bestScores['daily-' + d.dateKey];
  ui.setDailyInfo(
    `Seed for ${d.dateKey} (UTC). Same course for every player today. Ranked.`,
    best ? `Your best today: ${best.total} pts.` : 'No attempt recorded today.',
  );
  ui.show('daily');
}

async function openFriends() {
  let board = null;
  try { board = await Platform.fetchLeaderboard('global'); } catch { /* offline */ }
  ui.renderFriends(app.profile, Platform.isServerOnline(), board);
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
  ui.announce(`${config.label}. ${config.objective}`);
  if (config.lesson) ui.toast(config.lesson.intro + ' ' + config.lesson.prompt);
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
  ui.announce('Paused.');
  Audio.playEvent('click');
}

function resumeRun() {
  if (app.machine !== 'paused') return;
  // while-you-were-away summary
  if (app.hiddenSnapshot && app.hiddenAt) {
    const awaySec = Math.round((Date.now() - app.hiddenAt) / 1000);
    const sum = Session.awaySummary(app.hiddenSnapshot.state, app.sess.state);
    const txt = awaySec >= 5
      ? `While you were away (${awaySec}s): the run was paused - nothing moved. Score unchanged (${sum.scoreDelta >= 0 ? '+' : ''}${sum.scoreDelta}).`
      : '';
    ui.setAwaySummary(txt);
    if (txt) ui.announce(txt);
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
      ui.toast(`Move limit reached (${app.run.constraint.limit}). No inputs left.`, true);
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
    case 'lane-edge': return 'Already at the edge lane.';
    case 'airborne': return 'Already in the air.';
    case 'sliding': return 'Already sliding.';
    case 'branch-choice-required': return 'A fork is ahead - choose left (safe) or right (risk).';
    case 'mechanic-disabled': return 'That move is not part of this stage.';
    case 'session-over': return 'The run is over.';
    default: return `Cannot ${action} here (${reason}).`;
  }
}

function showHint() {
  if (!app.sess) return;
  const s = app.sess.state;
  const ci = Math.floor(s.distUnits / UNITS_PER_CELL);
  const cells = s.course.cells;
  if (activeBranch(s) >= 0) {
    ui.toast('Fork ahead: LEFT for the safe route, RIGHT for double-fragment risk route.');
    return;
  }
  for (let i = ci + 1; i <= Math.min(ci + 5, cells.length - 1); i++) {
    const c = cells[i];
    if (c.gap) { ui.toast(`Gap in ${i - ci} - jump (UP) just before it.`); return; }
    if (c.low) { ui.toast(`Low barrier in ${i - ci} - slide (DOWN) under it.`); return; }
    if (c.relicLane >= 0) { ui.toast(`Fragment in ${i - ci}, ${['left', 'center', 'right'][c.relicLane]} lane.`); return; }
  }
  ui.toast('Path is clear. Keep running.');
}

function practiceUndo() {
  if (!app.run || app.run.mode !== 'practice' || app.machine !== 'active') {
    ui.toast('Undo is only available in Practice.', true);
    return;
  }
  const snap = app.undoRing.pop();
  if (!snap) { ui.toast('Nothing to undo yet.', true); return; }
  app.sess = Session.restore(snap);
  ui.toast('Undid a few seconds.');
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
        ui.announce(`Hit a barrier. ${s.hearts} hearts left.`, true);
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

  // progress + achievements
  const earned = [];
  const grant = (key) => {
    if (Store.unlockAchievement(app.profile, key)) {
      const meta = Store.ACHIEVEMENTS.find((a) => a.id === key);
      earned.push(meta);
      Platform.unlockAchievementRemote(key).catch(() => {});
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
    progress = `Stage ${run.stage.index + 1} of ${Content.STAGES.length}. Unlocked through stage ${app.profile.journey.unlocked}.`;
  } else if (run.mode === 'learn') {
    if (terminal === 'finished') {
      app.profile.tutorials[run.lesson.id] = true;
      const all = Content.LESSONS.every((l) => app.profile.tutorials[l.id]);
      if (all) grant('mechanic-mastery');
      canNext = Content.LESSONS.indexOf(run.lesson) + 1 < Content.LESSONS.length;
      progress = 'Lesson complete.';
    }
  } else if (run.mode === 'daily') {
    const key = 'daily-' + app.daily.dateKey;
    app.profile.totals.dailies[app.daily.dateKey] = Math.max(bd.total, app.profile.totals.dailies[app.daily.dateKey] || 0);
    if (Object.keys(app.profile.totals.dailies).length >= 3) grant('daily-streak-3');
    const best = app.profile.bestScores[key];
    if (!best || bd.total > best.total) {
      app.profile.bestScores[key] = { total: bd.total, breakdown: bd, date: app.daily.dateKey };
      progress = best ? `New daily best (was ${best.total}).` : 'First daily score recorded.';
    }
  } else if (run.mode === 'practice') {
    progress = 'Practice run - unranked.';
  } else if (run.mode === 'challenge') {
    progress = terminal === 'finished' ? 'Constraint held. Well done.' : 'The course won this time.';
  }

  Store.saveProfile(app.profile);

  // ranked submission (validated server-side by replay)
  if (run.ranked) {
    const env = Session.replayEnvelope(sess);
    Platform.submitScore({
      ruleset: env.schemaVersion,
      contentVersion: env.contentVersion,
      seed: env.seed,
      genOpts: env.genOpts,
      assists: assistsUsed(),
      durationTicks: s.tick,
      commands: env.commands,
      scoreBreakdown: bd,
      board: run.mode === 'daily' ? 'daily' : 'global',
      player: 'runner-' + (app.profile.totals.runs % 1000),
    }).then((r) => {
      if (r && r.accepted) ui.toast('Score accepted by the lodge board.');
    }).catch((e) => {
      if (!e.offline) ui.toast('Score rejected: ' + e.message, true);
    });
  }

  const headline = {
    finished: 'You reached the relic gate!',
    crashed: 'The vines brought you down.',
    fell: 'You fell into the ruins.',
    'time-up': 'The light faded - time up.',
  }[terminal] || 'Run over';

  setMachine('results', terminal);
  ui.setProgress(progress || idleProgressText());
  ui.renderResults({ headline: `${headline} - ${bd.total} pts`, breakdown: bd, progress, achievements: earned, canNext });
  ui.show('results');
  ui.announce(`${headline}. Final score ${bd.total}.`, true);
  ui.renderJourney(app.profile, (st) => startRun(stageRunConfig(st)));
  ui.renderLearn(app.profile, startLesson);
}

function assistsUsed() {
  const a = app.profile.settings.accessibility;
  return { timingAssist: !!a.timingAssist, reducedMotion: !!a.reducedMotion };
}

// --- settings ------------------------------------------------------------------------------
function onSettingsChanged(settings) {
  Store.saveProfile(app.profile);
  applyAudioSettings();
  if (app.renderer) {
    Render.setQuality(app.renderer, settings.graphics.quality);
    Render.setReducedMotion(app.renderer, settings.accessibility.reducedMotion);
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
const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'jump', KeyW: 'jump', Space: 'jump',
  ArrowDown: 'slide', KeyS: 'slide',
};

document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  Audio.ensureAudio();
  if (KEYMAP[e.code]) {
    if (app.machine === 'active') { e.preventDefault(); command(KEYMAP[e.code]); }
    return;
  }
  switch (e.code) {
    case 'Escape':
      if (app.machine === 'active') pauseRun('esc');
      else if (app.machine === 'paused') resumeRun();
      else if (ui.currentScreen && ui.currentScreen !== 'title') ui.show(ui.backTarget === 'pause' && app.sess ? 'pause' : 'title');
      break;
    case 'KeyU': practiceUndo(); break;
    case 'KeyH': showHint(); break;
    case 'KeyC':
      if (app.renderer && app.sess) {
        const s = app.sess.state;
        app.renderer.camPos.set(0, Render.CAMERA.height, (s.distUnits / UNITS_PER_CELL) * 2 - Render.CAMERA.back);
        ui.toast('Camera recentered.');
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

// clock display (server-synced when online)
setInterval(() => {
  const d = new Date(Platform.isServerOnline() ? Platform.serverNow() : Date.now());
  ui.setClock(d.toISOString().slice(11, 19) + ' UTC');
}, 1000);

// start the app
boot();

// debug/test handle
window.__rr = app;

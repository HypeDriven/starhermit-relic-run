// Relic Run - DOM shell: screens, HUD, live regions, settings binding.
// The canvas is never the only UI: every state change is mirrored to the DOM.
import { THEMES, STAGES, LESSONS, CHALLENGES, PRACTICE_DIFFICULTIES } from './content.js';
import { ACHIEVEMENTS } from './store.js';

const $ = (id) => document.getElementById(id);

const SCREENS = ['title', 'mode', 'journey', 'learn', 'practice', 'challenge', 'daily', 'pause', 'results', 'help', 'settings', 'friends', 'profile'];

export const KEY_MAPPINGS = [
  { keys: 'ArrowLeft / A', action: 'Turn left / move to left lane (safe route at forks)' },
  { keys: 'ArrowRight / D', action: 'Turn right / move to right lane (risk route at forks)' },
  { keys: 'ArrowUp / W / Space', action: 'Jump' },
  { keys: 'ArrowDown / S', action: 'Slide' },
  { keys: 'Enter', action: 'Confirm' },
  { keys: 'Escape', action: 'Pause / cancel' },
  { keys: 'U', action: 'Undo (practice only)' },
  { keys: 'H', action: 'Hint' },
  { keys: 'C', action: 'Reset camera' },
];

export function createUI(handlers) {
  const ui = { handlers, currentScreen: 'title', backTarget: 'title' };

  // --- screens ---------------------------------------------------------------
  ui.show = (name) => {
    for (const s of SCREENS) {
      const el = $('screen-' + s);
      if (el) el.classList.toggle('active', s === name);
    }
    ui.currentScreen = name;
    const inRun = name === null;
    $('hud').classList.toggle('active', inRun);
    $('tray').classList.toggle('active', inRun);
    $('mirror').classList.toggle('active', inRun);
    if (name) {
      const el = $('screen-' + name);
      const focusable = el && el.querySelector('button, [tabindex], input, select');
      if (focusable) focusable.focus();
    }
  };
  ui.showPlay = () => {
    ui.show(null);
    // Keyboard focus must leave the button that launched the run: it stays
    // focused otherwise, and Enter would re-trigger it mid-run. The hazard
    // mirror is a non-activating target inside the playfield.
    const mirror = $('mirror');
    if (mirror) mirror.focus();
  };

  // --- announcements -----------------------------------------------------------
  ui.announce = (msg, assertive = false) => {
    const el = assertive ? $('live-assertive') : $('live-polite');
    el.textContent = '';
    // force re-announce
    setTimeout(() => { el.textContent = msg; }, 30);
  };
  let toastTimer = null;
  ui.toast = (msg, invalid = false) => {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('invalid', invalid);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
    if (invalid) ui.announce(msg, true);
  };

  // --- HUD ----------------------------------------------------------------------
  ui.setHUD = ({ objective, score, fragments, hearts, maxHearts, speed }) => {
    $('hud-objective').textContent = objective || '';
    $('hud-score').textContent = String(score);
    $('hud-frag').textContent = String(fragments);
    $('hud-hearts').textContent = 'hearts ' + '●'.repeat(Math.max(0, hearts)) + '○'.repeat(Math.max(0, maxHearts - hearts));
    $('hud-speed').textContent = 'speed ' + (speed / 2).toFixed(1) + ' m/s';
    $('rail-objective').textContent = objective || 'Choose a mode to begin.';
    $('rail-status').textContent = `Score ${score} · Fragments ${fragments} · Hearts ${hearts}/${maxHearts}`;
  };

  ui.setProgress = (txt) => { $('rail-progress').textContent = txt || ''; };

  // Back to the pre-run rail copy when no session is loaded.
  ui.resetRail = () => {
    $('rail-objective').textContent = 'Choose a mode to begin.';
    $('rail-status').textContent = '';
    $('rail-mirror').textContent = '';
    $('mirror').textContent = '';
  };

  // Concise navigable text model of upcoming hazards (canvas mirror).
  ui.updateMirror = (state, UNITS_PER_CELL) => {
    const ci = Math.floor(state.distUnits / UNITS_PER_CELL);
    const parts = [];
    const cells = state.course.cells;
    for (let i = ci + 1; i <= Math.min(ci + 8, cells.length - 1); i++) {
      const c = cells[i];
      const d = i - ci;
      // an already-chosen fork is no longer a decision: don't keep prompting
      if (c.branch) { if (i >= state.branchResolved) parts.push(`fork in ${d} (left=safe, right=risk)`); }
      else if (c.gap) parts.push(`gap in ${d}`);
      else if (c.low) parts.push(`barrier in ${d}`);
      else if (c.relicLane >= 0) parts.push(`fragment in ${d} (${['left', 'center', 'right'][c.relicLane]} lane)`);
    }
    const routeTxt = state.route === 'risk' ? 'On the risk route (x2 fragments). ' : '';
    const txt = parts.length ? routeTxt + 'Ahead: ' + parts.join('; ') : routeTxt + 'Path clear ahead.';
    $('mirror').textContent = txt;
    $('rail-mirror').textContent = txt;
    return txt;
  };

  // --- lists ----------------------------------------------------------------------
  ui.renderJourney = (profile, onStart) => {
    const list = $('journey-list');
    list.textContent = '';
    const unlocked = profile.journey.unlocked;
    let done = 0;
    STAGES.forEach((st, i) => {
      const rec = profile.journey.completed[st.id];
      if (rec && rec.finished) done++;
      const item = document.createElement('div');
      item.className = 'item';
      const info = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = `${i + 1}. ${st.name}`;
      const sub = document.createElement('div');
      sub.className = 'muted';
      const theme = THEMES.find((t) => t.id === st.theme);
      sub.textContent = `${st.difficulty} · ${theme ? theme.name : ''} · par ${st.par.score}${st.mastery ? ' · mastery' : ''}${st.tutorial ? ' · introduces ' + st.tutorial : ''}`;
      info.append(name, sub);
      const right = document.createElement('div');
      right.className = 'row';
      if (rec && rec.finished) {
        const b = document.createElement('span');
        b.className = 'badge done';
        b.textContent = `done · ${rec.score}`;
        right.append(b);
      }
      const btn = document.createElement('button');
      const locked = i + 1 > unlocked;
      btn.disabled = locked;
      btn.textContent = locked ? 'Locked' : 'Run';
      btn.className = locked ? 'secondary' : '';
      btn.addEventListener('click', () => onStart(st));
      right.append(btn);
      item.append(info, right);
      list.append(item);
    });
    $('journey-summary').textContent = `${done} of ${STAGES.length} stages finished. Finish a stage to unlock the next.`;
  };

  ui.renderLearn = (profile, onStart) => {
    const list = $('learn-list');
    list.textContent = '';
    LESSONS.forEach((l) => {
      const item = document.createElement('div');
      item.className = 'item';
      const info = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = l.name;
      const sub = document.createElement('div');
      sub.className = 'muted';
      sub.textContent = l.intro;
      info.append(name, sub);
      const right = document.createElement('div');
      right.className = 'row';
      if (profile.tutorials[l.id]) {
        const b = document.createElement('span');
        b.className = 'badge done';
        b.textContent = 'learned';
        right.append(b);
      }
      const btn = document.createElement('button');
      btn.textContent = 'Start';
      btn.addEventListener('click', () => onStart(l));
      right.append(btn);
      item.append(info, right);
      list.append(item);
    });
  };

  ui.renderPractice = (onStart) => {
    const list = $('practice-list');
    list.textContent = '';
    for (const [key, d] of Object.entries(PRACTICE_DIFFICULTIES)) {
      const item = document.createElement('div');
      item.className = 'item';
      const info = document.createElement('div');
      info.innerHTML = `<div class="name">${d.label}</div><div class="muted">restart &amp; undo allowed · unranked</div>`;
      const btn = document.createElement('button');
      btn.textContent = 'Run';
      btn.addEventListener('click', () => onStart(key));
      item.append(info, btn);
      list.append(item);
    }
  };

  ui.renderChallenges = (onStart) => {
    const list = $('challenge-list');
    list.textContent = '';
    for (const c of CHALLENGES) {
      const item = document.createElement('div');
      item.className = 'item';
      const info = document.createElement('div');
      info.innerHTML = `<div class="name">${c.name}</div><div class="muted">${c.description}</div>`;
      const btn = document.createElement('button');
      btn.textContent = 'Run';
      btn.addEventListener('click', () => onStart(c));
      item.append(info, btn);
      list.append(item);
    }
  };

  ui.renderHelp = () => {
    const list = $('help-cards');
    list.textContent = '';
    for (const m of KEY_MAPPINGS) {
      const item = document.createElement('div');
      item.className = 'item';
      item.innerHTML = `<div class="name">${m.keys}</div><div class="muted">${m.action}</div>`;
      list.append(item);
    }
  };

  ui.renderProfile = (profile) => {
    const stats = $('profile-stats');
    stats.textContent = '';
    const rows = [
      ['Total runs', profile.totals.runs],
      ['Total fragments', profile.totals.fragments],
      ['Stages finished', Object.values(profile.journey.completed).filter((r) => r.finished).length],
      ['Daily days played', Object.keys(profile.totals.dailies).length],
    ];
    for (const [k, v] of rows) {
      const a = document.createElement('div'); a.textContent = k;
      const b = document.createElement('div'); b.textContent = String(v);
      stats.append(a, b);
    }
    const ach = $('profile-achievements');
    ach.textContent = '';
    for (const a of ACHIEVEMENTS) {
      const item = document.createElement('div');
      item.className = 'item';
      const got = !!profile.achievements[a.id];
      item.innerHTML = `<div><div class="name">${a.name}</div><div class="muted">${a.description}</div></div>`;
      const b = document.createElement('span');
      b.className = 'badge' + (got ? ' done' : '');
      b.textContent = got ? 'unlocked' : 'locked';
      item.append(b);
      ach.append(item);
    }
  };

  ui.renderFriends = (profile, online, board) => {
    $('friends-status').textContent = online
      ? 'Connected to the lodge server - showing live board.'
      : 'Offline - showing locally saved comparison data.';
    const list = $('friends-list');
    list.textContent = '';
    const mock = [
      { name: 'You', score: bestTotal(profile) },
      { name: 'Sable Fox', score: Math.max(120, Math.floor(bestTotal(profile) * 1.2)) },
      { name: 'Moth Archivist', score: Math.max(80, Math.floor(bestTotal(profile) * 0.8)) },
      { name: 'Wren', score: Math.max(40, Math.floor(bestTotal(profile) * 0.5)) },
    ].sort((a, b) => b.score - a.score);
    for (const f of mock) list.append(scoreRow(f.name, f.score));
    const bl = $('board-list');
    bl.textContent = '';
    if (board && board.entries && board.entries.length) {
      // player names come from the server: build with text nodes, never innerHTML
      for (const e of board.entries.slice(0, 20)) bl.append(scoreRow(e.player, e.score));
    } else {
      const item = document.createElement('div');
      item.className = 'item';
      item.innerHTML = '<div class="muted">No board data yet. Finish a ranked run while online to post a score.</div>';
      bl.append(item);
    }
  };

  ui.renderResults = ({ headline, breakdown, progress, achievements, canNext }) => {
    $('results-headline').textContent = headline;
    const bd = $('results-breakdown');
    bd.textContent = '';
    const rows = [
      ['Distance', breakdown.distance],
      ['Fragments', breakdown.fragments],
      ['Risk bonus', breakdown.riskBonus],
      ['Set bonus', breakdown.setBonus],
      ['Total', breakdown.total],
    ];
    for (const [k, v] of rows) {
      const a = document.createElement('div'); a.textContent = k;
      const b = document.createElement('div'); b.textContent = String(v);
      bd.append(a, b);
    }
    $('results-progress').textContent = progress || '';
    const ach = $('results-achievements');
    ach.textContent = '';
    for (const a of achievements || []) {
      const d = document.createElement('p');
      d.textContent = `Achievement unlocked: ${a.name}`;
      ach.append(d);
    }
    $('btn-next').disabled = !canNext;
  };

  ui.setAwaySummary = (txt) => { $('away-summary').textContent = txt || ''; };
  ui.setNet = (online) => { $('sb-net').textContent = online ? 'online' : 'offline'; };
  ui.setModeLabel = (t) => { $('sb-mode').textContent = t || ''; };
  ui.setClock = (t) => { $('sb-clock').textContent = t || ''; };
  ui.setCountdown = (t) => {
    const c = $('countdown');
    if (t == null) { c.classList.remove('active'); c.textContent = ''; }
    else { c.classList.add('active'); c.textContent = t; }
  };
  ui.showCompat = (show) => { $('compat').classList.toggle('active', !!show); };
  ui.setDailyInfo = (txt, best) => { $('daily-info').textContent = txt; $('daily-best').textContent = best || ''; };

  // --- static wiring -------------------------------------------------------------
  document.querySelectorAll('[data-nav]').forEach((b) => {
    b.addEventListener('click', () => { handlers.click(); ui.show(b.dataset.nav); });
  });
  // the compat overlay sits above every screen, so its Back button must also
  // dismiss the overlay itself or the menus stay unreachable.
  document.querySelectorAll('#compat [data-nav]').forEach((b) => {
    b.addEventListener('click', () => ui.showCompat(false));
  });
  document.querySelectorAll('[data-nav-back]').forEach((b) => {
    b.addEventListener('click', () => { handlers.click(); ui.show(ui.backTarget); });
  });
  document.querySelectorAll('#tray [data-action], #rail-actions [data-action]').forEach((b) => {
    b.addEventListener('click', () => handlers.action(b.dataset.action));
  });
  $('btn-pause-hud').addEventListener('click', () => handlers.pause());
  $('btn-hint').addEventListener('click', () => handlers.hint());
  $('btn-play').addEventListener('click', () => { handlers.click(); ui.show('mode'); });
  $('btn-daily').addEventListener('click', () => { handlers.click(); handlers.openDaily(); });
  $('btn-journey').addEventListener('click', () => { handlers.click(); ui.show('journey'); });
  $('btn-learn').addEventListener('click', () => { handlers.click(); ui.show('learn'); });
  $('btn-profile').addEventListener('click', () => { handlers.click(); handlers.renderProfile(); ui.show('profile'); });
  $('btn-help').addEventListener('click', () => { handlers.click(); ui.backTarget = 'title'; ui.renderHelp(); ui.show('help'); });
  $('btn-settings').addEventListener('click', () => { handlers.click(); ui.backTarget = 'title'; ui.show('settings'); });
  $('btn-friends').addEventListener('click', () => { handlers.click(); handlers.openFriends(); });
  $('btn-pause-settings').addEventListener('click', () => { handlers.click(); ui.backTarget = 'pause'; ui.show('settings'); });
  $('btn-pause-help').addEventListener('click', () => { handlers.click(); ui.backTarget = 'pause'; ui.renderHelp(); ui.show('help'); });
  document.querySelectorAll('#screen-mode [data-mode]').forEach((b) => {
    b.addEventListener('click', () => {
      handlers.click();
      const mode = b.dataset.mode;
      if (mode === 'daily') handlers.openDaily();
      else ui.show(mode);
    });
  });
  $('btn-resume').addEventListener('click', () => handlers.resume());
  $('btn-leave').addEventListener('click', () => handlers.leave());
  $('btn-retry').addEventListener('click', () => handlers.retry());
  $('btn-next').addEventListener('click', () => handlers.next());
  $('btn-results-home').addEventListener('click', () => { handlers.click(); ui.show('title'); });
  $('btn-daily-start').addEventListener('click', () => handlers.startDaily());
  $('set-tutorial').addEventListener('click', () => { handlers.resetTutorials(); });

  return ui;
}

function scoreRow(name, score) {
  const item = document.createElement('div');
  item.className = 'item';
  const n = document.createElement('div');
  n.className = 'name';
  n.textContent = String(name);
  const s = document.createElement('div');
  s.textContent = String(score);
  item.append(n, s);
  return item;
}

function bestTotal(profile) {
  let best = 0;
  for (const k of Object.keys(profile.bestScores)) best = Math.max(best, profile.bestScores[k].total || 0);
  return best;
}

// --- settings binding ---------------------------------------------------------------
export function bindSettings(settings, onChange) {
  const map = [
    ['set-master', () => settings.audio.master, (v) => { settings.audio.master = +v; }, 'range'],
    ['set-music', () => settings.audio.music, (v) => { settings.audio.music = +v; }, 'range'],
    ['set-effects', () => settings.audio.effects, (v) => { settings.audio.effects = +v; }, 'range'],
    ['set-ambience', () => settings.audio.ambience, (v) => { settings.audio.ambience = +v; }, 'range'],
    ['set-muted', () => settings.audio.muted, (v) => { settings.audio.muted = !!v; }, 'check'],
    ['set-quality', () => settings.graphics.quality, (v) => { settings.graphics.quality = v; }, 'select'],
    ['set-motion', () => settings.accessibility.reducedMotion, (v) => { settings.accessibility.reducedMotion = !!v; settings.graphics.reducedMotion = !!v; }, 'check'],
    ['set-lefthand', () => settings.controls.leftHanded, (v) => { settings.controls.leftHanded = !!v; }, 'check'],
    ['set-hold', () => settings.controls.holdToSlide, (v) => { settings.controls.holdToSlide = !!v; }, 'check'],
    ['set-haptics', () => settings.controls.haptics, (v) => { settings.controls.haptics = !!v; }, 'check'],
    ['set-colorblind', () => settings.accessibility.colorblindPalette, (v) => { settings.accessibility.colorblindPalette = !!v; }, 'check'],
    ['set-contrast', () => settings.accessibility.highContrast, (v) => { settings.accessibility.highContrast = !!v; }, 'check'],
    ['set-largetext', () => settings.accessibility.largeText, (v) => { settings.accessibility.largeText = !!v; }, 'check'],
    ['set-timing', () => settings.accessibility.timingAssist, (v) => { settings.accessibility.timingAssist = !!v; }, 'check'],
  ];
  for (const [id, get, set, kind] of map) {
    const el = $(id);
    if (!el) continue;
    if (kind === 'check') el.checked = !!get();
    else el.value = get();
    el.addEventListener('change', () => {
      set(kind === 'check' ? el.checked : el.value);
      applyA11yClasses(settings);
      onChange(settings);
    });
  }
  applyA11yClasses(settings);
}

function applyA11yClasses(settings) {
  document.documentElement.classList.toggle('high-contrast', !!settings.accessibility.highContrast);
  document.documentElement.classList.toggle('large-text', !!settings.accessibility.largeText);
  document.documentElement.classList.toggle('reduced-motion', !!settings.accessibility.reducedMotion);
  document.body.classList.toggle('left-handed', !!settings.controls.leftHanded);
}

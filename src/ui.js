// Relic Run - DOM shell: screens, HUD, live regions, settings binding.
// The canvas is never the only UI: every state change is mirrored to the DOM.
import { THEMES, STAGES, LESSONS, CHALLENGES, PRACTICE_DIFFICULTIES } from './content.js';
import { ACHIEVEMENTS } from './store.js';
import { shText } from './sh-i18n.js';
import { T, N } from './lang.js';

// Text arguments may be functions so they re-render in a new language.
const txt = (v) => (typeof v === 'function' ? v() : v);

const $ = (id) => document.getElementById(id);
const LANES = [N('left'), N('center'), N('right')];
// Local record keys ('daily-<date>', a stage id, …) as readable names.
function boardName(key) {
  const m = /^daily-(.+)$/.exec(key);
  if (m) return T('Daily {date}', { date: m[1] });
  const st = STAGES.find((x) => x.id === key);
  return st ? T('Journey {stage}', { stage: T(st.name) }) : key;
}

const SCREENS = ['title', 'mode', 'journey', 'learn', 'practice', 'challenge', 'daily', 'pause', 'results', 'help', 'settings', 'friends', 'profile'];

// Help rows: action descriptions; the keys column shows the effective bindings.
export const KEY_MAPPINGS = [
  { action: 'left', label: N('Turn left / move to left lane (safe route at forks)') },
  { action: 'right', label: N('Turn right / move to right lane (risk route at forks)') },
  { action: 'jump', label: N('Jump') },
  { action: 'slide', label: N('Slide') },
  { keys: N('Enter'), label: N('Confirm') },
  { action: 'pause', label: N('Pause / cancel') },
  { action: 'undo', label: N('Undo (practice only)') },
  { action: 'hint', label: N('Hint') },
  { action: 'camera', label: N('Reset camera') },
];

/** Readable name for a KeyboardEvent.code. */
export function keyLabel(code) {
  if (code === 'Space') return T('Space');
  if (code === 'Enter') return T('Enter');
  let m;
  if ((m = /^Key([A-Z])$/.exec(code))) return m[1];
  if ((m = /^Digit(\d)$/.exec(code))) return m[1];
  return code;
}

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
      // preventScroll: on short screens the first control can be the Back button at the bottom;
      // focusing it must not scroll the heading out of view.
      if (focusable) focusable.focus({ preventScroll: true });
      if (el) el.scrollTop = 0;
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
  ui.setHUD = (hud) => {
    ui.lastHUD = hud;
    const { score, fragments, hearts, maxHearts, speed } = hud;
    const objective = txt(hud.objective);
    $('hud-objective').textContent = objective || '';
    $('hud-score').textContent = String(score);
    $('hud-frag').textContent = String(fragments);
    $('hud-hearts').textContent = T('hearts') + ' ' + '●'.repeat(Math.max(0, hearts)) + '○'.repeat(Math.max(0, maxHearts - hearts));
    $('hud-speed').textContent = T('speed {v} m/s', { v: (speed / 2).toFixed(1) });
    $('rail-objective').textContent = objective || T('Choose a mode to begin.');
    $('rail-status').textContent = T('Score {score} · Fragments {fragments} · Hearts {hearts}/{max}', { score, fragments, hearts, max: maxHearts });
  };

  ui.setProgress = (t) => { ui.lastProgress = t; $('rail-progress').textContent = txt(t) || ''; };

  // Back to the pre-run rail copy when no session is loaded.
  ui.resetRail = () => {
    ui.lastHUD = null;
    $('rail-objective').textContent = T('Choose a mode to begin.');
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
      if (c.branch) { if (i >= state.branchResolved) parts.push(T('fork in {n} (left=safe, right=risk)', { n: d })); }
      else if (c.gap) parts.push(T('gap in {n}', { n: d }));
      else if (c.low) parts.push(T('barrier in {n}', { n: d }));
      else if (c.relicLane >= 0) parts.push(T('fragment in {n} ({lane} lane)', { n: d, lane: T(LANES[c.relicLane]) }));
    }
    const routeTxt = state.route === 'risk' ? T('On the risk route (x2 fragments). ') : '';
    const text = parts.length ? routeTxt + T('Ahead: {list}', { list: parts.join('; ') }) : routeTxt + T('Path clear ahead.');
    $('mirror').textContent = text;
    $('rail-mirror').textContent = text;
    return text;
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
      name.textContent = `${i + 1}. ${T(st.name)}`;
      const sub = document.createElement('div');
      sub.className = 'muted';
      const theme = THEMES.find((t) => t.id === st.theme);
      sub.textContent = [T(st.difficulty), theme ? T(theme.name) : '', T('par {n}', { n: st.par.score }),
        st.mastery ? T('mastery') : null, st.tutorial ? T('introduces {mechanic}', { mechanic: T(st.tutorial) }) : null].filter((x) => x != null).join(' · ');
      info.append(name, sub);
      const right = document.createElement('div');
      right.className = 'row';
      if (rec && rec.finished) {
        const b = document.createElement('span');
        b.className = 'badge done';
        b.textContent = T('done · {score}', { score: rec.score });
        right.append(b);
      }
      const btn = document.createElement('button');
      const locked = i + 1 > unlocked;
      btn.disabled = locked;
      btn.textContent = locked ? T('Locked') : T('Run');
      btn.className = locked ? 'secondary' : '';
      btn.addEventListener('click', () => onStart(st));
      right.append(btn);
      item.append(info, right);
      list.append(item);
    });
    $('journey-summary').textContent = T('{done} of {total} stages finished. Finish a stage to unlock the next.', { done, total: STAGES.length });
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
      name.textContent = T(l.name);
      const sub = document.createElement('div');
      sub.className = 'muted';
      sub.textContent = T(l.intro);
      info.append(name, sub);
      const right = document.createElement('div');
      right.className = 'row';
      if (profile.tutorials[l.id]) {
        const b = document.createElement('span');
        b.className = 'badge done';
        b.textContent = T('learned');
        right.append(b);
      }
      const btn = document.createElement('button');
      btn.textContent = T('Start');
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
      info.innerHTML = `<div class="name"></div><div class="muted"></div>`;
      info.firstChild.textContent = T(d.label);
      info.lastChild.textContent = T('restart & undo allowed · unranked');
      const btn = document.createElement('button');
      btn.textContent = T('Run');
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
      info.innerHTML = `<div class="name"></div><div class="muted"></div>`;
      info.firstChild.textContent = T(c.name);
      info.lastChild.textContent = T(c.description);
      const btn = document.createElement('button');
      btn.textContent = T('Run');
      btn.addEventListener('click', () => onStart(c));
      item.append(info, btn);
      list.append(item);
    }
  };

  ui.renderHelp = () => {
    const list = $('help-cards');
    list.textContent = '';
    const b = handlers.bindings ? handlers.bindings() : {};
    for (const m of KEY_MAPPINGS) {
      const item = document.createElement('div');
      item.className = 'item';
      const keys = document.createElement('div');
      keys.className = 'name';
      keys.textContent = m.action ? (b[m.action] || []).map(keyLabel).join(' / ') : T(m.keys);
      const label = document.createElement('div');
      label.className = 'muted';
      label.textContent = T(m.label);
      item.append(keys, label);
      list.append(item);
    }
  };

  ui.renderProfile = (profile) => {
    const stats = $('profile-stats');
    stats.textContent = '';
    const rows = [
      [T('Total runs'), profile.totals.runs],
      [T('Total fragments'), profile.totals.fragments],
      [T('Stages finished'), Object.values(profile.journey.completed).filter((r) => r.finished).length],
      [T('Daily days played'), Object.keys(profile.totals.dailies).length],
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
      item.innerHTML = `<div><div class="name"></div><div class="muted"></div></div>`;
      item.querySelector('.name').textContent = T(a.name);
      item.querySelector('.muted').textContent = T(a.description);
      const b = document.createElement('span');
      b.className = 'badge' + (got ? ' done' : '');
      b.textContent = got ? T('unlocked') : T('locked');
      item.append(b);
      ach.append(item);
    }
  };

  ui.renderFriends = (profile, online, board) => {
    ui.lastFriends = [profile, online, board];
    $('friends-status').textContent = online
      ? T('Connected - live leaderboard below your personal records.')
      : T('Offline - showing locally saved records.');
    const list = $('friends-list');
    list.textContent = '';
    // local records only: this profile's bests, no fabricated rivals
    const locals = Object.entries(profile.bestScores)
      .map(([k, v]) => ({ name: boardName(k), score: v.total }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    if (!locals.length) {
      const item = document.createElement('div');
      item.className = 'item';
      item.innerHTML = '<div class="muted"></div>';
      item.firstChild.textContent = T('No personal records yet. Finish a ranked run to set one.');
      list.append(item);
    }
    for (const r of locals) list.append(scoreRow(r.name, r.score));
    const bl = $('board-list');
    bl.textContent = '';
    if (board && board.entries && board.entries.length) {
      // display names come from the platform profile helper: text nodes, never innerHTML
      for (const e of board.entries.slice(0, 20)) bl.append(scoreRow(e.player, e.score));
    } else {
      const item = document.createElement('div');
      item.className = 'item';
      item.innerHTML = '<div class="muted"></div>';
      item.firstChild.textContent = T('No live board data. Personal bests stay in your profile and cloud save.');
      bl.append(item);
    }
  };

  ui.renderResults = (args) => {
    ui.lastResults = args;
    const { breakdown, achievements, canNext } = args;
    const progress = txt(args.progress);
    $('results-headline').textContent = txt(args.headline);
    const bd = $('results-breakdown');
    bd.textContent = '';
    const rows = [
      [T('Distance'), breakdown.distance],
      [T('Fragments'), breakdown.fragments],
      [T('Risk bonus'), breakdown.riskBonus],
      [T('Set bonus'), breakdown.setBonus],
      [T('Total'), breakdown.total],
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
      d.textContent = T('Achievement unlocked: {name}', { name: T(a.name) });
      ach.append(d);
    }
    $('btn-next').disabled = !canNext;
  };

  ui.setAwaySummary = (t) => { ui.lastAway = t; $('away-summary').textContent = txt(t) || ''; };
  ui.setAccount = ({ signedIn, canSignIn }) => {
    $('btn-signin').hidden = signedIn || !canSignIn;
    $('btn-invite').hidden = !signedIn;
  };
  ui.setNet = (online) => { ui.lastNet = online; $('sb-net').textContent = online ? T('online') : T('offline'); };
  ui.setName = (t) => { $('sb-name').textContent = t || ''; };
  const SYNC_LABELS = { synced: N('progress synced'), saving: N('saving…'), offline: N('local progress') };
  ui.setSync = (s) => { ui.lastSync = s; $('sb-sync').textContent = SYNC_LABELS[s] ? T(SYNC_LABELS[s]) : ''; };
  ui.setModeLabel = (t) => { ui.lastMode = t; $('sb-mode').textContent = txt(t) || ''; };
  ui.setClock = (t) => { $('sb-clock').textContent = t || ''; };
  ui.setCountdown = (t) => {
    const c = $('countdown');
    if (t == null) { c.classList.remove('active'); c.textContent = ''; }
    else { c.classList.add('active'); c.textContent = t; }
  };
  ui.showCompat = (show) => { $('compat').classList.toggle('active', !!show); };
  ui.setDailyInfo = (info, best) => { ui.lastDaily = [info, best]; $('daily-info').textContent = txt(info); $('daily-best').textContent = txt(best) || ''; };

  /** Language changed: re-render everything written from code (static markup is handled by src/i18n.js). */
  ui.relabel = () => {
    $('btn-signin').textContent = shText('signIn');
    $('btn-invite').textContent = shText('invite');
    if (ui.lastHUD) ui.setHUD(ui.lastHUD); else $('rail-objective').textContent = T('Choose a mode to begin.');
    if (ui.lastProgress !== undefined) ui.setProgress(ui.lastProgress);
    if (ui.lastAway !== undefined) ui.setAwaySummary(ui.lastAway);
    if (ui.lastNet !== undefined) ui.setNet(ui.lastNet);
    if (ui.lastSync !== undefined) ui.setSync(ui.lastSync);
    if (ui.lastMode !== undefined) ui.setModeLabel(ui.lastMode);
    if (ui.lastDaily) ui.setDailyInfo(...ui.lastDaily);
    if (ui.lastResults) ui.renderResults(ui.lastResults);
    if (ui.lastFriends) ui.renderFriends(...ui.lastFriends);
    ui.renderHelp();
  };

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
  $('btn-signin').textContent = shText('signIn');
  $('btn-invite').textContent = shText('invite');
  $('btn-signin').addEventListener('click', () => { handlers.click(); handlers.signIn(); });
  $('btn-invite').addEventListener('click', () => { handlers.click(); handlers.invite(); });
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

// --- settings binding ---------------------------------------------------------------
export function bindSettings(settings, onChange) {
  const map = [
    ['set-master', () => settings.audio.master, (v) => { settings.audio.master = +v; }, 'range'],
    ['set-music', () => settings.audio.music, (v) => { settings.audio.music = +v; }, 'range'],
    ['set-effects', () => settings.audio.effects, (v) => { settings.audio.effects = +v; }, 'range'],
    ['set-ambience', () => settings.audio.ambience, (v) => { settings.audio.ambience = +v; }, 'range'],
    ['set-muted', () => settings.audio.muted, (v) => { settings.audio.muted = !!v; }, 'check'],
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

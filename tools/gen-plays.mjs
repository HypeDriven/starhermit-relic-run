// Writes the native play scripts (tests/native/*.play) from bot plans made with
// the real rules (src/rules.js, src/content.js): a policy that takes the safe
// route at forks, jumps gaps and slides under barriers one or two cells ahead
// (content.js's validator policy) and steers into relics when the way is clear,
// never acting on two ticks in a row. The plan's commands become key presses
// (or touches) on exact frames:
//   - the render check plays one fixed step a frame, and a rules tick takes two
//     steps (60 Hz steps, 30 ticks a second);
//   - after the frame a run starts on (the click that starts it), the
//     countdown takes 144 steps, so tick k happens on frame 144 + 2k;
//   - a command applies at the start of a step, so a press on frame
//     145 + 2t (an odd frame: the same tick whether the key reaches the game
//     before or after that frame's step) acts before tick t + 1, as
//     applyCommand(state at tick t) then step() does in the plan;
//   - a `touch` line is two frames (down, then lift: the button acts in the
//     lift frame's UI build, so its command applies a step later): on frame
//     143 + 2t.
// Lines last: `key CODE 1` and `save` one frame, `frames N` N + 1.
//   node tools/gen-plays.mjs            (rewrites tests/native/*.play)
// tests/native.mjs imports dailyPlay() to plan today's Daily at test time.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createState, applyCommand, step, legalActions, activeBranch, scoreBreakdown, UNITS_PER_CELL } from '../src/rules.js';
import { STAGES, LESSONS, CHALLENGES, dailyContent } from '../src/content.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const COUNTDOWN = 144;
const KEYS = { left: 'KeyA', right: 'KeyD', jump: 'KeyW', slide: 'KeyS' };

function policy(s, collect) {
  const legal = legalActions(s);
  if (!legal.length) return null;
  if (activeBranch(s) >= 0) return 'left';
  const cells = s.course.cells;
  const ci = Math.floor(s.distUnits / UNITS_PER_CELL);
  for (let d = 1; d <= 2; d++) {
    const c = cells[Math.min(ci + d, cells.length - 1)];
    if (c.gap && legal.includes('jump')) return 'jump';
    if (c.low && legal.includes('slide')) return 'slide';
  }
  if (!collect) return null;
  for (let d = 1; d <= 3; d++) if (cells[Math.min(ci + d, cells.length - 1)].gap || cells[Math.min(ci + d, cells.length - 1)].low) return null;
  for (let d = 1; d <= 3; d++) {
    const c = cells[Math.min(ci + d, cells.length - 1)];
    if (c.relicLane >= 0 && c.relicLane !== s.lane) return c.relicLane < s.lane ? 'left' : 'right';
    if (c.relicLane === s.lane) return null;
  }
  return null;
}

/** The bot's run: commands as { t (the tick they follow), action }, the end and the score. */
export function plan(seed, genOpts, { collect = true, maxMoves = Infinity } = {}) {
  const s = createState(seed, genOpts);
  const cmds = [];
  let last = -10;
  while (!s.terminal && s.tick < 30 * 600) {
    if (s.tick - last >= 2 && cmds.length < maxMoves) {
      const a = policy(s, collect);
      if (a && applyCommand(s, a).ok) { cmds.push({ t: s.tick, action: a }); last = s.tick; }
    }
    step(s);
  }
  return { cmds, terminal: s.terminal, score: scoreBreakdown(s), fragments: s.fragments };
}

/** Script lines from the frame after the starting click: keys (or touches on the tray) on their frames. */
function runLines(p, { touch = null } = {}) {
  const out = [];
  let at = 1; // the next line's first frame
  for (const c of p.cmds) {
    const frame = touch ? COUNTDOWN - 1 + 2 * c.t : COUNTDOWN + 1 + 2 * c.t;
    if (frame < at) throw new Error(`command at tick ${c.t} too close to the one before`);
    if (frame - at >= 1) out.push(`frames ${frame - at - 1}`);
    if (touch) { out.push(`touch ${touch[c.action]}`); at = frame + 2; }
    else { out.push(`key ${KEYS[c.action]} 1`); at = frame + 1; }
  }
  return out;
}
function header(text) { return text.map((l) => `# ${l}`); }
function checkFinish(name, p) {
  if (p.terminal !== 'finished') throw new Error(`${name}: the bot did not finish (${p.terminal})`);
}

function journeyPlay() {
  const lines = header([
    'Journey stages 1 and 2 played to the relic gate by the bot (tools/gen-plays.mjs; generated: do not edit),',
    'by keys on a desktop window with the rails; Next recommended starts stage 2; the list then shows 3 unlocked.',
  ]);
  lines.push('# viewport 1366x768@1', 'until 300 Relic Run', 'frames 30', 'save title', 'click =Play', 'until 60 Choose a mode', 'frames 10', 'click Open — Journey',
    'until 60 stages finished', 'frames 10', 'save journey-list');
  const p1 = plan(STAGES[0].seed, STAGES[0].genOpts), p2 = plan(STAGES[1].seed, STAGES[1].genOpts);
  checkFinish('stage 1', p1); checkFinish('stage 2', p2);
  lines.push('click Run — 1. First Steps', ...withSave(runLines(p1), 'stage-1-run'), 'until 1200 Run complete', 'frames 20',
    'expect You reached the relic gate!', `expect =${p1.score.total}`, 'save stage-1', 'click =Next recommended', ...runLines(p2), 'until 1200 Run complete', 'frames 20',
    'expect You reached the relic gate!', `expect =${p2.score.total}`, 'save stage-2', 'click =Back to title', 'until 60 Daily Challenge', 'frames 10', 'click =Journey',
    'until 60 2 of 40 stages finished', 'frames 10', 'expect Run — 3. Cracked Flagstones', 'save journey-unlocked');
  return lines;
}

function lessonsPhonePlay() {
  const lines = header([
    'Learn on a phone (390 × 844 at DPR 3) by touch (tools/gen-plays.mjs; generated: do not edit): Choosing the Path',
    'with the tray buttons (◀ Left at the fork), then Leaping the Gaps with Jump ▲ taps, to their lesson results.',
  ]);
  lines.push('# viewport 390x844@3', 'until 300 Relic Run', 'frames 30', 'save title', 'touch =Learn', 'until 60 Learn the ruins', 'frames 10', 'save learn');
  const tray = { left: '=◀ Left', right: '=Right ▶', jump: '=Jump ▲', slide: '=Slide ▼' };
  const l1 = plan(LESSONS[0].seed, LESSONS[0].genOpts, { collect: false });
  const l2 = plan(LESSONS[1].seed, LESSONS[1].genOpts, { collect: false });
  checkFinish('lesson 1', l1); checkFinish('lesson 2', l2);
  lines.push('touch Start — Choosing the Path', ...withSave(runLines(l1, { touch: tray }), 'lesson-run'));
  lines.push('until 900 Run complete', 'frames 20', 'expect Lesson complete.', 'save lesson-1', 'touch =Next recommended', ...runLines(l2, { touch: tray }),
    'until 900 Run complete', 'frames 20', 'expect Lesson complete.', `expect =${l2.score.total}`, 'save lesson-2');
  return lines;
}
/** A `save` inside the run's first long wait (`frames N` = frames a, save, frames N - a - 2: the same frames in all). */
function withSave(lines, name) {
  const i = lines.findIndex((l) => /^frames (\d+)$/.test(l) && Number(l.slice(7)) >= 200);
  if (i < 0) return [...lines, `save ${name}`];
  const n = Number(lines[i].slice(7));
  return [...lines.slice(0, i), 'frames 180', `save ${name}`, `frames ${n - 182}`, ...lines.slice(i + 1)];
}

function challengeLandscapePlay() {
  const c = CHALLENGES[1]; // Swift Relic: a faster course against the clock
  const p = plan(c.seed, c.genOpts);
  checkFinish('challenge', p);
  const lines = header([
    'Challenge "Swift Relic" on a phone held sideways (844 × 390 at DPR 3) by keys (tools/gen-plays.mjs; generated: do',
    'not edit), with a pause by Escape and Resume on the way, to its results.',
  ]);
  lines.push('# viewport 844x390@3', 'until 300 Relic Run', 'frames 30', 'click =Play', 'until 60 Choose a mode', 'frames 10', 'click Open — Challenge', 'until 60 Challenges', 'frames 10',
    'save challenges', 'click Run — Swift Relic', ...withSave(runLines(p), 'challenge-run'), 'until 1500 Run complete', 'frames 20', 'expect Constraint held. Well done.', `expect =${p.score.total}`, 'save challenge');
  return lines;
}

function menusPlay() {
  return [
    ...header([
      'Menus on a desktop window (tools/gen-plays.mjs; generated: do not edit): Help with the effective keys, Settings',
      '(the colorblind-safe palette on), Profile, Friends & scores, the Daily screen, a Practice run paused by Escape,',
      'Resume, the Hint key, then left to end in the results, and back to the title.',
    ]),
    'until 300 Relic Run', 'frames 30', 'click =Help', 'until 60 How to play', 'frames 10', 'expect ArrowLeft / A', 'save help', 'click =Back', 'until 60 Daily Challenge', 'frames 10',
    'click =Settings', 'until 60 Open Options', 'frames 10', 'click =Colorblind-safe palette', 'frames 10', 'save settings', 'click =Back', 'until 60 Daily Challenge', 'frames 10',
    'click =Profile', 'until 60 Student of the Ruins', 'frames 10', 'save profile', 'click =Back', 'until 60 Daily Challenge', 'frames 10',
    'click =Friends', 'until 60 Friends & scores', 'frames 10', 'expect Offline - showing locally saved records.', 'save friends', 'click =Back', 'until 60 Daily Challenge', 'frames 10',
    'click =Daily Challenge', 'until 60 Same course for every player today', 'frames 10', 'save daily', 'click =Back', 'until 60 Choose a mode', 'frames 10',
    'click Open — Practice', 'until 60 Unranked. Restart freely', 'frames 10', 'click Run — Easy', 'frames 148', 'key KeyH 1', 'frames 1', 'save practice-hint',
    'key Escape 1', 'until 60 Leave run', 'frames 10', 'save paused', 'click =Resume', 'until 2400 Run complete', 'frames 20', 'expect =Practice run - unranked.', 'save practice-results',
    'click =Back to title', 'until 60 Daily Challenge', 'frames 10', 'click =Profile', 'until 60 Total runs', 'frames 10', 'save profile-after',
  ];
}

/** Today's Daily (a date-derived course), planned now. */
export function dailyPlay(nowMs) {
  const d = dailyContent(new Date(nowMs).toISOString().slice(0, 10));
  const p = plan(d.seed, d.genOpts);
  checkFinish(`daily ${d.dateKey}`, p);
  return [
    ...header([`Today's Daily (${d.dateKey}) played by the bot (tools/gen-plays.mjs dailyPlay, planned by tests/native.mjs at test time).`]),
    'until 300 Relic Run', 'frames 30', 'click =Daily Challenge', 'until 60 Same course for every player today', 'frames 10', "click =Run today's seed", ...runLines(p),
    'until 2400 Run complete', 'frames 20', 'expect You reached the relic gate!', `expect =${p.score.total}`, 'save daily',
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = join(root, 'tests', 'native');
  const files = { 'journey.play': journeyPlay(), 'lessons-phone.play': lessonsPhonePlay(), 'challenge-landscape.play': challengeLandscapePlay(), 'menus.play': menusPlay() };
  for (const [name, lines] of Object.entries(files)) {
    writeFileSync(join(out, name), lines.join('\n') + '\n');
    console.log(`tests/native/${name}: ${lines.length} lines`);
  }
}

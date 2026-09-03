// Relic Run - versioned content registry: themes, journey stages, lessons,
// daily seeds, challenges, and the offline content validator.
import { createState, legalActions, applyCommand, step, activeBranch, defaultGenOpts, hashString } from './rules.js';

export const CONTENT_VERSION = 1;

// --- visual themes -------------------------------------------------------------
export const THEMES = [
  {
    id: 'emerald-overgrowth', name: 'Emerald Overgrowth',
    sky: 0x9fc98f, fog: 0x86b487, fogDensity: 0.020,
    stone: 0x8f9778, stoneDark: 0x6b7357, foliage: 0x2f7a3d, foliageAlt: 0x57a047,
    accent: 0xe8c15a, relic: 0x7fe3c0,
  },
  {
    id: 'sunstone-court', name: 'Sunstone Court',
    sky: 0xf2c98a, fog: 0xe0b483, fogDensity: 0.016,
    stone: 0xc9a86e, stoneDark: 0x9a7c4e, foliage: 0x6d8f3a, foliageAlt: 0x97a94b,
    accent: 0xfff0b8, relic: 0xffb347,
  },
  {
    id: 'moss-cistern', name: 'Moss Cistern',
    sky: 0x7fa8a0, fog: 0x6f9a92, fogDensity: 0.026,
    stone: 0x6f8478, stoneDark: 0x51655b, foliage: 0x3c6b4f, foliageAlt: 0x5b8a5e,
    accent: 0xbfe3d0, relic: 0x66e0d0,
  },
  {
    id: 'rootbound-vault', name: 'Rootbound Vault',
    sky: 0x5d5a49, fog: 0x4c4a3c, fogDensity: 0.030,
    stone: 0x7a6f58, stoneDark: 0x574e3d, foliage: 0x4a5d2e, foliageAlt: 0x6b7a3a,
    accent: 0xd9b36a, relic: 0xe0a84f,
  },
  {
    id: 'dusk-canopy', name: 'Dusk Canopy',
    sky: 0x4a4468, fog: 0x3d3854, fogDensity: 0.024,
    stone: 0x6a6280, stoneDark: 0x4c4660, foliage: 0x2e4a4a, foliageAlt: 0x3f6a5a,
    accent: 0xc9a8ff, relic: 0xa8e0ff,
  },
];

// --- Journey: 40 stages from authored parameter tables -------------------------
// Difficulty curve: length, hazard rates, speed, branches rise in bands of 8.
// Stages 1-4 are tutorial-flagged (one mechanic each), 8/16/24/32/40 are
// mastery stages combining everything.

function bandParams(band) {
  return {
    length: 140 + band * 45,
    speed: 10 + band * 2,
    gapRate: 0.03 + band * 0.012,
    lowRate: 0.04 + band * 0.014,
    relicRate: 0.40 - band * 0.02,
    branchCount: 2 + band,
    riskGapRate: 0.07 + band * 0.015,
    riskLowRate: 0.08 + band * 0.015,
    timeLimitTicks: 30 * (150 - band * 10),
  };
}

const STAGE_NAMES = [
  'First Steps', 'The Old Causeway', 'Cracked Flagstones', 'Vine Gate', 'Sunken Plaza',
  'Fern Gallery', 'Broken Colonnade', 'Mastery: Roots', 'Twin Forks', 'Mossy Steps',
  'Sunken Court', 'Collapsed Arch', 'Ivy Spiral', 'Root Maze', 'Overgrown Walk', 'Mastery: Stone',
  'Silent Cistern', 'Dripping Vault', 'Flooded Passage', 'Echo Hall', 'Green Descent', 'Pillar Row',
  'Hidden Alcove', 'Mastery: Water', 'Canopy Road', 'Dusk Terrace', 'Shadow Fork', 'Hollow Shrine',
  'Winding Boughs', 'Thorn Bridge', 'Sunken Reliquary', 'Mastery: Canopy', 'Deep Vault',
  'Root Cathedral', 'Fallen King\'s Walk', 'Emerald Descent', 'Last Causeway', 'Ancient Heart',
  'Overgrown Throne', 'Mastery: The Relic',
];

function buildStages() {
  const stages = [];
  for (let i = 0; i < 40; i++) {
    const band = Math.floor(i / 8); // 0..4
    const p = bandParams(band);
    const mastery = (i + 1) % 8 === 0;
    const tutorial = i < 4;
    const mechanics = { turn: true, jump: true, slide: true, collect: true };
    let tutorialFlag = null;
    if (i === 0) { mechanics.slide = false; mechanics.jump = false; tutorialFlag = 'turn'; }
    if (i === 1) { mechanics.slide = false; tutorialFlag = 'jump'; }
    if (i === 2) { tutorialFlag = 'slide'; }
    if (i === 3) { tutorialFlag = 'collect'; }
    if (mastery) { p.gapRate += 0.02; p.lowRate += 0.02; p.branchCount += 1; }
    const seed = (hashString(`relic-run-stage-${i + 1}`) ^ 0x51a6e0) >>> 0;
    stages.push({
      id: `journey-${String(i + 1).padStart(2, '0')}`,
      index: i,
      name: STAGE_NAMES[i],
      seed,
      genOpts: { ...p, mechanics },
      goals: { finish: true, fragments: 3 + band * 2 },
      par: { score: Math.floor(p.length * 1.6), ticks: Math.ceil((p.length * 24) / p.speed) },
      mastery,
      tutorial: tutorialFlag,
      theme: THEMES[i % THEMES.length].id,
      ranked: true,
      difficulty: ['easy', 'easy', 'medium', 'medium', 'hard'][band],
    });
  }
  return stages;
}

export const STAGES = buildStages();

export function getStage(id) {
  return STAGES.find((s) => s.id === id) || null;
}

// --- Learn mode: one mechanic per lesson, must be performed --------------------
export const LESSONS = [
  {
    id: 'learn-turn', name: 'Choosing the Path', mechanic: 'turn',
    intro: 'The ruins fork ahead. Turn LEFT for the safe route, RIGHT for the risky one (relics count double).',
    prompt: 'When you reach the fork marker, press LEFT or RIGHT to choose your route.',
    requiredAction: 'left',
    seed: (hashString('lesson-turn') ^ 0x1e550) >>> 0,
    genOpts: {
      length: 90, speed: 9, gapRate: 0, lowRate: 0, relicRate: 0.2,
      branchCount: 1, riskGapRate: 0, riskLowRate: 0, timeLimitTicks: 30 * 90,
      mechanics: { turn: true, jump: false, slide: false, collect: true },
    },
    goalText: 'Choose a route at the fork, then run to the end.',
  },
  {
    id: 'learn-jump', name: 'Leaping the Gaps', mechanic: 'jump',
    intro: 'Some stones have fallen away. Jump to clear the gaps - falling in ends the run.',
    prompt: 'Press UP (or swipe up) just before a gap to jump over it.',
    requiredAction: 'jump',
    seed: (hashString('lesson-jump') ^ 0x2ab1) >>> 0,
    genOpts: {
      length: 110, speed: 9, gapRate: 0.06, lowRate: 0, relicRate: 0.2,
      branchCount: 0, timeLimitTicks: 30 * 90,
      mechanics: { turn: false, jump: true, slide: false, collect: true },
    },
    goalText: 'Jump every gap and reach the end.',
  },
  {
    id: 'learn-slide', name: 'Under the Vines', mechanic: 'slide',
    intro: 'Low vine curtains block the path. Slide under them - hitting one costs a heart.',
    prompt: 'Press DOWN (or swipe down) just before a low barrier to slide under it.',
    requiredAction: 'slide',
    seed: (hashString('lesson-slide') ^ 0x311de0) >>> 0,
    genOpts: {
      length: 110, speed: 9, gapRate: 0, lowRate: 0.08, relicRate: 0.2,
      branchCount: 0, timeLimitTicks: 30 * 90,
      mechanics: { turn: false, jump: false, slide: true, collect: true },
    },
    goalText: 'Slide under every barrier and reach the end.',
  },
  {
    id: 'learn-collect', name: 'Gathering Fragments', mechanic: 'collect',
    intro: 'Relic fragments lie in the side lanes. Steer into them to collect. Three of a kind earn a set bonus.',
    prompt: 'Use LEFT and RIGHT to change lanes and run through fragments.',
    requiredAction: 'left',
    seed: (hashString('lesson-collect') ^ 0xc0110) >>> 0,
    genOpts: {
      length: 120, speed: 9, gapRate: 0, lowRate: 0, relicRate: 0.55,
      branchCount: 0, timeLimitTicks: 30 * 90,
      mechanics: { turn: true, jump: false, slide: false, collect: true },
    },
    goalText: 'Collect at least 4 fragments before the end.',
    goals: { fragments: 4 },
  },
];

export function getLesson(id) {
  return LESSONS.find((l) => l.id === id) || null;
}

// --- Practice difficulties ------------------------------------------------------
export const PRACTICE_DIFFICULTIES = {
  easy: { label: 'Easy', genOpts: { ...bandParams(0), length: 160, timeLimitTicks: 30 * 200 } },
  medium: { label: 'Medium', genOpts: { ...bandParams(2), timeLimitTicks: 30 * 160 } },
  hard: { label: 'Hard', genOpts: { ...bandParams(4), timeLimitTicks: 30 * 120 } },
};

// --- Challenges ------------------------------------------------------------------
export const CHALLENGES = [
  {
    id: 'challenge-frugal', name: 'Frugal Footing',
    description: 'Finish with no more than 12 moves. Every input counts.',
    constraint: { type: 'move-limit', limit: 12 },
    genOpts: { ...bandParams(1), length: 180, branchCount: 2 },
    seed: (hashString('challenge-frugal') ^ 0xf1a) >>> 0,
    theme: 'sunstone-court', ranked: true,
  },
  {
    id: 'challenge-swift', name: 'Swift Relic',
    description: 'A faster course. Reach the end before the light fades.',
    constraint: { type: 'speed-target', speed: 16, timeLimitTicks: 30 * 60 },
    genOpts: { ...bandParams(2), speed: 16, timeLimitTicks: 30 * 60 },
    seed: (hashString('challenge-swift') ^ 0x5ebe) >>> 0,
    theme: 'dusk-canopy', ranked: true,
  },
];

export function getChallenge(id) {
  return CHALLENGES.find((c) => c.id === id) || null;
}

// --- Daily: deterministic from UTC date ------------------------------------------
export function dailySeedFor(dateKey) {
  // dateKey: 'YYYY-MM-DD' (UTC). Immutable once published.
  return (hashString(`relic-run-daily-${dateKey}`) ^ 0xda170) >>> 0;
}

export function utcDateKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function dailyContent(dateKey = utcDateKey()) {
  return {
    id: `daily-${dateKey}`,
    dateKey,
    seed: dailySeedFor(dateKey),
    genOpts: { ...bandParams(2) },
    theme: THEMES[hashString(dateKey) % THEMES.length].id,
    ranked: true,
  };
}

// --- offline validator -----------------------------------------------------------
// Prove: legality (opts sane), reachable goals (auto-policy finishes),
// bounded duration, no soft-lock (every state has a way forward).
export function validateContent(content = { STAGES, LESSONS, CHALLENGES }) {
  const errors = [];
  const stages = content.STAGES || STAGES;
  const lessons = content.LESSONS || LESSONS;
  const challenges = content.CHALLENGES || CHALLENGES;

  const seen = new Set();
  const checkEntry = (entry, kind) => {
    const where = `${kind}:${entry.id}`;
    if (!entry.id || typeof entry.id !== 'string') errors.push(`${kind}: missing id`);
    if (seen.has(entry.id)) errors.push(`${where}: duplicate id`);
    seen.add(entry.id);
    if (!Number.isInteger(entry.seed) || entry.seed < 0) errors.push(`${where}: bad seed`);
    const o = Object.assign(defaultGenOpts(), entry.genOpts || {});
    if (!(o.length >= 20 && o.length <= 2000)) errors.push(`${where}: length out of bounds`);
    if (!(o.speed >= 1 && o.speed <= 40)) errors.push(`${where}: speed out of bounds`);
    if (!(o.timeLimitTicks > 0 && o.timeLimitTicks <= 30 * 600)) errors.push(`${where}: unbounded or absurd duration`);
    for (const k of ['gapRate', 'lowRate', 'relicRate', 'riskGapRate', 'riskLowRate']) {
      if (!(o[k] >= 0 && o[k] <= 0.9)) errors.push(`${where}: ${k} out of range`);
    }
    // playability: auto-policy must finish without dying
    const s = createState(entry.seed, o);
    let guard = 0;
    const maxTicks = o.timeLimitTicks + 600;
    while (!s.terminal && guard < maxTicks) {
      const a = validatorPolicy(s);
      if (a) {
        const r = applyCommand(s, a);
        if (!r.ok) { errors.push(`${where}: policy action rejected (${r.reason})`); break; }
      }
      step(s);
      guard++;
    }
    if (guard >= maxTicks) errors.push(`${where}: no bounded completion (possible soft-lock)`);
    else if (s.terminal === 'fell' || s.terminal === 'crashed') errors.push(`${where}: auto-policy died (${s.terminal}) - hazards not clearable`);
    else if (s.terminal === 'time-up') errors.push(`${where}: auto-policy ran out of time`);
    else if (s.terminal !== 'finished') errors.push(`${where}: did not terminate`);
    // goals reachable? count collectible relics in the generated course
    if (entry.goals && entry.goals.fragments) {
      const avail = s.course.cells.reduce((n, c) => n + (c.relicLane >= 0 ? 1 : 0), 0);
      // relics collected during validation were cleared from cells; add them back
      const collected = s.fragments - s.riskFragments + s.riskFragments / 2;
      if (avail + collected < entry.goals.fragments) {
        errors.push(`${where}: fragment goal ${entry.goals.fragments} unreachable (only ${avail + collected} on course)`);
      }
    }
  };

  stages.forEach((st) => checkEntry(st, 'stage'));
  lessons.forEach((l) => checkEntry(l, 'lesson'));
  challenges.forEach((c) => checkEntry(c, 'challenge'));
  // daily seeds: check a spread of deterministic days
  for (const dk of ['2026-01-01', '2026-06-15', '2026-12-31']) {
    checkEntry(dailyContent(dk), 'daily');
  }
  return { ok: errors.length === 0, errors };
}

// Policy used by the validator: always survives if the course is fair.
function validatorPolicy(s) {
  const legal = legalActions(s);
  if (legal.length === 0) return null;
  const cells = s.course.cells;
  const ci = Math.floor(s.distUnits / 24);
  const atFork = activeBranch(s) >= 0;
  if (atFork) return 'left'; // safe route always
  // look ahead 2 cells
  for (let d = 1; d <= 2; d++) {
    const c = cells[Math.min(ci + d, cells.length - 1)];
    if (!c) continue;
    if (c.gap && legal.includes('jump')) return 'jump';
    if (c.low && legal.includes('slide')) return 'slide';
  }
  return null;
}

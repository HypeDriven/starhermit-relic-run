// Relic Run - deterministic rules engine.
// Pure module: no DOM, no THREE, no timers. Everything is integer math so
// replays are bit-exact across platforms.

export const SCHEMA_VERSION = 2;
export const TICKS_PER_SECOND = 30;
export const UNITS_PER_CELL = 24;

// --- seeded PRNG (mulberry32) ------------------------------------------------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// --- tuning constants ---------------------------------------------------------
export const LANES = 3;
// jump/slide cover a fixed distance in cells, converted to ticks at the
// current speed so higher speeds stay fair and deterministic.
export const JUMP_DISTANCE_UNITS = 3 * UNITS_PER_CELL;
export const SLIDE_DISTANCE_UNITS = 3 * UNITS_PER_CELL;
export const STUN_TICKS = 12;   // invulnerability after hitting a barrier
export const BRANCH_WINDOW_CELLS = 6; // decision window opens this many cells before the fork
export const MAX_HEARTS = 3;
export const FRAGMENT_POINTS = 25;
export const SET_BONUS_POINTS = 100;
export const SET_SIZE = 3;

export const ACTIONS = Object.freeze(['left', 'right', 'jump', 'slide']);

// --- course generation --------------------------------------------------------
// A course is a flat array of cells. Each cell:
//   { gap, low, relicLane (-1 none, 0..2), relicSet (0..2), branch (0 none, else span length) }
// Branches: when the player approaches a branch cell, left/right choose the
// route for the next `branch` cells: left = safe route, right = risk route
// (x2 fragment value). Generation guarantees hazards are clearable.

export function defaultGenOpts() {
  return {
    length: 220,        // cells
    speed: 12,          // units per tick (UNITS_PER_CELL=24 -> 0.5 cell/tick)
    timeLimitTicks: 30 * 120,
    gapRate: 0.05,
    lowRate: 0.07,
    relicRate: 0.35,
    branchCount: 3,
    riskGapRate: 0.10,
    riskLowRate: 0.12,
    hearts: MAX_HEARTS,
    mechanics: { turn: true, jump: true, slide: true, collect: true },
  };
}

function emptyCell() {
  return { gap: false, low: false, relicLane: -1, relicSet: 0, branch: 0 };
}

export function generateCourse(seed, opts = {}) {
  const o = Object.assign(defaultGenOpts(), opts);
  const length = Math.max(20, Math.min(2000, o.length | 0));
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0); // rules content stream
  const cells = new Array(length);
  for (let i = 0; i < length; i++) cells[i] = emptyCell();

  // place branches first so hazard spacing accounts for them
  const branchSpan = 24;
  const branches = [];
  if (o.mechanics.turn !== false && o.branchCount > 0) {
    const usable = length - 40;
    for (let b = 0; b < o.branchCount; b++) {
      const at = 20 + Math.floor(rng() * usable);
      if (branches.some((x) => Math.abs(x - at) < branchSpan + 8)) continue;
      branches.push(at);
      cells[at].branch = branchSpan;
    }
  }
  branches.sort((a, b) => a - b);

  const minHazardGap = 5; // cells between hazards so jump/slide always fit
  const blocked = new Set();
  for (const b of branches) for (let i = b - BRANCH_WINDOW_CELLS - 2; i <= b + 2; i++) blocked.add(i);
  let lastHazard = 2;
  for (let i = 4; i < length - 2; i++) {
    if (blocked.has(i)) continue;
    if (i - lastHazard < minHazardGap) continue;
    const inRiskSpan = branches.some((b) => i > b && i <= b + branchSpan);
    const gr = inRiskSpan ? o.riskGapRate : o.gapRate;
    const lr = inRiskSpan ? o.riskLowRate : o.lowRate;
    const r = rng();
    if (o.mechanics.jump !== false && r < gr) {
      cells[i].gap = true;
      lastHazard = i;
    } else if (o.mechanics.slide !== false && r < gr + lr) {
      cells[i].low = true;
      lastHazard = i;
    } else if (o.mechanics.collect !== false && rng() < o.relicRate) {
      cells[i].relicLane = Math.floor(rng() * LANES);
      cells[i].relicSet = Math.floor(rng() * SET_SIZE);
    }
  }
  return { seed: seed >>> 0, cells, opts: o };
}

// --- state --------------------------------------------------------------------

export function createState(seed, opts = {}) {
  const course = generateCourse(seed, opts);
  const s = {
    version: SCHEMA_VERSION,
    seed: course.seed,
    genOpts: sanitizeOpts(course.opts),
    tick: 0,
    distUnits: 0,
    speed: course.opts.speed,
    lane: 1,
    airTicks: 0,
    slideTicks: 0,
    stunTicks: 0,
    hearts: course.opts.hearts,
    fragments: 0,
    riskFragments: 0,
    sets: [0, 0, 0],
    setBonuses: 0,
    route: 'safe',        // route of the current branch span
    branchChoice: -1,     // index of branch currently in decision window, -1 none
    branchResolved: 0,    // branches already decided
    invalids: 0,
    terminal: null,       // 'finished' | 'crashed' | 'fell' | 'time-up'
    course,
  };
  return s;
}

function sanitizeOpts(o) {
  return {
    length: o.length | 0,
    speed: o.speed | 0,
    timeLimitTicks: o.timeLimitTicks | 0,
    gapRate: +o.gapRate, lowRate: +o.lowRate, relicRate: +o.relicRate,
    branchCount: o.branchCount | 0,
    riskGapRate: +o.riskGapRate, riskLowRate: +o.riskLowRate,
    hearts: o.hearts | 0,
    mechanics: {
      turn: o.mechanics.turn !== false,
      jump: o.mechanics.jump !== false,
      slide: o.mechanics.slide !== false,
      collect: o.mechanics.collect !== false,
    },
  };
}

export function cellIndex(s) {
  return Math.floor(s.distUnits / UNITS_PER_CELL);
}

export function courseLength(s) {
  return s.course.cells.length;
}

// Index of the branch whose decision window is active, or -1.
export function activeBranch(s) {
  if (s.terminal || s.genOpts.mechanics.turn === false) return -1;
  const cells = s.course.cells;
  const ci = cellIndex(s);
  for (let i = s.branchResolved; i < cells.length; i++) {
    const span = cells[i].branch;
    if (!span) continue;
    if (ci > i) { continue; } // already passed (should not happen; resolved bumps)
    const windowStartUnits = (i - BRANCH_WINDOW_CELLS) * UNITS_PER_CELL;
    if (s.distUnits >= windowStartUnits) return i;
    break; // branches are sorted; first unpassed one is the only candidate
  }
  return -1;
}

// Exact list of legal actions for this state.
export function legalActions(s) {
  if (s.terminal) return [];
  const out = [];
  const b = activeBranch(s);
  if (b >= 0) {
    // route choice at a fork: left = safe route, right = risk route
    out.push('left', 'right');
    return out;
  }
  if (s.lane > 0) out.push('left');
  if (s.lane < LANES - 1) out.push('right');
  if (s.airTicks === 0 && s.slideTicks === 0) {
    if (s.genOpts.mechanics.jump) out.push('jump');
    if (s.genOpts.mechanics.slide) out.push('slide');
  }
  return out;
}

export function invalidReason(s, action) {
  if (typeof action !== 'string' || !ACTIONS.includes(action)) return 'unknown-action';
  if (s.terminal) return 'session-over';
  const b = activeBranch(s);
  if (b >= 0) {
    if (action === 'left' || action === 'right') return null;
    return 'branch-choice-required';
  }
  if (action === 'left' && s.lane <= 0) return 'lane-edge';
  if (action === 'right' && s.lane >= LANES - 1) return 'lane-edge';
  if (action === 'jump') {
    if (!s.genOpts.mechanics.jump) return 'mechanic-disabled';
    if (s.airTicks > 0) return 'airborne';
    if (s.slideTicks > 0) return 'sliding';
    return null;
  }
  if (action === 'slide') {
    if (!s.genOpts.mechanics.slide) return 'mechanic-disabled';
    if (s.airTicks > 0) return 'airborne';
    if (s.slideTicks > 0) return 'sliding';
    return null;
  }
  return null;
}

// Validated action application. Returns { ok:true } or { ok:false, reason }.
// Invalid actions only increment the invalid counter - deterministic.
export function applyCommand(s, action) {
  const reason = invalidReason(s, action);
  if (reason) {
    s.invalids++;
    return { ok: false, reason };
  }
  const b = activeBranch(s);
  if (b >= 0) {
    // route choice
    s.route = action === 'right' ? 'risk' : 'safe';
    s.branchResolved++;
    return { ok: true, effect: 'route', route: s.route };
  }
  if (action === 'left') s.lane--;
  else if (action === 'right') s.lane++;
  else if (action === 'jump') s.airTicks = Math.max(1, Math.ceil(JUMP_DISTANCE_UNITS / s.speed));
  else if (action === 'slide') s.slideTicks = Math.max(1, Math.ceil(SLIDE_DISTANCE_UNITS / s.speed));
  return { ok: true, effect: action };
}

// One fixed simulation step.
export function step(s) {
  if (s.terminal) return;
  s.tick++;
  if (s.airTicks > 0) s.airTicks--;
  if (s.slideTicks > 0) s.slideTicks--;
  if (s.stunTicks > 0) s.stunTicks--;

  const prevCell = cellIndex(s);
  s.distUnits += s.speed;
  const ci = cellIndex(s);
  const cells = s.course.cells;
  const last = cells.length - 1;

  // passed a fork without choosing -> default safe route
  for (let i = s.branchResolved; i <= Math.min(ci, last); i++) {
    if (cells[i] && cells[i].branch) {
      s.route = 'safe';
      s.branchResolved = i + 1;
    }
  }

  // resolve cells newly entered this tick
  const from = Math.max(prevCell + 1, 0);
  const to = Math.min(ci, last);
  for (let i = from; i <= to; i++) {
    const c = cells[i];
    if (!c) continue;
    if (c.gap && s.airTicks === 0) {
      s.terminal = 'fell';
      return;
    }
    if (c.low && s.slideTicks === 0 && s.stunTicks === 0) {
      s.hearts--;
      s.stunTicks = STUN_TICKS;
      if (s.hearts <= 0) {
        s.terminal = 'crashed';
        return;
      }
    }
    if (c.relicLane >= 0 && c.relicLane === s.lane && s.slideTicks === 0) {
      collectFragment(s, c.relicSet);
      c.relicLane = -1; // collected
    }
  }

  // landing on a gap (air ran out while still over it)
  const here = cells[Math.min(ci, last)];
  if (here && here.gap && s.airTicks === 0) {
    s.terminal = 'fell';
    return;
  }

  if (ci >= last) {
    s.terminal = 'finished';
    return;
  }
  const limit = s.genOpts.timeLimitTicks;
  if (limit > 0 && s.tick >= limit) {
    s.terminal = 'time-up';
  }
}

function collectFragment(s, set) {
  if (s.route === 'risk') {
    s.fragments += 2;
    s.riskFragments += 2;
  } else {
    s.fragments += 1;
  }
  s.sets[set] = (s.sets[set] || 0) + 1;
  if (s.sets[set] === SET_SIZE) {
    s.setBonuses++;
    s.sets[set] = 0; // set completed; start collecting the next one
  }
}

// --- scoring ------------------------------------------------------------------
export function scoreBreakdown(s) {
  const distance = Math.floor(s.distUnits / UNITS_PER_CELL);
  const fragments = (s.fragments - s.riskFragments) * FRAGMENT_POINTS;
  const riskBonus = s.riskFragments * FRAGMENT_POINTS; // the x2 extra half
  const setBonus = s.setBonuses * SET_BONUS_POINTS;
  const total = distance + fragments + riskBonus + setBonus;
  return { distance, fragments, riskBonus, setBonus, total };
}

export function tieBreakMeta(s, sessionId) {
  return {
    finished: s.terminal === 'finished',
    invalids: s.invalids,
    ticks: s.tick,
    sessionId: String(sessionId == null ? '' : sessionId),
  };
}

// Compare two results per spec: completion, fewer invalids, lower ticks, id.
export function compareResults(a, b) {
  if (a.finished !== b.finished) return a.finished ? -1 : 1;
  if (a.invalids !== b.invalids) return a.invalids - b.invalids;
  if (a.ticks !== b.ticks) return a.ticks - b.ticks;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

// --- serialization ------------------------------------------------------------
// Compact but complete JSON-safe snapshot. Course is regenerated from
// seed+genOpts on deserialize, then collected relics are re-applied.

export function serialize(s) {
  const collected = [];
  const cells = s.course.cells;
  // cells that originally had a relic but were collected: detect by re-gen
  const fresh = generateCourse(s.seed, s.genOpts);
  for (let i = 0; i < cells.length; i++) {
    if (fresh.cells[i].relicLane >= 0 && cells[i].relicLane < 0) collected.push(i);
  }
  return {
    version: SCHEMA_VERSION,
    seed: s.seed,
    genOpts: s.genOpts,
    tick: s.tick,
    distUnits: s.distUnits,
    speed: s.speed,
    lane: s.lane,
    airTicks: s.airTicks,
    slideTicks: s.slideTicks,
    stunTicks: s.stunTicks,
    hearts: s.hearts,
    fragments: s.fragments,
    riskFragments: s.riskFragments,
    sets: s.sets.slice(),
    setBonuses: s.setBonuses,
    route: s.route,
    branchResolved: s.branchResolved,
    invalids: s.invalids,
    terminal: s.terminal,
    collected,
  };
}

export function deserialize(d) {
  if (!d || typeof d !== 'object') throw new Error('bad snapshot');
  const version = d.version | 0;
  if (version < 1 || version > SCHEMA_VERSION) throw new Error('unsupported-version');
  const s = createState(d.seed >>> 0, migrateOpts(d.genOpts, version));
  s.tick = d.tick | 0;
  s.distUnits = d.distUnits | 0;
  s.speed = d.speed | 0;
  s.lane = Math.max(0, Math.min(LANES - 1, d.lane | 0));
  s.airTicks = d.airTicks | 0;
  s.slideTicks = d.slideTicks | 0;
  s.stunTicks = d.stunTicks | 0;
  s.hearts = d.hearts | 0;
  s.fragments = d.fragments | 0;
  s.riskFragments = d.riskFragments | 0;
  s.sets = Array.isArray(d.sets) ? d.sets.slice(0, SET_SIZE).map((x) => x | 0) : [0, 0, 0];
  while (s.sets.length < SET_SIZE) s.sets.push(0);
  s.setBonuses = d.setBonuses | 0;
  s.route = d.route === 'risk' ? 'risk' : 'safe';
  s.branchResolved = d.branchResolved | 0;
  s.invalids = d.invalids | 0;
  s.terminal = ['finished', 'crashed', 'fell', 'time-up'].includes(d.terminal) ? d.terminal : null;
  if (Array.isArray(d.collected)) {
    for (const i of d.collected) {
      if (Number.isInteger(i) && i >= 0 && i < s.course.cells.length) {
        s.course.cells[i].relicLane = -1;
      }
    }
  }
  return s;
}

// v1 -> v2: v1 had no mechanics flags / hearts.
function migrateOpts(genOpts, fromVersion) {
  const o = Object.assign(defaultGenOpts(), genOpts || {});
  if (fromVersion < 2) {
    if (o.hearts == null || o.hearts === 0) o.hearts = MAX_HEARTS;
  }
  return o;
}

// --- hashing (replay verification) --------------------------------------------
export function hashState(s) {
  let h = 0x811c9dc5;
  const mix = (v) => {
    v = (v | 0) >>> 0;
    for (let i = 0; i < 4; i++) {
      h ^= v & 0xff;
      h = Math.imul(h, 0x01000193);
      v >>>= 8;
    }
  };
  mix(s.tick);
  mix(s.distUnits);
  mix(s.speed);
  mix(s.lane);
  mix(s.airTicks);
  mix(s.slideTicks);
  mix(s.stunTicks);
  mix(s.hearts);
  mix(s.fragments);
  mix(s.riskFragments);
  mix(s.sets[0]); mix(s.sets[1]); mix(s.sets[2]);
  mix(s.setBonuses);
  mix(s.route === 'risk' ? 1 : 0);
  mix(s.branchResolved);
  mix(s.invalids);
  mix(s.terminal ? hashString(s.terminal) : 0);
  return h >>> 0;
}

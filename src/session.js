// Relic Run - session: command log, replay, snapshots, scoring glue.
import {
  SCHEMA_VERSION, createState, applyCommand, step, legalActions,
  activeBranch, hashState, serialize as serializeState, deserialize as deserializeState,
  scoreBreakdown, tieBreakMeta, generateCourse, mulberry32,
} from './rules.js';

export const CONTENT_VERSION = 1;
export const SESSION_VERSION = 2;

let sessionCounter = 0;

export function newSession(seed, opts = {}, sessionId) {
  const id = sessionId || `s-${(++sessionCounter).toString(36)}-${(seed >>> 0).toString(36)}`;
  return {
    version: SESSION_VERSION,
    seed: seed >>> 0,
    genOpts: opts,
    sessionId: id,
    state: createState(seed, opts),
    commands: [],      // accepted commands: { id, action }
    rejected: [],      // { id, action, reason } - includes duplicates
    nextCmdId: 1,
    stateHashes: [],   // periodic hashes for the replay envelope
    initialHash: 0,
    over: false,
  };
}

export function startSession(sess) {
  sess.initialHash = hashState(sess.state);
  return sess;
}

// Validate + apply a player command. Idempotent on duplicate command ids.
// Returns { ok, reason?, deduped? }.
export function applySessionCommand(sess, cmd) {
  if (!cmd || typeof cmd !== 'object') return { ok: false, reason: 'malformed' };
  const id = cmd.id | 0;
  if (id <= 0 || !Number.isFinite(id)) return { ok: false, reason: 'bad-id' };
  if (id < sess.nextCmdId || sess.commands.some((c) => c.id === id)) {
    return { ok: false, reason: 'duplicate', deduped: true };
  }
  const res = applyCommand(sess.state, cmd.action);
  if (!res.ok) {
    sess.rejected.push({ id, action: String(cmd.action), reason: res.reason });
    sess.nextCmdId = Math.max(sess.nextCmdId, id + 1);
    return { ok: false, reason: res.reason };
  }
  sess.commands.push({ id, tick: sess.state.tick, action: cmd.action });
  sess.nextCmdId = Math.max(sess.nextCmdId, id + 1);
  if (sess.state.terminal) sess.over = true;
  return { ok: true, effect: res.effect, route: res.route };
}

// Advance the fixed-step simulation by n ticks, recording periodic hashes.
export function advance(sess, ticks = 1) {
  for (let i = 0; i < ticks; i++) {
    if (sess.state.terminal) { sess.over = true; break; }
    step(sess.state);
    if (sess.state.tick % TICK_HASH_INTERVAL === 0) {
      sess.stateHashes.push({ tick: sess.state.tick, hash: hashState(sess.state) });
    }
    if (sess.state.terminal) sess.over = true;
  }
  return sess.state;
}

export const TICK_HASH_INTERVAL = 30;

export function getLegalActions(sess) {
  return legalActions(sess.state);
}

export function scoreOf(sess) {
  return scoreBreakdown(sess.state);
}

export function resultMeta(sess) {
  return tieBreakMeta(sess.state, sess.sessionId);
}

// --- replay -------------------------------------------------------------------
// Re-run seed + ordered commands; commands are applied at their recorded tick.
export function replay(seed, commands, opts = {}) {
  const sess = startSession(newSession(seed, opts, 'replay'));
  const sorted = [...commands].filter((c) => c && Number.isFinite(c.id)).sort((a, b) => a.id - b.id);
  for (const c of sorted) {
    applySessionCommand(sess, { id: c.id, action: c.action });
    // commands only take effect at a tick boundary; advance one tick per command
    // only if the caller recorded atTicks; otherwise commands are instantaneous
    // (they mutate lane/air state used by subsequent ticks).
  }
  return sess;
}

// Deterministic replay given tick-stamped commands:
// [{ id, tick, action }] - each command applied before that tick's step.
export function replayTicks(seed, commands, opts = {}, maxTicks = 30 * 600) {
  const sess = startSession(newSession(seed, opts, 'replay'));
  const sorted = [...commands]
    .filter((c) => c && Number.isFinite(c.id) && Number.isFinite(c.tick))
    .sort((a, b) => a.tick - b.tick || a.id - b.id);
  let ci = 0;
  while (!sess.over && sess.state.tick < maxTicks) {
    while (ci < sorted.length && sorted[ci].tick <= sess.state.tick) {
      applySessionCommand(sess, sorted[ci]);
      ci++;
    }
    advance(sess, 1);
    if (sess.over) break;
  }
  return sess;
}

export function replayEnvelope(sess) {
  return {
    schemaVersion: SCHEMA_VERSION,
    contentVersion: CONTENT_VERSION,
    sessionVersion: SESSION_VERSION,
    seed: sess.seed,
    genOpts: sess.genOpts,
    initialHash: sess.initialHash,
    commands: sess.commands.map((c) => ({ id: c.id, tick: c.tick ?? 0, action: c.action })),
    stateHashes: sess.stateHashes.slice(),
    terminal: sess.state.terminal,
    score: scoreOf(sess),
    meta: resultMeta(sess),
  };
}

// --- snapshots (pause / background / resume) ----------------------------------
export function snapshot(sess) {
  return {
    version: SESSION_VERSION,
    seed: sess.seed,
    genOpts: sess.genOpts,
    sessionId: sess.sessionId,
    state: serializeState(sess.state),
    commands: sess.commands.map((c) => ({ ...c })),
    rejected: sess.rejected.map((c) => ({ ...c })),
    nextCmdId: sess.nextCmdId,
    stateHashes: sess.stateHashes.map((h) => ({ ...h })),
    initialHash: sess.initialHash,
    over: sess.over,
  };
}

export function restore(snap) {
  if (!snap || typeof snap !== 'object') throw new Error('bad session snapshot');
  return {
    version: SESSION_VERSION,
    seed: snap.seed >>> 0,
    genOpts: snap.genOpts || {},
    sessionId: String(snap.sessionId || 'restored'),
    state: deserializeState(snap.state),
    commands: Array.isArray(snap.commands) ? snap.commands.map((c) => ({ ...c })) : [],
    rejected: Array.isArray(snap.rejected) ? snap.rejected.map((c) => ({ ...c })) : [],
    nextCmdId: snap.nextCmdId | 0 || 1,
    stateHashes: Array.isArray(snap.stateHashes) ? snap.stateHashes.map((h) => ({ ...h })) : [],
    initialHash: snap.initialHash >>> 0,
    over: !!snap.over,
  };
}

// "While you were away" summary between a background snapshot and now.
export function awaySummary(beforeState, afterState) {
  const bScore = scoreBreakdown(beforeState).total;
  const aScore = scoreBreakdown(afterState).total;
  return {
    ticksElapsed: afterState.tick - beforeState.tick,
    fragmentsGained: afterState.fragments - beforeState.fragments,
    scoreDelta: aScore - bScore,
    heartsLost: beforeState.hearts - afterState.hearts,
    terminal: afterState.terminal,
  };
}

// Simple deterministic auto-policy used by content validation and tests:
// jumps gaps, slides barriers, picks safe routes, chases relics when adjacent.
export function autoAction(state) {
  const legal = legalActions(state);
  if (legal.length === 0) return null;
  const cells = state.course.cells;
  const ci = Math.floor(state.distUnits / 24);
  const ahead = cells[Math.min(ci + 1, cells.length - 1)];
  if (activeBranch(state) >= 0) {
    // at a fork: take the risk route deterministically ~30% of the time
    const takeRisk = ((state.seed ^ state.tick) >>> 0) % 10 < 3;
    return takeRisk ? 'right' : 'left';
  }
  if (ahead) {
    if (ahead.gap && legal.includes('jump')) return 'jump';
    if (ahead.low && legal.includes('slide')) return 'slide';
    if (ahead.relicLane >= 0) {
      if (ahead.relicLane < state.lane && legal.includes('left')) return 'left';
      if (ahead.relicLane > state.lane && legal.includes('right')) return 'right';
    }
  }
  return null;
}

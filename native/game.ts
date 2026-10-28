// The browser build's pure game modules, imported unchanged (allowJs) and typed
// here with the shapes this client reads: the deterministic rules
// (src/rules.js: the course generator, the 30 Hz fixed step with lanes, forks,
// jumps, slides, gaps, barriers, fragments and sets, scoring), the session
// (src/session.js: validated command ids, periodic hashes, snapshots for the
// Practice undo), the versioned content (src/content.js: five themes, 40
// Journey stages, four lessons, Practice difficulties, two Challenges, the
// Daily from a UTC date) and the progress model this client stores
// (src/progress.js).
import * as RulesJs from "../src/rules.js";
import * as SessionJs from "../src/session.js";
import * as ContentJs from "../src/content.js";
import * as ProgressJs from "../src/progress.js";

export interface Cell { gap: boolean; low: boolean; relicLane: number; relicSet: number; branch: number }
export interface GenOpts {
  length: number; speed: number; timeLimitTicks: number; gapRate: number; lowRate: number; relicRate: number; branchCount: number;
  riskGapRate: number; riskLowRate: number; hearts: number;
  mechanics: { turn: boolean; jump: boolean; slide: boolean; collect: boolean };
}
export type Terminal = "finished" | "crashed" | "fell" | "time-up";
export interface State {
  seed: number; genOpts: GenOpts; tick: number; distUnits: number; speed: number; lane: number;
  airTicks: number; slideTicks: number; stunTicks: number; hearts: number; fragments: number; riskFragments: number;
  sets: number[]; setBonuses: number; route: "safe" | "risk"; branchResolved: number; invalids: number;
  terminal: Terminal | null; course: { seed: number; cells: Cell[] };
}
export type Action = "left" | "right" | "jump" | "slide";
export interface Session { seed: number; sessionId: string; state: State; nextCmdId: number; over: boolean }
export interface Snapshot { readonly state: unknown }
export interface Breakdown { distance: number; fragments: number; riskBonus: number; setBonus: number; total: number }
export interface Theme {
  id: string; name: string; sky: number; fog: number; fogDensity: number; stone: number; stoneDark: number;
  foliage: number; foliageAlt: number; accent: number; relic: number;
}
export interface Stage {
  id: string; index: number; name: string; seed: number; genOpts: Partial<GenOpts>; goals: { finish: boolean; fragments: number };
  par: { score: number; ticks: number }; mastery: boolean; tutorial: string | null; theme: string; difficulty: string;
}
export interface Lesson {
  id: string; name: string; mechanic: string; intro: string; prompt: string; seed: number; genOpts: Partial<GenOpts>; goalText: string;
}
export interface Challenge {
  id: string; name: string; description: string; seed: number; genOpts: Partial<GenOpts>; theme: string;
  constraint: { type: "move-limit"; limit: number } | { type: "speed-target"; speed: number; timeLimitTicks: number };
}
export interface Daily { id: string; dateKey: string; seed: number; genOpts: Partial<GenOpts>; theme: string }
export interface Progress {
  version: number;
  journey: { unlocked: number; completed: Record<string, { score: number; finished: boolean }> };
  achievements: Record<string, { unlockedAt: string }>;
  bestScores: Record<string, { total: number; date?: string; breakdown?: Breakdown }>;
  tutorials: Record<string, boolean>;
  totals: { runs: number; fragments: number; dailies: Record<string, number> };
}
export interface GameOptions { leftHanded: boolean; colorblind: boolean; timingAssist: boolean }

interface RulesApi {
  TICKS_PER_SECOND: number; UNITS_PER_CELL: number; LANES: number; MAX_HEARTS: number;
  createState(seed: number, opts?: Partial<GenOpts>): State;
  activeBranch(s: State): number;
  legalActions(s: State): Action[];
  scoreBreakdown(s: State): Breakdown;
}
interface SessionApi {
  newSession(seed: number, opts?: Partial<GenOpts>, id?: string): Session;
  startSession(s: Session): Session;
  applySessionCommand(s: Session, cmd: { id: number; action: string }): { ok: boolean; reason?: string; deduped?: boolean; effect?: string };
  advance(s: Session, ticks?: number): State;
  scoreOf(s: Session): Breakdown;
  snapshot(s: Session): Snapshot;
  restore(snap: Snapshot): Session;
  awaySummary(a: State, b: State): { scoreDelta: number };
}
interface ContentApi {
  THEMES: Theme[]; STAGES: Stage[]; LESSONS: Lesson[]; CHALLENGES: Challenge[];
  PRACTICE_DIFFICULTIES: Record<string, { label: string; genOpts: Partial<GenOpts> }>;
  dailyContent(dateKey: string): Daily;
}
interface ProgressApi {
  OPTION_KEYS: (keyof GameOptions)[];
  ACHIEVEMENTS: { id: string; name: string; description: string }[];
  blank(): Progress;
  normalize(raw: unknown): Progress;
  merge(a: unknown, b: unknown): Progress;
  same(a: unknown, b: unknown): boolean;
  unlock(p: Progress, id: string, isoNow: string): boolean;
  pickOptions(raw: unknown): Partial<GameOptions>;
  optionsFromSettings(settings: unknown): Partial<GameOptions>;
  readForeign(text: string | null | undefined): { progress: Progress; options: Partial<GameOptions> } | null;
  isLegacyKey(key: string): boolean;
}

export const Rules = RulesJs as unknown as RulesApi;
export const Session = SessionJs as unknown as SessionApi;
export const Content = ContentJs as unknown as ContentApi;
export const Progress = ProgressJs as unknown as ProgressApi;

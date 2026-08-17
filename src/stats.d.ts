// Type surface for the plain-JS stats core (stats.js). TypeScript callers import from
// './stats.js' and resolve to these declarations; Node imports the .js directly and needs
// no types. The runtime file is stats.js — keep the two in sync by hand (the API is small).

import type { PacerMode } from './pacer.js';
import type { CalibrationResult } from './calibration.js';

export type Verdict = 'ok' | 'err';
export type EventType = 'down' | 'up';
export type Hand = 'L' | 'R' | 'C'; // C = centre (the spacebar thumb)
export type TransitionKind = 'sameFinger' | 'sameHand' | 'crossHand';

/** One raw event, array-encoded: [t, type, key, idx, verdict]. */
export type RawEvent = [number, EventType, string, number, Verdict | null];

/** The run's configuration, as actually played. `mode` discriminates: a GRID run carries only the
 *  fields that mean something for pointing (the grid geometry lives in `RunLog.grid`), and a
 *  KEYBOARD (v1) run carries the alphabet/finger fields. Emitting keyboard fields on a grid run
 *  would describe a game that did not happen — the log is the research artifact, so it states only
 *  what is true. Fields are optional because which ones appear depends on `mode`. */
export interface RunConfig {
  mode?: 'grid' | 'keyboard'; // absent on logs written before this discriminator existed
  n: number; // alphabet size / cell count — the N in log2(N-1)
  durationMs: number;
  sound: boolean;
  // ---- keyboard (v1) only ----
  alphabet?: string;
  leftFingers?: string;
  rightFingers?: string;
  topRow?: boolean;
  leftTopRow?: string;
  rightTopRow?: string;
  chords?: boolean;
  lookahead?: number;
  lanes?: boolean;
  chord?: boolean;
  errorFeedback?: 'none' | 'flash' | 'shake' | 'flash+shake';
}

export interface MachineMeta {
  installId: string;
  label: string;
  ua: string;
  platform: string;
  hardwareConcurrency: number;
  estimatedRefreshHz: number;
  timeOriginPrecisionMs: number;
}

export interface RunSummary {
  bitsPerSecond: number;
  n: number;
  sc: number;
  si: number;
  elapsedS: number;
  accuracy: number;
  grossKeysPerSec: number;
  netSelectionsPerSec: number;
  medianIkiMs: number;
  rollovers: number;
  droppedFrames: number;
  outOfAlphabet: number;
}

/** The adaptive pacer's log. `enabled: false` runs carry only that flag; enabled runs carry the
 *  tempo history and every click time (run-relative ms, the same clock as `events`). */
export interface PacerLog {
  enabled: boolean;
  mode?: PacerMode;
  push?: number;
  startTempoHz?: number | null;
  endTempoHz?: number | null;
  clickTimes?: number[];
  tempoChanges?: Array<{ t: number; hz: number }>;
}

/** The target-tone layer's log — enough to group A/B runs by condition. */
export interface TonesLog {
  enabled: boolean;
  scale: string;
  baseHz: number;
  handCoding: string;
  voiceStealEvents: number;
}

/** GRID MODE's log section. Present (with `enabled: true`) only on pointing runs; the Fitts
 *  difficulty of every selection depends on cellPx/fieldPx/dpr, so they are recorded. The two
 *  per-selection arrays are aligned with the grid `down` events in order. */
export interface GridLog {
  enabled: boolean;
  gridSize: number; // cells per side
  depth?: number; // stacked layers per selection (1 default; 2 = orange+blue pair, N = (gridSize²)²)
  fieldPx: number; // play-field side in CSS px
  cellPx: number; // target width W (px) — the Fitts term
  devicePixelRatio: number;
  ghost: boolean;
  crosshair: boolean;
  hoverPulse: boolean;
  pointerType: string; // modal pointer type across the run ('mouse' | 'touch' | 'pen')
  ghostAdjacent?: number[]; // per down-event: 1 if the next target was within a couple cells of this one
  pointerTypes?: string[]; // per down-event pointer type
}

/** SCOPE MODE's log section — a grid run under pointer lock with a hold-to-magnify lens. Present
 *  (enabled) only on scope runs, alongside the `grid` section (scope is a grid variant). */
export interface ScopeActivation {
  tDown: number; // run-relative ms the scope was engaged
  tUp: number | null; // released (null if still held at run end)
  binding: 'rmb' | 'ctrl';
}
export interface ScopeLog {
  enabled: boolean;
  gridSize: number;
  magnification: number;
  scopedGainFactor: number; // pointer gain while scoped (= 1/magnification by default)
  lensDiameter: number; // fraction of the field
  unadjustedMovement: boolean; // was raw (un-accelerated) movement requested/granted
  activations: ScopeActivation[];
}

export interface RunLog {
  schemaVersion: 3;
  meta: {
    appVersion: string; // package.json version at build time
    commit: string; // short git SHA of the build ('-dirty' if uncommitted; 'unknown'/'dev' if absent)
    runId: string;
    startedAt: string;
    mode: 'scored' | 'practice';
    machine: MachineMeta;
    config: RunConfig;
  };
  sequence: string[];
  eventColumns: ['t', 'type', 'key', 'idx', 'verdict'];
  events: RawEvent[];
  latencySamples: Array<{ t: number; downToPaintMs: number }>;
  summary: RunSummary;
  pacer: PacerLog;
  tones: TonesLog;
  grid?: GridLog; // present only on GRID MODE runs
  scope?: ScopeLog; // present only on SCOPE MODE runs (a grid variant)
  calibration?: CalibrationResult; // grid mode: the session's calibration (attached to every run)
  pointerPath?: Array<[number, number, number]>; // GRID/SCOPE: [t, x, y] field-local (virtual) samples
}

export interface FingerInfo {
  hand: Hand;
  finger: number;
  fingerName: string;
  id: number;
  col: number;
}

export interface DownEvent {
  t: number;
  key: string;
  idx: number;
  verdict: Verdict | null;
}
export interface UpEvent {
  t: number;
  key: string;
  idx: number;
  verdict: null;
}

export interface IkiStats {
  median: number;
  p90: number;
  count: number;
}

export interface Histogram {
  bins: number[];
  binMs: number;
  maxMs: number;
  overflow: number;
  median: number;
  p90: number;
  total: number;
}

export interface TransitionStats {
  sameFinger: IkiStats;
  sameHand: IkiStats;
  crossHand: IkiStats;
}

export interface TransitionMean {
  mean: number;
  count: number;
}
export interface TransitionMeans {
  sameKey: TransitionMean;
  sameHand: TransitionMean;
  crossHand: TransitionMean;
}

export interface ConfusionPair {
  target: string;
  pressed: string;
  count: number;
}
export interface Confusion {
  pairs: ConfusionPair[];
  total: number;
  adjacent: number;
  sameHandWrongFinger: number;
  adjacentShare: number;
  sameHandShare: number;
}

export interface QuartileStat extends IkiStats {
  index: number;
}

export interface DigraphStat {
  a: string;
  b: string;
  median: number;
  p90: number;
  count: number;
}

export interface GridFittsRow {
  mt: number; // movement time (ms)
  id: number; // index of difficulty (bits)
  distCells: number; // straight-line distance in cell widths
  distPx: number;
}
export interface GridFitts {
  count: number;
  meanId: number;
  meanMt: number;
  meanDistCells: number;
  slopeMsPerBit: number; // OLS slope of MT on ID
  interceptMs: number;
  r2: number;
  throughput: number; // slope-based Fitts TP, bits/s (1000 / slope) — noisy at one grid size
  effectiveTp: number; // mean ID / mean MT, bits/s — stable; the on-screen headline
  rows: GridFittsRow[];
}

export interface ReportStats {
  downs: DownEvent[];
  iki: IkiStats;
  histogram: Histogram;
  transitions: TransitionStats;
  confusion: Confusion;
}

export function deriveFingerMap(alphabet: string): Map<string, FingerInfo>;
export function classifyTransition(
  map: Map<string, FingerInfo>,
  a: string,
  b: string,
): TransitionKind | null;
export function splitEvents(log: RunLog): { downs: DownEvent[]; ups: UpEvent[] };
export function quantile(sortedValues: number[], q: number): number;
export function ikiStats(values: number[]): IkiStats;
export function ikiList(downs: DownEvent[]): number[];
export function medianIki(downs: DownEvent[]): number;
export function transitionStats(downs: DownEvent[], alphabet: string): TransitionStats;
export function transitionMeans(downs: DownEvent[], alphabet: string): TransitionMeans;
export function digraphStats(downs: DownEvent[], minCount?: number): DigraphStat[];
export function gridFitts(log: RunLog): GridFitts | null;
export function histogram(values: number[], binMs?: number, maxMs?: number): Histogram;
export function confusion(
  downs: DownEvent[],
  sequence: string[],
  alphabet: string,
): Confusion;
export function quartiles(downs: DownEvent[], durationMs: number): QuartileStat[];
export function postErrorSlowing(downs: DownEvent[]): {
  baseline: number;
  postError: number;
  count: number;
};
export function countRollovers(log: RunLog): number;
export function reportStats(log: RunLog): ReportStats;

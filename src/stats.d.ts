// Type surface for the plain-JS stats core (stats.js). TypeScript callers import from
// './stats.js' and resolve to these declarations; Node imports the .js directly and needs
// no types. The runtime file is stats.js — keep the two in sync by hand (the API is small).

export type Verdict = 'ok' | 'err';
export type EventType = 'down' | 'up';
export type Hand = 'L' | 'R' | 'C'; // C = centre (the spacebar thumb)
export type TransitionKind = 'sameFinger' | 'sameHand' | 'crossHand';

/** One raw event, array-encoded: [t, type, key, idx, verdict]. */
export type RawEvent = [number, EventType, string, number, Verdict | null];

export interface RunConfig {
  alphabet: string;
  n: number;
  leftFingers: string;
  rightFingers: string;
  chords: boolean;
  lookahead: number;
  lanes: boolean;
  chord: boolean;
  sound: boolean;
  errorFeedback: 'none' | 'flash' | 'shake' | 'flash+shake';
  durationMs: number;
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

export interface RunLog {
  schemaVersion: 2;
  meta: {
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
export function digraphStats(downs: DownEvent[], minCount?: number): DigraphStat[];
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

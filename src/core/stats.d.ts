// Type surface for the plain-JS stats core (stats.js). TypeScript callers import from
// './stats.js' and resolve to these declarations; Node imports the .js directly and needs
// no types. The runtime file is stats.js — keep the two in sync by hand (the API is small).
//
// ---- STORED NAMES vs DOMAIN NAMES ---------------------------------------------------------
// This file types a FILE FORMAT, not the running game, and the two use different words for the
// same things. The stored names are v1's: the log schema was designed for a keyboard game and
// then carried, unchanged, to a pointing game — deliberately, because logs/ is the research
// artifact and renaming a field would make already-collected runs unreadable to the tooling that
// produced them. So the names below are frozen, and this table is the translation:
//
//   STORED             MEANS                                    DOMAIN NAME
//   events[].key       the symbol selected. On a GRID run this  symbol
//                      is String(cellIndex), NOT a keyboard key.
//   sequence[]         the drawn targets, same encoding          targets
//   summary.grossKeysPerSec    selections/s including errors     grossPerSecond
//   summary.outOfAlphabet      inputs that were not selections   (grid: clicks outside the field)
//   summary.medianIkiMs        median gap between selections     inter-selection interval
//   summary.rollovers          overlapping presses (v1 only)     — meaningless on a pointing run
//   meta.mode          whether the run COUNTS ('scored' |        scored: boolean
//                      'practice'). Not the game — that is
//                      meta.config.mode ('grid' | 'keyboard').
//   grid.depth         cells per selection (retired stacked      cellsPerSelection — NOT the
//                      variant). Always 1 on a current log.      lookahead. Read it through
//                                                                cellsPerSelection() below.
//
// The rule: code says the domain name, the file says the stored name, and the translation happens
// here and nowhere else. Do not introduce a NEW field under a stored name — those are historical.


// ---- retired calibration shapes, read-only -----------------------------------
// The game no longer calibrates. These two interfaces stay because logs/ holds runs written while
// it did, RunLog still types those fields, and a log is the research artifact: deleting the shape
// would make already-collected data unreadable to the very tooling that produced it. Nothing
// computes them, and no new log carries them.
//
// WHY IT WAS DROPPED, so the next person does not rebuild it: v1 solved fieldPx/(4.133·σ) for a
// grid size, which is degenerate because σ ∝ cellPx — it returns the grid it was measured on. v2
// looked for the knee in a Fitts line and swung between 12² and 48² for the same hand inside an
// hour, because its accuracy branch turned three clicks out of twelve into a 16× swing. A third
// version measured 24² and 32² head to head and worked, but its standard error (±3.9%) was larger
// than the gap it was measuring (~3.5%), and there was no evidence the winner varies between
// players at all. A measurement noisier than its signal loses to just picking the better grid.

/** v1: the σ → ISO effective width → grid solve. */
export interface CalibrationResult {
  referenceGrid: number;
  clicks: Array<{ t: number; targetCell: number; dx: number; dy: number; mtMs: number; block?: 'A' | 'B' }>;
  sigmaX: number;
  sigmaY: number;
  sigmaUsed: number;
  effectiveWidthPx: number;
  fittsA: number;
  fittsB: number;
  fittsR2: number;
  impliedThroughput: number | null;
  recommendedGrid: number;
  chosenGrid: number;
  overridden: boolean;
  pointerType: string;
  fieldPx: number;
  devicePixelRatio: number;
}

/** v2: fit a Fitts line on 16×16, measure the departure at 64×64, score a six-rung ladder. */
export interface CalibrationV2 {
  blockA: { w: number; gridSize: number; n: number; accuracy: number; medianMt: number; fittsA: number; fittsB: number; r2: number };
  blockB: { w: number; gridSize: number; n: number; accuracy: number; medianMt: number; medianPredictedMt: number };
  inflationRatio: number;
  pooledAccuracy: number;
  bEstByCandidate: Record<string, number>;
  method: 'knee' | 'sigma-fallback';
  recommendedGrid: number;
  chosenGrid: number;
  overridden: boolean;
}

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
  lookahead?: number;
}

export interface MachineMeta {
  installId: string;
  label: string; // free-text machine name from the config screen; '' if unset
  ua: string;
  platform: string;
  hardwareConcurrency: number;
  estimatedRefreshHz: number;
  timeOriginPrecisionMs: number;
  // ---- display geometry (absent on logs written before it was recorded) ----
  // Cell size in px is what every Fitts number and the scatter law are expressed in, and it comes
  // from the window, not from the grid setting. Two machines are not comparable without these.
  screenWidth?: number;
  screenHeight?: number;
  windowWidth?: number; // the viewport the play field was actually fitted into
  windowHeight?: number;
  devicePixelRatio?: number;
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

/** GRID MODE's log section. Present (with `enabled: true`) only on pointing runs; the Fitts
 *  difficulty of every selection depends on cellPx/fieldPx/dpr, so they are recorded. The two
 *  per-selection arrays are aligned with the grid `down` events in order. */
export interface GridLog {
  enabled: boolean;
  gridSize: number; // cells per side
  /** Cells per selection. Always 1 on a current log. logs/ holds a batch of runs from the retired
   *  stacked-layer variant where it was 2 (N = (gridSize²)²), and analyze.mjs filters on it to keep
   *  those out of the grid sweep — they are not the same game. */
  depth?: number;
  fieldPx: number; // play-field side in CSS px
  cellPx: number; // target width W (px) — the Fitts term
  devicePixelRatio: number;
  ghost: boolean; // any preview at all (= lookahead > 0). Kept so pre-lookahead logs stay readable
  lookahead?: number; // upcoming targets previewed: 0 | 1 | 2 (absent on logs written before this)
  crosshair: boolean;
  hoverPulse: boolean;
  pointerType: string; // modal pointer type across the run ('mouse' | 'touch' | 'pen')
  ghostAdjacent?: number[]; // per down-event: 1 if the next target was within a couple cells of this one
  pointerTypes?: string[]; // per down-event pointer type
  /** How the grid size was chosen. 'fixed' is the desktop game: 32×32 for everyone, which is what
   *  makes two scores comparable. 'touch' means a coarse pointer was detected and the grid was
   *  sized down until its cells cleared a fingertip — a different N on a different input device, so
   *  a separate modality. Analyses must not pool the two; B is not invariant to N in the measured
   *  data (9.07 bits/s at 8², 13.37 at 24²). Absent on logs written before touch sizing existed,
   *  all of which are 'fixed'. */
  sizing?: 'fixed' | 'touch';
  minCellPx?: number; // the touch floor the grid was fitted to, when sizing is 'touch'
}

// ---- retired mode + experiment shapes, read-only ------------------------------
// Same rule as the calibration shapes above: SCOPE MODE and the ghost A/B are gone from the game,
// but logs/ holds runs from both, and analyze.mjs reads them — it FILTERS on `scope.enabled` to
// keep a 256×256 pointer-lock run out of the grid sweep, and §[12] still reports the ghost result
// these `ab` tags made possible (+2.46 bits/s, the reason the ghost is now unconditional). Delete
// these types and that analysis stops compiling against its own data.

/** SCOPE MODE's log section — a grid run under pointer lock with a hold-to-magnify lens. */
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
  grid?: GridLog; // present only on GRID MODE runs
  scope?: ScopeLog; // retired mode; present only on logs written while it existed
  /** Grid mode: the session's calibration, when there was one. Present only on logs written while
   *  the game still calibrated — see the note above these two interfaces. Two separate keys, never
   *  one reused key, so a stored log always means exactly what the calibrator that wrote it meant. */
  calibration?: CalibrationResult;
  calibrationV2?: CalibrationV2;
  pointerPath?: Array<[number, number, number]>; // GRID: [t, x, y] field-local pointer samples
  /** Retired ghost A/B arm. Block+position rather than just the arm is what let the analyzer pair
   *  runs EXACTLY — pairing by timestamp would mis-pair the moment a run was abandoned. */
  ab?: { experiment: string; arm: 'on' | 'off'; block: number; position: number };
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

/** The run's selections, in order — the domain name for the log's `down` events. Every recorded
 *  down IS a selection: input that does not score never becomes an event. */
export function selections(log: RunLog): DownEvent[];
export function correctSelections(sels: DownEvent[]): DownEvent[];
/** Consecutive pairs where BOTH selections were correct — the unit of every interval statistic. */
export function correctPairs(sels: DownEvent[]): Array<[DownEvent, DownEvent]>;
/** Cells per selection (stored as `grid.depth`, which is NOT the lookahead). Always 1 today. */
export function cellsPerSelection(log: RunLog): number;
/** Is this a run of THE game — one whose B may be pooled with another run's B? */
export function isComparableGridRun(log: RunLog): boolean;
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

/** One sample of B computed over a sliding window (see stats.js). */
export interface MomentSample {
  t: number; // window centre, run-relative ms
  bps: number; // B over the window; may be negative where misses outnumbered hits
}
export interface MomentaryRate {
  windowMs: number;
  stepMs: number;
  samples: MomentSample[];
}
export function momentaryRate(log: RunLog, windowMs?: number, stepMs?: number): MomentaryRate;
export function reportStats(log: RunLog): ReportStats;

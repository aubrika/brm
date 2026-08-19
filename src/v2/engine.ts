// GRID MODE engine (pointing). The keyboard Engine's counterpart for a grid: a selection is one
// cell click, not a keydown. Deliberately DOM-free and allocation-light on the hot path, exactly
// like Engine — it takes a cell index + a timestamp, updates counters, advances synchronously, and
// the canvas renderer reads this state once per rAF.
//
// One cell per selection, so N = gridSize². A stacked-layer variant used to live here (a selection
// was `depth` cells in distinct colours, clicked in order, making N = (gridSize²)^depth). It was
// removed once depth stopped being reachable: keeping a second scoring path alive for a mode no
// run can enter costs a branch on the hot path and a tuple allocation per selection, and every
// caller had to handle a 'partial' outcome that could never occur.

import { type RunResult, type Outcome, bitRate } from '../core/bitrate.js';
import { makeRandInt, SEQUENCE_LENGTH } from '../core/sequence.js';
import type { GridConfig } from '../core/config.js';

/** Run lifecycle. Declared here rather than shared with v1's engine: the two are independent state
 *  machines that happen to have the same three states, and importing this from v1 made the live
 *  game depend on the frozen one for a string union. */
export type EngineState = 'idle' | 'running' | 'ended';

export class GridEngine {
  readonly config: GridConfig;
  readonly scored: boolean;
  readonly gridSize: number; // cells per side
  readonly cells: number; // gridSize² — the alphabet size
  /** The N in log2(N - 1). A getter, not a second field: it IS `cells`, named for the role it
   *  plays in the score. Two stored fields holding one number is a thing that can drift. */
  get n(): number {
    return this.cells;
  }
  readonly sequence: number[]; // one i.i.d. uniform cell index per selection
  readonly logBits: number; // log2(N - 1), precomputed

  sc = 0; // completed selections
  si = 0; // wrong clicks
  index = 0; // current selection
  outOfField = 0; // pointerdowns outside the play field (counted once, like out-of-alphabet keys)
  startMs = 0;
  state: EngineState = 'idle';
  lastErrorMs = -Infinity; // drives the wrong-cell flash
  lastErrorCell = -1; // which cell was last clicked wrong (for the flash), -1 = none
  lastCorrectMs = -Infinity;
  lastCorrectCell = -1; // the cell just correctly completed — flags a repeated (same-cell) next target
  lastEventMs = -Infinity;
  private readonly errorsByCell: Record<string, number> = {};

  onCorrect: (() => void) | null = null;
  onError: (() => void) | null = null;
  onEnd: (() => void) | null = null;

  constructor(config: GridConfig, scored: boolean, randInt: (n: number) => number = makeRandInt()) {
    this.config = config;
    this.scored = scored;
    this.gridSize = config.gridSize;
    this.cells = this.gridSize * this.gridSize;
    this.sequence = new Array<number>(SEQUENCE_LENGTH);
    for (let i = 0; i < SEQUENCE_LENGTH; i++) this.sequence[i] = randInt(this.cells);
    this.logBits = Math.log2(this.n - 1);
  }

  start(nowMs: number): void {
    this.startMs = nowMs;
    this.state = 'running';
  }

  elapsedMs(nowMs: number): number {
    if (this.state === 'idle') return 0;
    if (this.state === 'ended') return this.config.durationMs;
    return nowMs - this.startMs;
  }

  remainingMs(nowMs: number): number {
    return Math.max(0, this.config.durationMs - (nowMs - this.startMs));
  }

  // The active cell — the one that must be clicked now. -1 past the end of the sequence.
  target(): number {
    const cell = this.sequence[this.index];
    return cell === undefined ? -1 : cell;
  }

  // A lookahead target: the cell `ahead` selections from the current one; -1 past the end of the
  // sequence. ahead=1 is the first lookahead outline, ahead=2 the one behind it.
  lookaheadTarget(ahead: number): number {
    const cell = this.sequence[this.index + ahead];
    return cell === undefined ? -1 : cell;
  }

  // The first lookahead: the next selection's cell; -1 if none.
  nextTarget(): number {
    return this.lookaheadTarget(1);
  }

  // Score a pointerdown on `cellIdx` (or -1 for a press outside the field). Synchronous:
  //  - hit the target → 'correct' (Sc++, advance)
  //  - any other cell → 'incorrect' (Si++); the target STAYS, so a miss is retried, not skipped
  handleClick(cellIdx: number, nowMs: number): Outcome {
    if (this.state !== 'running') return 'ignored';
    if (this.scored && nowMs - this.startMs >= this.config.durationMs) {
      this.end();
      return 'ignored';
    }
    if (cellIdx < 0 || cellIdx >= this.cells) {
      this.outOfField++;
      return 'ignored';
    }
    this.lastEventMs = nowMs;
    if (cellIdx === this.target()) {
      this.lastCorrectMs = nowMs;
      this.lastErrorCell = -1; // a correct click clears any lingering error flash
      this.lastCorrectCell = cellIdx; // the cell just completed (to flag a repeated next target)
      this.sc++;
      this.index++;
      this.onCorrect?.();
      return 'correct';
    }
    this.si++;
    const t = String(this.target());
    this.errorsByCell[t] = (this.errorsByCell[t] ?? 0) + 1;
    this.lastErrorMs = nowMs;
    this.lastErrorCell = cellIdx;
    this.onError?.();
    return 'incorrect';
  }

  tick(nowMs: number): void {
    if (this.scored && this.state === 'running' && nowMs - this.startMs >= this.config.durationMs) {
      this.end();
    }
  }

  end(): void {
    if (this.state !== 'ended') {
      this.state = 'ended';
      this.onEnd?.();
    }
  }

  liveBitRate(nowMs: number): number {
    const t = this.elapsedMs(nowMs) / 1000;
    return t > 0 ? (this.logBits * Math.max(this.sc - this.si, 0)) / t : 0;
  }

  liveAccuracy(): number {
    const total = this.sc + this.si;
    return total > 0 ? this.sc / total : 1;
  }

  // Authoritative result from the live counters (same RunResult shape the report/log expect).
  // errorsByTarget is keyed by the active cell at the time of each error; outcomes is empty
  // (per-selection detail lives in the event log).
  result(): RunResult {
    const t = this.config.durationMs / 1000;
    const total = this.sc + this.si;
    return {
      n: this.n,
      sc: this.sc,
      si: this.si,
      tSeconds: t,
      bitsPerSecond: bitRate(this.n, this.sc, this.si, t),
      accuracy: total > 0 ? this.sc / total : 0,
      grossPerSecond: t > 0 ? total / t : 0,
      netBits: this.logBits * Math.max(this.sc - this.si, 0),
      errorsByTarget: this.errorsByCell,
      outcomes: [],
    };
  }
}

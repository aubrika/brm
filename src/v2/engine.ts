// GRID MODE engine (pointing). The keyboard Engine's counterpart for a grid: a selection is one or
// more cell clicks, not a keydown. Deliberately DOM-free and allocation-light on the hot path,
// exactly like Engine — it takes a cell index + a timestamp, updates counters, advances
// synchronously, and the canvas renderer reads this state once per rAF.
//
// DEPTH (stacked "transparent" grids). A selection is `depth` cells, one per layer, drawn at once
// in distinct colours (layer 0 orange, layer 1 blue). You click them in order: the active layer's
// cell must be hit; a correct hit hides that layer and advances to the next; the last layer
// completes the selection. So depth 2 is a 4-tuple (x1,y1,x2,y2) picked as an orange cell then a
// blue cell, and N = (gridSize²)^depth = 1024² at 32×32. Any wrong click is an error and resets to
// layer 0 (the orange cell reappears). See bitrate-grid-mode-spec.md §3 (depth is an extension).

import { type RunResult, bitRate } from '../core/bitrate.js';
import { makeRandInt, SEQUENCE_LENGTH } from '../core/sequence.js';
import type { GameConfig } from '../core/config.js';
import type { EngineState } from '../v1/engine.js';

export type GridOutcome = 'correct' | 'partial' | 'incorrect' | 'ignored';

export class GridEngine {
  readonly config: GameConfig;
  readonly timed: boolean;
  readonly gridSize: number; // cells per side of a single layer
  readonly depth: number; // layers per selection (1 | 2)
  readonly cellsPerLayer: number; // gridSize²
  readonly n: number; // cellsPerLayer^depth — N for the bit-rate formula
  readonly sequence: number[][]; // each selection = `depth` i.i.d. uniform cell indices
  readonly logBits: number; // log2(N - 1), precomputed

  sc = 0; // completed selections (full tuples)
  si = 0; // wrong clicks
  index = 0; // current selection
  subIndex = 0; // active layer within the current selection (0 = orange, 1 = blue)
  outOfField = 0; // pointerdowns outside the play field (counted once, like out-of-alphabet keys)
  lastCompleted: number[] = []; // the cells of the selection that just completed (for the log)
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

  constructor(config: GameConfig, timed: boolean, randInt: (n: number) => number = makeRandInt()) {
    this.config = config;
    this.timed = timed;
    this.gridSize = config.gridSize;
    this.depth = Math.max(1, Math.round(config.gridDepth || 1));
    this.cellsPerLayer = this.gridSize * this.gridSize;
    this.n = Math.pow(this.cellsPerLayer, this.depth);
    this.sequence = new Array(SEQUENCE_LENGTH);
    for (let i = 0; i < SEQUENCE_LENGTH; i++) {
      const tuple = new Array<number>(this.depth);
      for (let d = 0; d < this.depth; d++) tuple[d] = randInt(this.cellsPerLayer);
      this.sequence[i] = tuple;
    }
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

  // The active cell — the one that must be clicked now (the current layer of the current selection).
  target(): number {
    const tuple = this.sequence[this.index];
    return tuple ? tuple[this.subIndex] : -1;
  }

  // The cell of a given layer in the current selection (for the renderer to draw all layers at once);
  // -1 if out of range.
  layerCell(layer: number): number {
    const tuple = this.sequence[this.index];
    return tuple && layer < tuple.length ? tuple[layer] : -1;
  }

  // A lookahead target: the first (orange) cell of the selection `ahead` steps from the current
  // one; -1 past the end of the sequence. ahead=1 is the ghost, ahead=2 the one behind it.
  lookaheadTarget(ahead: number): number {
    const tuple = this.sequence[this.index + ahead];
    return tuple ? tuple[0] : -1;
  }

  // The ghost: the next selection's first (orange) cell; -1 if none.
  nextTarget(): number {
    return this.lookaheadTarget(1);
  }

  // Score a pointerdown on `cellIdx` (or -1 for a press outside the field). Synchronous:
  //  - hit the active layer's cell → 'partial' if more layers remain, else 'correct' (Sc++, advance)
  //  - any other cell → 'incorrect' (Si++) and reset to layer 0 (the orange cell reappears)
  handleClick(cellIdx: number, nowMs: number): GridOutcome {
    if (this.state !== 'running') return 'ignored';
    if (this.timed && nowMs - this.startMs >= this.config.durationMs) {
      this.end();
      return 'ignored';
    }
    if (cellIdx < 0 || cellIdx >= this.cellsPerLayer) {
      this.outOfField++;
      return 'ignored';
    }
    this.lastEventMs = nowMs;
    if (cellIdx === this.target()) {
      this.lastCorrectMs = nowMs;
      this.lastErrorCell = -1; // a correct sub-click clears any lingering error flash
      this.subIndex++;
      if (this.subIndex >= this.depth) {
        this.lastCompleted = this.sequence[this.index].slice();
        this.lastCorrectCell = cellIdx; // the cell just completed (to flag a repeated next target)
        this.sc++;
        this.index++;
        this.subIndex = 0;
        this.onCorrect?.();
        return 'correct';
      }
      return 'partial'; // orange done; blue still to go
    }
    this.si++;
    const t = String(this.target());
    this.errorsByCell[t] = (this.errorsByCell[t] ?? 0) + 1;
    this.subIndex = 0; // reset the tuple — the orange cell reappears
    this.lastErrorMs = nowMs;
    this.lastErrorCell = cellIdx;
    this.onError?.();
    return 'incorrect';
  }

  tick(nowMs: number): void {
    if (this.timed && this.state === 'running' && nowMs - this.startMs >= this.config.durationMs) {
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

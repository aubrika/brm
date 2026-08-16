// GRID MODE engine (pointing). The keyboard Engine's counterpart for a 2D grid: a selection is a
// cell click, not a keydown. Deliberately DOM-free and allocation-light on the hot path, exactly
// like Engine — it takes a cell index + a timestamp, updates counters, advances synchronously, and
// the canvas renderer reads this state once per rAF. It exposes the same loop-facing surface the
// app's run loop drives (start / tick / state / timing / liveBitRate / liveAccuracy / result), so
// the shared loop treats keyboard and grid runs uniformly (see bitrate-grid-mode-spec.md §3).

import { type Outcome, type RunResult, bitRate, sampleCells, makeRandInt, SEQUENCE_LENGTH } from './scoring.js';
import type { GameConfig } from './config.js';
import type { EngineState } from './engine.js';

export class GridEngine {
  readonly config: GameConfig;
  readonly timed: boolean;
  readonly gridSize: number; // cells per side
  readonly n: number; // cell count = gridSize²; N for the bit-rate formula
  readonly sequence: number[]; // i.i.d. uniform cell indices
  readonly logBits: number; // log2(N - 1), precomputed

  sc = 0;
  si = 0;
  index = 0;
  outOfField = 0; // pointerdowns outside the play field (counted once, like out-of-alphabet keys)
  startMs = 0;
  state: EngineState = 'idle';
  lastErrorMs = -Infinity; // drives the wrong-cell flash
  lastErrorCell = -1; // which cell was last clicked wrong (for the flash), -1 = none
  lastCorrectMs = -Infinity;
  lastEventMs = -Infinity;
  private readonly errorsByCell: Record<string, number> = {};

  onCorrect: (() => void) | null = null;
  onError: (() => void) | null = null;
  onEnd: (() => void) | null = null;

  constructor(config: GameConfig, timed: boolean, randInt: (n: number) => number = makeRandInt()) {
    this.config = config;
    this.timed = timed;
    this.gridSize = config.gridSize;
    this.n = this.gridSize * this.gridSize;
    this.sequence = sampleCells(this.n, SEQUENCE_LENGTH, randInt);
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

  // The current target cell index (-1 past the end of the sequence, which never happens in 60 s).
  target(): number {
    return this.index < this.sequence.length ? this.sequence[this.index] : -1;
  }

  // The T+1 target cell (for the ghost); -1 if none.
  nextTarget(): number {
    return this.index + 1 < this.sequence.length ? this.sequence[this.index + 1] : -1;
  }

  // Score a pointerdown on cell `cellIdx` (or -1 for a press outside the field). Synchronous:
  // correct → Sc++ and advance immediately; any other cell → Si++ and the target stays
  // (retry-until-correct, matching the keyboard mode). Returns the outcome so the app can flash /
  // record; the renderer picks up the new state on the next frame.
  handleClick(cellIdx: number, nowMs: number): Outcome {
    if (this.state !== 'running') return 'ignored';
    if (this.timed && nowMs - this.startMs >= this.config.durationMs) {
      this.end();
      return 'ignored';
    }
    if (cellIdx < 0 || cellIdx >= this.n) {
      this.outOfField++;
      return 'ignored';
    }
    this.lastEventMs = nowMs;
    if (cellIdx === this.target()) {
      this.sc++;
      this.index++;
      this.lastCorrectMs = nowMs;
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

  // Called each frame; ends a timed run exactly at the window boundary (no time-based advancement —
  // grid targets only advance on a correct click).
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

  // Authoritative result, built from the live counters (grid scoring, like chords/challenge, isn't
  // a fold over a keydown log). Same RunResult shape the report/log expect; errorsByTarget is keyed
  // by cell index (as a string) and outcomes is empty (per-selection detail lives in the event log).
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

// The game engine: live run state + the synchronous keydown handler. Deliberately
// DOM-free (it takes plain key data + a timestamp) so the latency-critical path never
// touches layout, never waits on a frame, and stays unit-testable. The renderer reads
// this state once per rAF; input never waits on the renderer.

import {
  type RawKey,
  type Outcome,
  type RunResult,
  isSelection,
  reduceLog,
  generateSequence,
  makeRandInt,
  SEQUENCE_LENGTH,
} from './scoring.js';
import type { GameConfig } from './config.js';

export interface KeyInput {
  key: string;
  repeat: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export type EngineState = 'idle' | 'running' | 'ended';

export class Engine {
  readonly config: GameConfig;
  readonly timed: boolean;
  readonly chars: string[];
  readonly n: number;
  readonly alphaSet: Set<string>;
  readonly sequence: string[];
  readonly logBits: number; // log2(N - 1), precomputed

  sc = 0;
  si = 0;
  index = 0;
  startMs = 0;
  state: EngineState = 'idle';
  readonly log: RawKey[] = [];
  lastErrorMs = -Infinity; // drives the error shake/flash
  lastEventMs = -Infinity; // last state-changing keydown (for the latency overlay)

  onCorrect: (() => void) | null = null;
  onError: (() => void) | null = null;
  onEnd: (() => void) | null = null;

  constructor(config: GameConfig, timed: boolean, randInt: (n: number) => number = makeRandInt()) {
    this.config = config;
    this.timed = timed;
    this.chars = [...config.alphabet];
    this.n = this.chars.length;
    this.alphaSet = new Set(this.chars);
    this.sequence = generateSequence(config.alphabet, SEQUENCE_LENGTH, randInt);
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

  target(): string {
    return this.index < this.sequence.length ? this.sequence[this.index] : '';
  }

  // Synchronous and allocation-light: classify the key, update counters, advance the
  // index, record the raw event. Never reads/writes layout, never waits on a frame.
  // Returns the outcome so the caller can fire audio; the strip picks up state next rAF.
  handleKey(ev: KeyInput, nowMs: number): Outcome {
    if (this.state !== 'running') return 'ignored';
    const tMs = nowMs - this.startMs;
    if (this.timed && tMs >= this.config.durationMs) {
      this.end();
      return 'ignored';
    }
    if (ev.repeat) return 'ignored'; // auto-repeat: a non-event, not recorded

    const raw: RawKey = {
      key: ev.key,
      tMs,
      repeat: false,
      ctrlKey: ev.ctrlKey,
      metaKey: ev.metaKey,
      altKey: ev.altKey,
    };
    this.log.push(raw);

    if (!isSelection(raw, this.alphaSet)) return 'ignored';

    this.lastEventMs = nowMs;
    if (ev.key === this.target()) {
      this.sc++;
      this.index++;
      this.onCorrect?.();
      return 'correct';
    }
    this.si++;
    this.lastErrorMs = nowMs;
    this.onError?.();
    return 'incorrect';
  }

  // Called from the render loop; ends a timed run exactly at the window boundary.
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

  // Live displayed rate (uses elapsed t); the final report uses the full window.
  liveBitRate(nowMs: number): number {
    const t = this.elapsedMs(nowMs) / 1000;
    return t > 0 ? (this.logBits * Math.max(this.sc - this.si, 0)) / t : 0;
  }

  liveAccuracy(): number {
    const total = this.sc + this.si;
    return total > 0 ? this.sc / total : 1;
  }

  // Authoritative result — recomputed from the raw log, so what the report shows is
  // exactly what the exported log reproduces.
  result(): RunResult {
    return reduceLog(this.log, this.config.alphabet, this.sequence, this.config.durationMs);
  }
}

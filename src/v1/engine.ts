// The game engine: live run state + the synchronous keydown handler. Deliberately
// DOM-free (it takes plain key data + a timestamp) so the latency-critical path never
// touches layout, never waits on a frame, and stays unit-testable. The renderer reads
// this state once per rAF; input never waits on the renderer.

import { bitRate, type RunResult } from '../core/bitrate.js';
import { makeRandInt, sampleSequence, SEQUENCE_LENGTH } from '../core/sequence.js';
import {
  type RawKey,
  type Outcome,
  isSelection,
  symbolFor,
  buildSymbols,
  buildChordSymbols,
} from '../core/alphabet.js';
import { reduceLog } from './reduce.js';
import { type GameConfig, CHALLENGE_ABOVE, CHALLENGE_BELOW } from '../core/config.js';

export interface KeyInput {
  key: string;
  repeat: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  space?: boolean; // was the spacebar held? (chord mode)
}

export type EngineState = 'idle' | 'running' | 'ended';

export class Engine {
  readonly config: GameConfig;
  readonly timed: boolean;
  readonly chars: string[]; // base keys (finger/hand come from these)
  readonly symbols: string[]; // scored symbols; n = symbols.length
  readonly chord: boolean;
  readonly chords: boolean; // chords mode: a target is 1-3 keys pressed together
  readonly challenge: boolean; // challenge mode: fixed-rate scroll, hit before the band passes
  readonly n: number;
  readonly alphaSet: Set<string>;
  readonly sequence: string[];
  readonly logBits: number; // log2(N - 1), precomputed

  // chords mode: keys currently held, and every key pressed in the current press→release cycle
  private readonly heldKeys = new Set<string>();
  private readonly pressedKeys = new Set<string>();
  private readonly chordErrors: Record<string, number> = {};
  // challenge mode: rows the roll has scrolled past the hit line (target i is AT the line when this
  // == i). Set each frame by the app, which integrates the pacer-driven scroll rate over time.
  challengeProgress = 0;

  sc = 0;
  si = 0;
  index = 0;
  startMs = 0;
  state: EngineState = 'idle';
  readonly log: RawKey[] = [];
  lastErrorMs = -Infinity; // drives the error shake/flash
  lastCorrectMs = -Infinity; // drives the correct-keystroke pulse (rhythm feedback)
  lastEventMs = -Infinity; // last state-changing keydown (for the latency overlay)

  onCorrect: (() => void) | null = null;
  onError: (() => void) | null = null;
  onEnd: (() => void) | null = null;

  constructor(config: GameConfig, timed: boolean, randInt: (n: number) => number = makeRandInt()) {
    this.config = config;
    this.timed = timed;
    this.chars = [...config.alphabet];
    this.chord = config.chord;
    this.chords = config.chords;
    this.challenge = config.challenge && !config.chords; // challenge is a single-key experiment
    this.symbols = config.chords ? buildChordSymbols(config.alphabet) : buildSymbols(config.alphabet, config.chord);
    this.n = this.symbols.length; // N for the formula
    this.alphaSet = new Set(this.chars); // base keys are the selection keys
    this.sequence = sampleSequence(this.symbols, SEQUENCE_LENGTH, randInt);
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
      space: ev.space === true,
    };
    this.log.push(raw);

    if (!isSelection(raw, this.alphaSet)) return 'ignored';

    this.lastEventMs = nowMs;
    if (this.chords) {
      // build up a chord; it is scored on release (see handleKeyUp)
      this.pressedKeys.add(ev.key);
      this.heldKeys.add(ev.key);
      return 'ignored';
    }
    const produced = symbolFor(ev.key, ev.space === true, this.chord);
    if (this.challenge) {
      // The target is hittable while inside the band (ABOVE the line … BELOW it). A correct hit
      // clears it and advances; a correct key pressed before the target reaches the band is too
      // early and ignored (no penalty); a wrong key is an error and does not advance.
      if (produced === this.target()) {
        if (this.challengeProgress < this.index - CHALLENGE_ABOVE) return 'ignored'; // not in the band yet
        this.sc++;
        this.index++;
        this.lastCorrectMs = nowMs;
        this.onCorrect?.();
        return 'correct';
      }
      this.si++;
      this.lastErrorMs = nowMs;
      this.onError?.();
      return 'incorrect';
    }
    if (produced === this.target()) {
      this.sc++;
      this.index++;
      this.lastCorrectMs = nowMs;
      this.onCorrect?.();
      return 'correct';
    }
    this.si++;
    this.lastErrorMs = nowMs;
    this.onError?.();
    return 'incorrect';
  }

  // Challenge mode: a target that scrolls past the bottom of the band (challengeProgress beyond it
  // by more than BELOW) without being hit is a miss — counted like an incorrect selection. The
  // scroll position is supplied by the app (challengeProgress), which the strip renders from too,
  // so what you see at the band is exactly what scoring uses. Called each frame from tick().
  private challengeTick(nowMs: number): void {
    while (this.index < this.sequence.length && this.challengeProgress - this.index > CHALLENGE_BELOW) {
      this.si++; // missed: the target left the band unhit
      this.lastErrorMs = nowMs;
      this.onError?.();
      this.index++;
    }
  }

  // Chords mode only. A selection = the set of keys pressed together in one press→release
  // cycle, scored when the last key comes up (all keys released). The set must exactly match
  // the target chord — missing, extra, or wrong keys all make it incorrect (retry-until-right).
  handleKeyUp(key: string, nowMs: number): Outcome {
    if (this.state !== 'running' || !this.chords) return 'ignored';
    if (!this.heldKeys.delete(key)) return 'ignored';
    if (this.heldKeys.size > 0 || this.pressedKeys.size === 0) return 'ignored';
    const produced = [...this.pressedKeys].sort().join('');
    this.pressedKeys.clear();
    if (produced === this.target()) {
      this.sc++;
      this.index++;
      this.lastCorrectMs = nowMs;
      this.onCorrect?.();
      return 'correct';
    }
    this.si++;
    const target = this.target();
    this.chordErrors[target] = (this.chordErrors[target] ?? 0) + 1;
    this.lastErrorMs = nowMs;
    this.onError?.();
    return 'incorrect';
  }

  // Called from the render loop; advances challenge-mode targets by time and ends a timed run
  // exactly at the window boundary.
  tick(nowMs: number): void {
    if (this.state === 'running' && this.challenge) this.challengeTick(nowMs);
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

  // Authoritative result. Plain single-key mode folds the raw log (reduceLog). Chords and challenge
  // mode advance on timing (key-up / the fixed scroll), which the log-fold can't reconstruct, so
  // their result is built from the live counters instead.
  result(): RunResult {
    if (this.chords || this.challenge) {
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
        netBits: Math.log2(this.n - 1) * Math.max(this.sc - this.si, 0),
        errorsByTarget: this.chordErrors,
        outcomes: [],
      };
    }
    return reduceLog(this.log, this.config.alphabet, this.sequence, this.config.durationMs, this.config.chord);
  }
}

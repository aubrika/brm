// The v1 (keyboard) authoritative result: a fold over the raw keydown log. The falling-lanes game
// records every keypress and recomputes its score from that log at the end, so what the report
// screen shows and what the exported log recomputes to cannot disagree. v2 (grid) has no equivalent
// — its engine counts selections directly, because clicks carry no press/release ambiguity.

import { bitRate, type RunResult } from '../core/bitrate.js';
import { isSelection, symbolFor, type RawKey, type Outcome } from '../core/alphabet.js';

// Authoritative fold over the raw keydown log. Retry-until-correct: a wrong (in-alphabet)
// key increments Si and does NOT advance the target; the next keydown is evaluated normally.
// Only keys with 0 <= tMs < windowMs count. This is the number the report rests on.
export function reduceLog(
  log: readonly RawKey[],
  alphabet: string,
  sequence: readonly string[],
  windowMs: number,
  chord = false,
): RunResult {
  const set = new Set<string>([...alphabet]); // base keys (selection keys); space is not one
  const n = chord ? set.size * 2 : set.size; // N = symbol count for the bit-rate formula
  let sc = 0;
  let si = 0;
  let index = 0;
  const errorsByTarget: Record<string, number> = {};
  const outcomes: Outcome[] = [];
  for (const k of log) {
    if (k.tMs < 0 || k.tMs >= windowMs || !isSelection(k, set)) {
      outcomes.push('ignored');
      continue;
    }
    const produced = symbolFor(k.key, k.space === true, chord);
    const target = index < sequence.length ? sequence[index] : '';
    if (produced === target) {
      sc++;
      index++;
      outcomes.push('correct');
    } else {
      si++;
      errorsByTarget[target] = (errorsByTarget[target] ?? 0) + 1;
      outcomes.push('incorrect');
    }
  }
  const tSeconds = windowMs / 1000;
  return {
    n,
    sc,
    si,
    tSeconds,
    bitsPerSecond: bitRate(n, sc, si, tSeconds),
    accuracy: sc + si > 0 ? sc / (sc + si) : 0,
    grossPerSecond: tSeconds > 0 ? (sc + si) / tSeconds : 0,
    netBits: Math.log2(n - 1) * Math.max(sc - si, 0),
    errorsByTarget,
    outcomes,
  };
}

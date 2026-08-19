// reduceLog is v1's authoritative score: the fold over the raw keydown log that the report screen
// and the exported log both derive from, so what a player sees and what the file recomputes to
// cannot disagree. These pin the retry-until-correct rule and one hand-computed end-to-end value.
// They moved out of core/core.test.ts with the reducer they cover — v2 counts selections in its
// engine and has no equivalent fold.

import { describe, it, expect } from 'vitest';
import { reduceLog } from '../../src/v1/reduce.js';
import type { RawKey } from '../../src/v1/alphabet.js';

function rawKey(key: string, tMs: number, over: Partial<RawKey> = {}): RawKey {
  return { key, tMs, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...over };
}

describe('state machine (retry-until-correct)', () => {
  const alphabet = 'asdf';
  const seq = ['a', 's', 'd', 'f', 'a'];
  const W = 60_000;

  it('wrong in-alphabet key increments Si without advancing; next correct advances', () => {
    const log: RawKey[] = [
      rawKey('a', 100), // correct → Sc 1, target now 's'
      rawKey('d', 200), // wrong (target 's') → Si 1, target stays 's'
      rawKey('f', 250), // wrong again → Si 2, target stays 's'
      rawKey('s', 300), // correct → Sc 2, target now 'd'
    ];
    const r = reduceLog(log, alphabet, seq, W);
    expect(r.sc).toBe(2);
    expect(r.si).toBe(2);
    expect(r.outcomes).toEqual(['correct', 'incorrect', 'incorrect', 'correct']);
    expect(r.errorsByTarget).toEqual({ s: 2 });
  });

  it('ignores out-of-alphabet keys, auto-repeat, and modifier chords', () => {
    const log: RawKey[] = [
      rawKey('x', 100), // out of alphabet → ignored
      rawKey('a', 150, { repeat: true }), // auto-repeat → ignored
      rawKey('a', 200, { ctrlKey: true }), // ctrl chord → ignored
      rawKey('a', 250), // correct → Sc 1
      rawKey('Shift', 260), // out of alphabet → ignored
      rawKey('s', 300), // correct → Sc 2
    ];
    const r = reduceLog(log, alphabet, seq, W);
    expect(r.sc).toBe(2);
    expect(r.si).toBe(0);
    expect(r.outcomes).toEqual(['ignored', 'ignored', 'ignored', 'correct', 'ignored', 'correct']);
  });

  it('a genuine double-tap of the same key (repeat=false) registers twice', () => {
    // seq starts 'a','s'; hitting 'a' then 'a' again: first correct, second is wrong (target 's')
    const log: RawKey[] = [rawKey('a', 100), rawKey('a', 140)];
    const r = reduceLog(log, alphabet, seq, W);
    expect(r.sc).toBe(1);
    expect(r.si).toBe(1);
  });

  it('drops keys at or beyond the time window', () => {
    const log: RawKey[] = [rawKey('a', 59_999), rawKey('s', 60_000), rawKey('d', 60_001)];
    const r = reduceLog(log, alphabet, seq, W);
    expect(r.sc).toBe(1); // only the 59_999 ms key counts
    expect(r.outcomes).toEqual(['correct', 'ignored', 'ignored']);
  });
});

describe('end-to-end bit rate from a scripted log', () => {
  it('matches a hand-computed value', () => {
    const alphabet = 'asdf'; // N = 4 → log2(3) bits per net correct selection
    const seq = ['a', 's', 'd', 'f', 'a', 's', 'd', 'f'];
    const log: RawKey[] = [
      rawKey('a', 500), // correct   Sc=1
      rawKey('s', 1000), // correct  Sc=2
      rawKey('q', 1200), // ignored (out of alphabet)
      rawKey('f', 1500), // wrong (target 'd') Si=1
      rawKey('d', 1800), // correct  Sc=3
      rawKey('f', 2100), // correct  Sc=4
      rawKey('a', 2400), // correct  Sc=5
      rawKey('a', 2600, { repeat: true }), // ignored (auto-repeat)
      rawKey('a', 2800), // wrong in-alphabet key (target 's') Si=2
      rawKey('s', 3000), // correct  Sc=6
    ];
    const r = reduceLog(log, alphabet, seq, 60_000);
    expect(r.n).toBe(4);
    expect(r.sc).toBe(6);
    expect(r.si).toBe(2);
    // B = log2(3) * max(6 - 2, 0) / 60
    const expected = (Math.log2(3) * 4) / 60;
    expect(r.bitsPerSecond).toBeCloseTo(expected, 12);
    expect(r.netBits).toBeCloseTo(Math.log2(3) * 4, 12);
    expect(r.accuracy).toBeCloseTo(6 / 8, 12);
    expect(r.grossPerSecond).toBeCloseTo(8 / 60, 12);
    expect(r.errorsByTarget).toEqual({ d: 1, s: 1 });
  });
});

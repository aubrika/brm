import { describe, it, expect } from 'vitest';
import { bitRate } from './bitrate.js';
import { makeRandInt, generateSequence, type Uint32Source } from './sequence.js';
import { validateAlphabet, isSelection, type RawKey } from './alphabet.js';
import { reduceLog } from '../v1/reduce.js';

// A deterministic 32-bit word source (mulberry32) so the statistical tests are reproducible
// — they exercise OUR rejection-sampling / modulo pipeline for uniformity, given a uniform
// source. crypto.getRandomValues (the production default) is a platform primitive; the last
// test only checks that path stays in range.
function mulberry32Source(seed: number): Uint32Source {
  let a = seed >>> 0;
  return (out: Uint32Array) => {
    for (let i = 0; i < out.length; i++) {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      out[i] = (t ^ (t >>> 14)) >>> 0;
    }
  };
}

function rawKey(key: string, tMs: number, over: Partial<RawKey> = {}): RawKey {
  return { key, tMs, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...over };
}

// χ² critical values at α = 0.01. chi2 below the value ⟺ p > 0.01 (uniform not rejected).
const CHI2_CRIT_001: Record<number, number> = { 2: 9.2103, 7: 18.4753, 9: 21.666 };

describe('bitRate math', () => {
  // B = log2(N-1) * max(Sc - Si, 0) / t
  const cases: Array<[n: number, sc: number, si: number, t: number, expected: number]> = [
    [8, 0, 0, 60, 0], // nothing typed
    [8, 60, 0, 60, Math.log2(7)], // perfect: 1 correct/s → log2(7) bits/s
    [8, 420, 0, 60, (Math.log2(7) * 420) / 60],
    [8, 400, 12, 60, (Math.log2(7) * 388) / 60], // errors subtract
    [8, 10, 40, 60, 0], // Si > Sc → clamps to 0 via max(., 0)
    [3, 60, 0, 60, Math.log2(2)], // N=3: 1 bit per correct selection
    [3, 120, 0, 60, 2], // N=3, 2 correct/s → 2 bits/s
    [10, 300, 20, 60, (Math.log2(9) * 280) / 60],
    [8, 100, 0, 0, 0], // t = 0 guard
    [8, 100, 0, -5, 0], // negative t guard
  ];
  it.each(cases)('B(N=%i, Sc=%i, Si=%i, t=%i) = %f', (n, sc, si, t, expected) => {
    expect(bitRate(n, sc, si, t)).toBeCloseTo(expected, 10);
  });
});

describe('alphabet validation', () => {
  it('accepts the default', () => {
    expect(validateAlphabet('asdfjkl;')).toEqual({ ok: true, alphabet: 'asdfjkl;' });
  });
  it('rejects < 3 keys', () => {
    expect(validateAlphabet('ab')).toEqual({ ok: false, error: expect.stringContaining('at least 3') });
  });
  it('rejects repeats', () => {
    const r = validateAlphabet('aab');
    expect(r.ok).toBe(false);
  });
  it('rejects control characters', () => {
    const r = validateAlphabet('ab\n');
    expect(r.ok).toBe(false);
  });
  it('accepts a minimal 3-key set', () => {
    expect(validateAlphabet('dfj')).toEqual({ ok: true, alphabet: 'dfj' });
  });
});

describe('RNG uniformity (deterministic source)', () => {
  it.each([3, 8, 10])('is uniform for N=%i by χ² over 100k samples', (n) => {
    const alphabet = 'abcdefghij'.slice(0, n);
    const randInt = makeRandInt(mulberry32Source(0x1234 + n));
    const total = 100_000;
    const counts = new Map<string, number>();
    const seq = generateSequence(alphabet, total, randInt);
    for (const s of seq) counts.set(s, (counts.get(s) ?? 0) + 1);
    // every category present, none missing
    expect(counts.size).toBe(n);
    const expected = total / n;
    let chi2 = 0;
    for (const c of counts.values()) chi2 += (c - expected) ** 2 / expected;
    expect(chi2).toBeLessThan(CHI2_CRIT_001[n - 1]); // p > 0.01
  });

  it('has adjacent-repeat frequency ≈ 1/N (not filtered)', () => {
    const n = 8;
    const randInt = makeRandInt(mulberry32Source(99));
    const total = 200_000;
    const seq = generateSequence('asdfjkl;', total, randInt);
    let repeats = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i] === seq[i - 1]) repeats++;
    const rate = repeats / (total - 1);
    expect(rate).toBeCloseTo(1 / n, 2); // within ~0.005 of 0.125
  });

  it('rejection sampling removes modulo bias at the boundary', () => {
    // For n=3 the accept limit is floor(2^32 / 3) * 3 = 0xFFFFFFFF, so the single value
    // 0xFFFFFFFF is the top partial bucket and must be rejected (a naive x%3 would keep it
    // and over-represent residue 0). Feed 0xFFFFFFFF then 5: expect the first dropped.
    const feed = [0xffffffff, 5];
    let i = 0;
    const src: Uint32Source = (out) => {
      out[0] = feed[Math.min(i, feed.length - 1)];
      i++;
    };
    const randInt = makeRandInt(src);
    expect(randInt(3)).toBe(5 % 3); // skipped the rejected draw, landed on 5 → 2
    expect(i).toBe(2); // consumed one rejected draw + one accepted
  });

  it('crypto path (production default) stays in range', () => {
    const randInt = makeRandInt(); // real crypto.getRandomValues
    for (let i = 0; i < 5000; i++) {
      const v = randInt(8);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(8);
    }
  });
});

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

  it('isSelection encodes the rule directly', () => {
    const set = new Set(['a', 's']);
    expect(isSelection(rawKey('a', 0), set)).toBe(true);
    expect(isSelection(rawKey('x', 0), set)).toBe(false);
    expect(isSelection(rawKey('a', 0, { repeat: true }), set)).toBe(false);
    expect(isSelection(rawKey('a', 0, { metaKey: true }), set)).toBe(false);
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


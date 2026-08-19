import { describe, it, expect } from 'vitest';
import { bitRate } from '../../src/core/bitrate.js';
import { makeRandInt, sampleSequence, type Uint32Source } from '../../src/core/sequence.js';
import { momentaryRate } from '../../src/core/stats.js';
import type { RunLog, RawEvent } from '../../src/core/stats.js';

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


describe('RNG uniformity (deterministic source)', () => {
  it.each([3, 8, 10])('is uniform for N=%i by χ² over 100k samples', (n) => {
    const alphabet = 'abcdefghij'.slice(0, n);
    const randInt = makeRandInt(mulberry32Source(0x1234 + n));
    const total = 100_000;
    const counts = new Map<string, number>();
    const seq = sampleSequence([...alphabet], total, randInt);
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
    const seq = sampleSequence([...'asdfjkl;'], total, randInt);
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




// ------------------------------------------------- momentary rate + band ----
// The chart under "The run" is the only place in the report that makes an inferential claim —
// "this peak is real, that one is noise" — so the window arithmetic and the null band both get
// pinned. A band that is too tight would dress noise up as a finding.

/** A run at a chosen rate: one correct selection every `gapMs`, plus optional misses. */
function paceLog(gapMs: number, durationS = 60, n = 256, missEvery = 0): RunLog {
  const events: RawEvent[] = [];
  const seq: string[] = [];
  let t = 0;
  let i = 0;
  let sc = 0;
  let si = 0;
  while (t + gapMs <= durationS * 1000) {
    t += gapMs;
    if (missEvery > 0 && i % missEvery === missEvery - 1) {
      events.push([t, 'down', '99', i, 'err']);
      si++;
    } else {
      events.push([t, 'down', String(i % n), i, 'ok']);
      seq.push(String(i % n));
      sc++;
    }
    i++;
  }
  return {
    schemaVersion: 3,
    meta: { appVersion: '1', commit: 'c', runId: 'r', startedAt: '2026-01-01T00:00:00Z', mode: 'scored',
      machine: { installId: 'u', label: '', ua: '', platform: '', hardwareConcurrency: 1, estimatedRefreshHz: 60, timeOriginPrecisionMs: 0.1 },
      config: { mode: 'grid', n, durationMs: durationS * 1000, sound: false } },
    sequence: seq, eventColumns: ['t', 'type', 'key', 'idx', 'verdict'], events, latencySamples: [],
    summary: { bitsPerSecond: 0, n, sc, si, elapsedS: durationS, accuracy: sc / (sc + si),
      grossKeysPerSec: 0, netSelectionsPerSec: 0, medianIkiMs: gapMs, rollovers: 0, droppedFrames: 0, outOfAlphabet: 0 },
  };
}

describe('momentaryRate', () => {
  it('recovers a constant pace as a flat line at the right height', () => {
    // one selection every 500 ms at N=256 → log2(255) bits every 0.5 s ≈ 15.99 bits/s
    const { samples } = momentaryRate(paceLog(500));
    const expected = Math.log2(255) / 0.5;
    const mid = samples.filter((s) => s.t > 10_000 && s.t < 50_000); // away from the clipped edges
    for (const s of mid) expect(s.bps).toBeCloseTo(expected, 1);
  });

  it('follows a change of pace rather than averaging it away', () => {
    // fast for 30 s, then half speed — the cumulative HUD number would barely move here
    const fast = paceLog(400, 30).events;
    const slow = paceLog(800, 30).events.map(([t, ...rest]) => [(t) + 30_000, ...rest] as RawEvent);
    const log = paceLog(400, 60);
    log.events = [...fast, ...slow];
    const { samples } = momentaryRate(log);
    const at = (s: number): number => samples.find((x) => x.t === s * 1000)!.bps;
    expect(at(15)).toBeGreaterThan(at(50) * 1.7); // the second half really is about half the rate
  });

  it('goes negative where misses outnumber hits, instead of clamping to zero', () => {
    // every other click is a miss → net zero; two in three → negative
    const { samples } = momentaryRate(paceLog(400, 60, 256, 2));
    const mid = samples.filter((s) => s.t > 10_000 && s.t < 50_000);
    expect(Math.min(...mid.map((s) => s.bps))).toBeLessThanOrEqual(0.01);
  });

  it('sums to the run score over the whole window', () => {
    // a flat run's windowed rate should agree with log2(N-1)·(Sc-Si)/t computed directly
    const log = paceLog(600);
    const { samples } = momentaryRate(log, 60_000);
    const direct = (Math.log2(255) * (log.summary.sc - log.summary.si)) / 60;
    expect(samples[Math.floor(samples.length / 2)].bps).toBeCloseTo(direct, 1);
  });
});

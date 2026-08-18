// The analyzer's inferential statistics, checked against published values.
//
// Why this file exists: every other number in this project is descriptive — if it is wrong, it
// looks wrong. A p-value is not like that. A miscomputed one produces a confident, plausible,
// wrong answer about whether the lookahead ghost is worth keeping, and nothing downstream would
// ever flag it. So the t machinery is pinned to the textbook table, and the paired test is pinned
// to a hand-computable example.

import { describe, it, expect } from 'vitest';
import { tTwoSided, tQuantile, pairedTest, analyzeGhostAb, machineKey } from './analyze.mjs';

describe('t distribution', () => {
  // Published two-sided 5% critical values (any statistics table).
  const TABLE = [
    [1, 12.706],
    [4, 2.776],
    [7, 2.365],
    [8, 2.306],
    [9, 2.262],
    [29, 2.045],
  ];

  it('matches the two-sided 5% critical values', () => {
    for (const [df, crit] of TABLE) {
      expect(tQuantile(0.975, df)).toBeCloseTo(crit, 3);
      expect(tTwoSided(crit, df)).toBeCloseTo(0.05, 4);
    }
  });

  it('matches the 80% quantile used for the power calculation', () => {
    expect(tQuantile(0.8, 7)).toBeCloseTo(0.896, 3);
    expect(tQuantile(0.8, 11)).toBeCloseTo(0.876, 3);
  });

  it('approaches the normal in the large-sample limit', () => {
    expect(tQuantile(0.975, 100000)).toBeCloseTo(1.96, 3);
  });
});

describe('pairedTest', () => {
  // mean 0.3, sd 0.34641, n 8 → t = 2.4495, and 2.4495 sits just inside the df=7 5% critical value.
  const DIFFS = [0.5, -0.2, 0.8, 0.1, 0.4, -0.1, 0.6, 0.3];

  it('computes the paired t, its p and its CI', () => {
    const r = pairedTest(DIFFS);
    expect(r.n).toBe(8);
    expect(r.mean).toBeCloseTo(0.3, 10);
    expect(r.sd).toBeCloseTo(0.34641, 4);
    expect(r.t).toBeCloseTo(2.4495, 4);
    expect(r.p).toBeCloseTo(0.0441, 4);
    // CI = mean ± t(.975, 7)·se
    const se = r.sd / Math.sqrt(8);
    expect(r.lo).toBeCloseTo(0.3 - 2.365 * se, 3);
    expect(r.hi).toBeCloseTo(0.3 + 2.365 * se, 3);
    expect(r.lo).toBeGreaterThan(0); // and so the CI excludes zero, agreeing with p < 0.05
  });

  it('reports a t-based MDE, not the large-sample approximation', () => {
    const r = pairedTest(DIFFS);
    const se = r.sd / Math.sqrt(8);
    // (t.975 + t.80)·se at df=7. The textbook (1.96 + 0.842) = 2.802 form is ~16% optimistic here:
    // a Monte-Carlo of this function puts its true power at 67%, not the 80% it would claim.
    expect(r.mde).toBeCloseTo((2.365 + 0.896) * se, 3);
    expect(r.mde).toBeGreaterThan(2.802 * se);
  });

  it('degrades safely on a single pair rather than inventing a p', () => {
    const r = pairedTest([0.4]);
    expect(r.n).toBe(1);
    expect(r.p).toBeNaN();
  });
});

// ---- pairing ----------------------------------------------------------------
// Minimal logs: enough shape for analyzeGhostAb to pair and summarise. gridFitts needs events it
// does not get here, so the movement-time columns come out NaN — which is exactly the degraded
// case worth pinning, since a real run that logged no usable moves must not poison the mean.
function abLog(block, arm, bps, gridSize = 32, machine = 'test') {
  return {
    __file: `sim-${block}-${arm}.json`,
    schemaVersion: 3,
    meta: { mode: 'scored', startedAt: `2026-08-18T12:0${block}:00Z`, commit: 'test', machine: { label: machine, installId: 'u_' + machine }, config: { mode: 'grid', n: gridSize * gridSize, durationMs: 60000, sound: true } },
    ab: { experiment: 'ghost', arm, block, position: arm === 'on' ? 0 : 1 },
    grid: { enabled: true, gridSize, depth: 1, cellPx: 55, fieldPx: 55 * gridSize, ghost: arm === 'on', ghostAdjacent: [] },
    sequence: [],
    eventColumns: ['t', 'type', 'key', 'idx', 'verdict'],
    events: [],
    summary: { bitsPerSecond: bps, n: gridSize * gridSize, sc: 80, si: 2, elapsedS: 60, accuracy: 80 / 82 },
  };
}

describe('analyzeGhostAb pairing', () => {
  it('pairs by logged block and reports the within-pair difference', () => {
    const r = analyzeGhostAb([abLog(0, 'on', 13.5), abLog(0, 'off', 13.0), abLog(1, 'on', 12.8), abLog(1, 'off', 12.5)]);
    expect(r.pairs).toHaveLength(2);
    expect(r.tests.bps.mean).toBeCloseTo(0.4, 10); // mean of +0.5 and +0.3
    expect(r.dropped).toHaveLength(0);
  });

  it('drops a half-finished pair instead of comparing it to nothing', () => {
    const r = analyzeGhostAb([abLog(0, 'on', 13.5), abLog(0, 'off', 13.0), abLog(1, 'on', 12.8)]);
    expect(r.pairs).toHaveLength(1);
    expect(r.dropped[0].why).toMatch(/incomplete/);
  });

  it('drops a pair whose grid size changed — that difference is not the ghost', () => {
    const r = analyzeGhostAb([abLog(0, 'on', 13.5, 32), abLog(0, 'off', 9.0, 8)]);
    expect(r.pairs).toHaveLength(0);
    expect(r.dropped[0].why).toMatch(/grid size changed/);
  });

  it('ignores runs the harness never assigned, and practice runs', () => {
    const untagged = { ...abLog(0, 'on', 13.5) };
    delete untagged.ab;
    const practice = abLog(1, 'on', 13.5);
    practice.meta.mode = 'practice';
    expect(analyzeGhostAb([untagged, practice]).runs).toBe(0);
  });
});

describe('machineKey', () => {
  it('prefers the name, falls back to the install id, never pools the unknown', () => {
    expect(machineKey({ meta: { machine: { label: 'laptop', installId: 'u_x' } } })).toBe('laptop');
    expect(machineKey({ meta: { machine: { label: '', installId: 'u_x' } } })).toBe('u_x');
    expect(machineKey({ meta: {} })).toBe('(unknown)');
  });

  it('separates two displays that share a name-less config', () => {
    const a = { meta: { machine: { label: '', installId: 'u_desk' } } };
    const b = { meta: { machine: { label: '', installId: 'u_lap' } } };
    expect(machineKey(a)).not.toBe(machineKey(b));
  });
});

describe('analyzeGhostAb across machines', () => {
  it('drops a pair whose halves were played on different displays', () => {
    // Cell size in px is set by the window, so the two halves were not the same experiment —
    // and the difference would be attributed to the ghost.
    const r = analyzeGhostAb([abLog(0, 'on', 13.5, 32, 'desktop'), abLog(0, 'off', 9.0, 32, 'laptop')]);
    expect(r.pairs).toHaveLength(0);
    expect(r.dropped[0].why).toMatch(/two machines/);
  });

  it('still pairs normally within one machine', () => {
    const r = analyzeGhostAb([abLog(0, 'on', 13.5, 32, 'laptop'), abLog(0, 'off', 13.0, 32, 'laptop')]);
    expect(r.pairs).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });
});

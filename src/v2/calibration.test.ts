import { describe, it, expect } from 'vitest';
import {
  surviveRejection, estimateScatter, recommendGrid, WARMUP_DISCARD, SNAP_GRIDS, COLD_START,
  EFFECTIVE_WIDTH_COEF, generateBlockScript, summariseBlock, fitFittsLine, lineIsUsable,
  inflationRatio, estimateCandidates, recommendKnee, computeKnee, BLOCK_A_GRID, BLOCK_B_GRID,
  BLOCK_A_WARMUP, BLOCK_B_WARMUP, BLOCK_MEASURED, MEAN_DISTANCE_FRACTION, JUMP_MIN, JUMP_MAX,
  type CalibClick,
} from './calibration.js';

// ---- the v1 σ fallback, step by step --------------------------------
// These pin each numbered step of the algorithm documented at the top of calibration.ts, so that a
// change to any constant shows up as a failing expectation rather than as a quietly different
// recommendation months later.

const click = (dx: number, dy: number, mtMs = 500): CalibClick => ({ t: 0, targetCell: 0, dx, dy, mtMs });

describe('surviveRejection (steps 1-3)', () => {
  it('discards the warm-up clicks', () => {
    // 4 wild warm-up clicks that would wreck σ, then 16 tight ones
    const wild = Array.from({ length: WARMUP_DISCARD }, () => click(400, 400));
    const tight = Array.from({ length: 16 }, (_, i) => click(i % 5, -(i % 3)));
    const out = surviveRejection([...wild, ...tight], 50);
    expect(out).not.toBeNull();
    expect(out!.every((c) => Math.abs(c.dx) < 10)).toBe(true); // no warm-up survived
  });

  it('rejects endpoints beyond two cells, and the slowest tenth', () => {
    const cellPx = 50;
    const base = Array.from({ length: 18 }, (_, i) => click(i - 9, 0, 400 + i));
    const lapse = click(3 * cellPx, 0, 400); // > 2 cells out
    const dawdle = click(1, 0, 99_999); // slowest
    const out = surviveRejection([...Array.from({ length: WARMUP_DISCARD }, () => click(0, 0)), ...base, lapse, dawdle], cellPx)!;
    expect(out).toHaveLength(base.length - 1); // lapse rejected by distance, dawdle by time
    expect(out.some((c) => c.mtMs === 99_999)).toBe(false);
    expect(out.some((c) => c.dx === 3 * cellPx)).toBe(false);
  });

  it('returns null rather than a recommendation built on too little data', () => {
    expect(surviveRejection(Array.from({ length: 10 }, () => click(0, 0)), 50)).toBeNull();
  });
});

describe('estimateScatter (steps 4-5)', () => {
  it('pools the axes as RMS, never as max', () => {
    // σx = 10, σy = 0 → RMS = sqrt((100+0)/2) = 7.07, NOT 10
    const clicks = [click(-10, 0), click(10, 0), click(-10, 0), click(10, 0)];
    const s = estimateScatter(clicks);
    expect(s.sigmaX).toBeGreaterThan(s.sigmaY);
    expect(s.sigmaUsed).toBeCloseTo(Math.sqrt((s.sigmaX ** 2 + s.sigmaY ** 2) / 2), 10);
    expect(s.sigmaUsed).toBeLessThan(Math.max(s.sigmaX, s.sigmaY)); // the bug this replaced
  });

  it('applies the ISO effective-width coefficient', () => {
    const s = estimateScatter([click(-5, -5), click(5, 5), click(-5, 5), click(5, -5)]);
    expect(s.effectiveWidthPx).toBeCloseTo(EFFECTIVE_WIDTH_COEF * s.sigmaUsed, 10);
  });
});

describe('recommendGrid (steps 6-8)', () => {
  it('solves fieldPx / We, applies the cold-start factor, and snaps down', () => {
    // We = 40px on a 1600px field → 40 cells raw, × 0.85 = 34 → snaps down to 32
    const r = recommendGrid(40, 1600, 1);
    expect(r.raw).toBeCloseTo((1600 / 40) * COLD_START, 10);
    expect(r.raw).toBeCloseTo(34, 10);
    expect(r.grid).toBe(32);
  });

  it('snaps DOWN, never to the nearest', () => {
    // raw 31.9 is nearer to 32 than to 24, but coarser is the deliberate choice
    const we = (1600 * COLD_START) / 31.9;
    expect(recommendGrid(we, 1600, 1).clamped).toBeCloseTo(31.9, 6);
    expect(recommendGrid(we, 1600, 1).grid).toBe(24);
  });

  it('floors the cell size so a recommendation is always clickable', () => {
    const r = recommendGrid(0.5, 1600, 2); // absurdly precise → raw would be 2720 cells
    expect(r.raw).toBeGreaterThan(1000);
    expect(r.clamped).toBeLessThanOrEqual(1600 / r.cellFloorPx);
    expect(r.grid).toBe(64); // the top of the ladder
  });

  it('never returns anything off the ladder, at any scatter', () => {
    for (const we of [1, 5, 20, 50, 100, 200, 500, 2000]) {
      for (const dpr of [1, 2, 3]) {
        expect(SNAP_GRIDS as readonly number[]).toContain(recommendGrid(we, 1752, dpr).grid);
      }
    }
  });

  it('falls back to the coarsest-safe end when scatter is unmeasurable', () => {
    expect(recommendGrid(0, 1600, 1).grid).toBe(64);
  });

  // The documented degeneracy. Measured scatter is ~0.22·cellPx at every cell size, so feeding the
  // scatter a grid actually produces back into step 6 returns that same grid times a constant:
  //   raw = field / (4.133 · 0.22 · field/g) · 0.85 = g · 0.935
  // The procedure is a mirror. It answers "what grid did you calibrate on?" — which is why v2
  // replaced it. Pinned here at v1's old 24×24 reference: 0.935·24 ≈ 22.4, snapping to 16.
  // (v2 runs the σ fallback on block A at 16×16, so the same degeneracy now lands at 12.)
  it('hands back the grid it was calibrated on, times a constant — it does not measure the player', () => {
    const field = 1752;
    const SCATTER_RATIO = 0.22; // σ / cellPx, measured across a 10× range of cell sizes
    const expectedFactor = COLD_START / (EFFECTIVE_WIDTH_COEF * SCATTER_RATIO); // ≈ 0.935
    for (const g of [12, 16, 24, 32, 48, 64]) {
      const sigma = SCATTER_RATIO * (field / g);
      expect(recommendGrid(EFFECTIVE_WIDTH_COEF * sigma, field, 2).raw).toBeCloseTo(g * expectedFactor, 6);
    }
    // and so, run on the 24×24 reference grid as it always is, it lands just under 24 → snaps to 16
    const V1_REFERENCE_GRID = 24;
    const sigmaAtReference = SCATTER_RATIO * (field / V1_REFERENCE_GRID);
    const r = recommendGrid(EFFECTIVE_WIDTH_COEF * sigmaAtReference, field, 2);
    expect(r.raw).toBeCloseTo(V1_REFERENCE_GRID * expectedFactor, 6);
    expect(r.raw).toBeGreaterThan(16);
    expect(r.raw).toBeLessThan(24);
    expect(r.grid).toBe(16);
  });
});


// ============================================================================
// v2 — knee detection
// ============================================================================
// The v1 rule was degenerate for a reason worth not repeating: it solved an equation whose answer
// did not depend on the player. These tests are built around the question "does the recommendation
// actually move when the PLAYER changes?" — a synthetic fast hand and a synthetic shaky one must
// come out at different grids, and a player with no departure must be sent finer than one with a
// large departure.

/** A synthetic block: `count` clicks that obey MT = (a + b·ID)·inflation, with a chosen accuracy.
 *  Targets walk the grid so distances vary, which is what makes the regression possible at all. */
function syntheticBlock(gridSize: number, fieldPx: number, count: number, a: number, b: number, inflation = 1, accuracy = 1): CalibClick[] {
  const w = fieldPx / gridSize;
  const script = generateBlockScript(gridSize, count, 0x1234);
  const out: CalibClick[] = [];
  for (let i = 0; i < script.length; i++) {
    const prev = i > 0 ? script[i - 1] : script[0];
    const from = { x: ((prev % gridSize) + 0.5) * w, y: (Math.floor(prev / gridSize) + 0.5) * w };
    const to = { x: ((script[i] % gridSize) + 0.5) * w, y: (Math.floor(script[i] / gridSize) + 0.5) * w };
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    const id = Math.log2(d / w + 1);
    const miss = accuracy < 1 && i % Math.max(2, Math.round(1 / (1 - accuracy))) === 0;
    out.push({
      t: i * 500,
      targetCell: script[i],
      dx: miss ? w * 0.9 : w * 0.1, // a miss lands outside the cell but well inside the 2-cell cut
      dy: 0,
      mtMs: Math.round((a + b * id) * 1000 * inflation),
      block: gridSize === gridSize ? 'A' : 'A',
    });
  }
  return out;
}

const FIELD = 896; // 16×16 → 56px cells, 64×64 → 14px cells

describe('generateBlockScript', () => {
  it('is deterministic and stays inside the grid', () => {
    const a = generateBlockScript(16, 16, 7);
    expect(a).toEqual(generateBlockScript(16, 16, 7));
    for (const c of a) expect(c).toBeGreaterThanOrEqual(0), expect(c).toBeLessThan(256);
  });

  it('keeps jumps inside the specified band, so the block spans a range of difficulty', () => {
    for (const g of [BLOCK_A_GRID, BLOCK_B_GRID]) {
      const cells = generateBlockScript(g, 40, 3);
      const ds: number[] = [];
      for (let i = 1; i < cells.length; i++) {
        const a = cells[i - 1], b = cells[i];
        ds.push(Math.hypot((b % g) - (a % g), Math.floor(b / g) - Math.floor(a / g)) / g);
      }
      const inBand = ds.filter((d) => d >= JUMP_MIN * 0.9 && d <= JUMP_MAX * 1.1);
      expect(inBand.length).toBeGreaterThan(ds.length * 0.9);
      // and the spread is real — a block of identical jumps would fit a slope through nothing
      expect(Math.max(...ds) - Math.min(...ds)).toBeGreaterThan(0.15);
    }
  });
});

describe('summariseBlock', () => {
  it('measures distance from the previous target, using the warm-up as the anchor', () => {
    const raw = syntheticBlock(BLOCK_A_GRID, FIELD, BLOCK_A_WARMUP + BLOCK_MEASURED, 0.2, 0.1);
    const block = summariseBlock(raw, BLOCK_A_GRID, FIELD, BLOCK_A_WARMUP)!;
    expect(block.clicks).toHaveLength(BLOCK_MEASURED); // warm-up excluded, but it anchored the first
    expect(block.w).toBeCloseTo(FIELD / BLOCK_A_GRID, 10);
    for (const c of block.clicks) expect(c.distancePx).toBeGreaterThan(0);
  });

  it('keeps block B\'s slow tail out of the fit set but inside the median', () => {
    const raw = syntheticBlock(BLOCK_B_GRID, FIELD, BLOCK_B_WARMUP + BLOCK_MEASURED, 0.2, 0.1);
    const block = summariseBlock(raw, BLOCK_B_GRID, FIELD, BLOCK_B_WARMUP)!;
    expect(block.fitClicks.length).toBeLessThan(block.clicks.length); // slowest 10% dropped from the fit
    expect(block.clicks.length).toBe(BLOCK_MEASURED); // but all of them still count for the median
  });

  it('returns null when too few clicks survive', () => {
    expect(summariseBlock(syntheticBlock(BLOCK_A_GRID, FIELD, 6, 0.2, 0.1), BLOCK_A_GRID, FIELD, BLOCK_A_WARMUP)).toBeNull();
  });
});

describe('fitFittsLine', () => {
  it('recovers the line it was generated from', () => {
    const raw = syntheticBlock(BLOCK_A_GRID, FIELD, BLOCK_A_WARMUP + BLOCK_MEASURED, 0.25, 0.12);
    const line = fitFittsLine(summariseBlock(raw, BLOCK_A_GRID, FIELD, BLOCK_A_WARMUP)!);
    expect(line.a).toBeCloseTo(0.25, 2);
    expect(line.b).toBeCloseTo(0.12, 2);
    expect(line.r2).toBeGreaterThan(0.99); // noiseless input
    expect(lineIsUsable(line)).toBe(true);
  });

  it('rejects a line with no slope as noise rather than fitting it anyway', () => {
    const raw = syntheticBlock(BLOCK_A_GRID, FIELD, BLOCK_A_WARMUP + BLOCK_MEASURED, 0.5, 0);
    const line = fitFittsLine(summariseBlock(raw, BLOCK_A_GRID, FIELD, BLOCK_A_WARMUP)!);
    expect(lineIsUsable(line)).toBe(false); // b ≤ 0 — the σ fallback takes over
  });
});

describe('inflationRatio', () => {
  it('reads 1 when block B sits on block A\'s line', () => {
    const a = summariseBlock(syntheticBlock(BLOCK_A_GRID, FIELD, 16, 0.25, 0.12), BLOCK_A_GRID, FIELD, BLOCK_A_WARMUP)!;
    const b = summariseBlock(syntheticBlock(BLOCK_B_GRID, FIELD, 14, 0.25, 0.12), BLOCK_B_GRID, FIELD, BLOCK_B_WARMUP)!;
    expect(inflationRatio(fitFittsLine(a), b)).toBeCloseTo(1, 1);
  });

  it('reads the departure when block B runs slow', () => {
    const a = summariseBlock(syntheticBlock(BLOCK_A_GRID, FIELD, 16, 0.25, 0.12), BLOCK_A_GRID, FIELD, BLOCK_A_WARMUP)!;
    const b = summariseBlock(syntheticBlock(BLOCK_B_GRID, FIELD, 14, 0.25, 0.12, 1.4), BLOCK_B_GRID, FIELD, BLOCK_B_WARMUP)!;
    expect(inflationRatio(fitFittsLine(a), b)).toBeCloseTo(1.4, 1);
  });
});

describe('estimateCandidates', () => {
  const blocks = () => ({
    a: summariseBlock(syntheticBlock(BLOCK_A_GRID, FIELD, 16, 0.25, 0.12), BLOCK_A_GRID, FIELD, BLOCK_A_WARMUP)!,
    b: summariseBlock(syntheticBlock(BLOCK_B_GRID, FIELD, 14, 0.25, 0.12), BLOCK_B_GRID, FIELD, BLOCK_B_WARMUP)!,
  });

  it('leaves candidates at or coarser than block A uninflated, and interpolates in log-width', () => {
    const { a, b } = blocks();
    const cands = estimateCandidates(fitFittsLine(a), 1.4, a, b, FIELD);
    const at = (g: number) => cands.find((c) => c.grid === g)!;
    expect(at(12).inflation).toBe(1); // coarser than block A
    expect(at(16).inflation).toBe(1); // block A itself
    expect(at(64).inflation).toBeCloseTo(1.4, 6); // block B itself — the measured value, not extrapolated
    // 32 is halfway between 16 and 64 in log-width, so half the inflation
    expect(at(32).inflation).toBeCloseTo(1.2, 6);
  });

  it('never extrapolates inflation beyond the measured span', () => {
    const { a, b } = blocks();
    for (const c of estimateCandidates(fitFittsLine(a), 1.4, a, b, FIELD)) {
      expect(c.inflation).toBeGreaterThanOrEqual(1);
      expect(c.inflation).toBeLessThanOrEqual(1.4 + 1e-9);
    }
  });

  it('uses T(g) = a + b·log2(f·g + 1)', () => {
    const { a, b } = blocks();
    const line = fitFittsLine(a);
    const c = estimateCandidates(line, 1, a, b, FIELD).find((x) => x.grid === 32)!;
    expect(c.baselineS).toBeCloseTo(line.a + line.b * Math.log2(MEAN_DISTANCE_FRACTION * 32 + 1), 10);
  });
});

describe('recommendKnee', () => {
  const cands = (peak: number) =>
    (SNAP_GRIDS as readonly number[]).map((grid) => ({
      grid, w: FIELD / grid, baselineS: 0.5, inflation: 1, accuracy: 1,
      bEst: 10 - Math.abs(Math.log2(grid) - Math.log2(peak)), // a peak at `peak`
    }));

  it('steps one candidate coarser than the argmax', () => {
    const r = recommendKnee(cands(32), FIELD, 1);
    expect(r.argmaxGrid).toBe(32);
    expect(r.grid).toBe(24); // one coarser on the ladder
  });

  it('cannot step below the coarsest candidate', () => {
    expect(recommendKnee(cands(12), FIELD, 1).grid).toBe(12);
  });

  it('honours the pixel floor even when the estimate wants finer', () => {
    const tiny = 400; // 400px field: 64² would be 6.25px cells
    const r = recommendKnee(cands(64), tiny, 2);
    expect(tiny / r.grid).toBeGreaterThanOrEqual(r.cellFloorPx);
  });
});

describe('computeKnee end to end', () => {
  const run = (inflation: number) =>
    computeKnee(
      syntheticBlock(BLOCK_A_GRID, FIELD, BLOCK_A_WARMUP + BLOCK_MEASURED, 0.25, 0.12),
      syntheticBlock(BLOCK_B_GRID, FIELD, BLOCK_B_WARMUP + BLOCK_MEASURED, 0.25, 0.12, inflation),
      { fieldPx: FIELD, devicePixelRatio: 1, sigmaFallbackGrid: 16 },
    );

  it('sends a player with no departure finer than one with a large departure', () => {
    // This is the property v1 could not have: the recommendation must depend on the PLAYER.
    const clean = run(1.0)!;
    const shaky = run(1.8)!;
    expect(clean.v2.method).toBe('knee');
    expect(shaky.v2.method).toBe('knee');
    expect(clean.v2.recommendedGrid).toBeGreaterThan(shaky.v2.recommendedGrid);
  });

  it('records the departure it measured and scores every candidate', () => {
    const r = run(1.4)!;
    expect(r.v2.inflationRatio).toBeCloseTo(1.4, 1);
    expect(Object.keys(r.v2.bEstByCandidate).map(Number).sort((a, b) => a - b)).toEqual([...SNAP_GRIDS]);
    expect(r.v2.blockA.gridSize).toBe(BLOCK_A_GRID);
    expect(r.v2.blockB.gridSize).toBe(BLOCK_B_GRID);
  });

  it('falls back to the σ rule when block A will not fit', () => {
    const r = computeKnee(
      syntheticBlock(BLOCK_A_GRID, FIELD, BLOCK_A_WARMUP + BLOCK_MEASURED, 0.5, 0), // flat: no slope
      syntheticBlock(BLOCK_B_GRID, FIELD, BLOCK_B_WARMUP + BLOCK_MEASURED, 0.5, 0),
      { fieldPx: FIELD, devicePixelRatio: 1, sigmaFallbackGrid: 24 },
    )!;
    expect(r.v2.method).toBe('sigma-fallback');
    expect(r.v2.recommendedGrid).toBe(24); // whatever σ said
  });

  it('returns null when a block is too short to say anything', () => {
    expect(
      computeKnee(syntheticBlock(BLOCK_A_GRID, FIELD, 6, 0.25, 0.12), syntheticBlock(BLOCK_B_GRID, FIELD, 14, 0.25, 0.12), {
        fieldPx: FIELD, devicePixelRatio: 1, sigmaFallbackGrid: 16,
      }),
    ).toBeNull();
  });
});

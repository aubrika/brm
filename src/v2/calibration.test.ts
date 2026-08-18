import { describe, it, expect } from 'vitest';
import {
  generateCalibrationScript, computeCalibration, seededRandInt, surviveRejection, estimateScatter,
  recommendGrid, REFERENCE_GRID, CALIB_CLICKS, WARMUP_DISCARD, SNAP_GRIDS, COLD_START,
  EFFECTIVE_WIDTH_COEF, type CalibClick,
} from './calibration.js';

describe('generateCalibrationScript', () => {
  it('is deterministic and produces CALIB_CLICKS in-range cells', () => {
    const a = generateCalibrationScript();
    const b = generateCalibrationScript();
    expect(a).toEqual(b); // seeded → identical
    expect(a.length).toBe(CALIB_CLICKS);
    for (const c of a) expect(c).toBeGreaterThanOrEqual(0), expect(c).toBeLessThan(REFERENCE_GRID * REFERENCE_GRID);
  });

  it('mostly makes long jumps (≥ ⅓ grid) between consecutive targets', () => {
    const g = REFERENCE_GRID;
    const cells = generateCalibrationScript();
    let longs = 0;
    for (let i = 1; i < cells.length; i++) {
      const a = cells[i - 1], b = cells[i];
      const d = Math.hypot((b % g) - (a % g), Math.floor(b / g) - Math.floor(a / g));
      if (d >= Math.ceil(g / 3)) longs++;
    }
    expect(longs).toBeGreaterThan(cells.length * 0.6); // the majority are long jumps
  });
});

// Build synthetic clicks with a controlled Gaussian-ish scatter (deterministic) around cell centres.
function synthClicks(sigma: number, count = CALIB_CLICKS): CalibClick[] {
  const script = generateCalibrationScript();
  const rnd = seededRandInt(42);
  const gauss = () => {
    // sum of 3 uniforms − 1.5 → mean 0, sd ≈ 0.5; scale to `sigma`
    return ((rnd(1000) / 1000 + rnd(1000) / 1000 + rnd(1000) / 1000) - 1.5) * (sigma / 0.5);
  };
  const clicks: CalibClick[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    const mt = 400 + rnd(200);
    t += mt;
    clicks.push({ t, targetCell: script[i], dx: gauss(), dy: gauss(), mtMs: mt });
  }
  return clicks;
}

describe('computeCalibration', () => {
  it('recovers a small σ and recommends a fine grid', () => {
    const fieldPx = 720;
    const c = computeCalibration(synthClicks(4), { fieldPx, referenceGrid: REFERENCE_GRID, devicePixelRatio: 1, pointerType: 'mouse' });
    expect(c).not.toBeNull();
    if (!c) return;
    expect(c.sigmaUsed).toBeGreaterThan(2);
    expect(c.sigmaUsed).toBeLessThan(7);
    // We ≈ 4.133·σ ≈ 17–29px; fieldPx/We ≈ 25–42 × 0.85 → snaps to 24 or 32
    expect([24, 32]).toContain(c.recommendedGrid);
    expect(c.chosenGrid).toBe(c.recommendedGrid);
    expect(c.overridden).toBe(false);
  });

  it('recommends a coarser grid for a shakier hand (larger σ)', () => {
    const fieldPx = 720;
    const fine = computeCalibration(synthClicks(4), { fieldPx, referenceGrid: REFERENCE_GRID, devicePixelRatio: 1, pointerType: 'mouse' });
    const shaky = computeCalibration(synthClicks(14), { fieldPx, referenceGrid: REFERENCE_GRID, devicePixelRatio: 1, pointerType: 'mouse' });
    expect(fine && shaky).toBeTruthy();
    if (!fine || !shaky) return;
    expect(shaky.sigmaUsed).toBeGreaterThan(fine.sigmaUsed);
    expect(shaky.recommendedGrid).toBeLessThanOrEqual(fine.recommendedGrid);
  });

  it('returns null when too few samples survive rejection', () => {
    // only 8 clicks total → after discarding 4 warm-up, 4 remain (< 12)
    const c = computeCalibration(synthClicks(4, 8), { fieldPx: 720, referenceGrid: REFERENCE_GRID, devicePixelRatio: 1, pointerType: 'mouse' });
    expect(c).toBeNull();
  });

  it('snaps the recommendation to an allowed grid size', () => {
    const c = computeCalibration(synthClicks(6), { fieldPx: 720, referenceGrid: REFERENCE_GRID, devicePixelRatio: 1, pointerType: 'mouse' });
    expect(c).not.toBeNull();
    if (!c) return;
    expect([12, 16, 24, 32, 48, 64]).toContain(c.recommendedGrid);
  });
});

// ---- the grid-choice algorithm, step by step --------------------------------
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
  // The procedure is a mirror. It answers "what grid did you calibrate on?", and since that is
  // always REFERENCE_GRID the recommendation is pinned near 0.935·24 ≈ 22.4 — which snaps to 16.
  // Everything else the recommendation does is noise in the σ estimate moving it off that value.
  it('hands back the grid it was calibrated on, times a constant — it does not measure the player', () => {
    const field = 1752;
    const SCATTER_RATIO = 0.22; // σ / cellPx, measured across a 10× range of cell sizes
    const expectedFactor = COLD_START / (EFFECTIVE_WIDTH_COEF * SCATTER_RATIO); // ≈ 0.935
    for (const g of [12, 16, 24, 32, 48, 64]) {
      const sigma = SCATTER_RATIO * (field / g);
      expect(recommendGrid(EFFECTIVE_WIDTH_COEF * sigma, field, 2).raw).toBeCloseTo(g * expectedFactor, 6);
    }
    // and so, run on the 24×24 reference grid as it always is, it lands just under 24 → snaps to 16
    const sigmaAtReference = SCATTER_RATIO * (field / REFERENCE_GRID);
    const r = recommendGrid(EFFECTIVE_WIDTH_COEF * sigmaAtReference, field, 2);
    expect(r.raw).toBeCloseTo(REFERENCE_GRID * expectedFactor, 6);
    expect(r.raw).toBeGreaterThan(16);
    expect(r.raw).toBeLessThan(24);
    expect(r.grid).toBe(16);
  });
});

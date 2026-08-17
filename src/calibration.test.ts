import { describe, it, expect } from 'vitest';
import { generateCalibrationScript, computeCalibration, seededRandInt, REFERENCE_GRID, CALIB_CLICKS, type CalibClick } from './calibration.js';

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

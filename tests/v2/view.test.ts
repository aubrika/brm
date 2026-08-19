// Geometry tests for GRID MODE (v2) — the load-bearing arithmetic behind every click.
// `cellIndexAt` decides correct-vs-error on every selection, and `fitGridGeometry` fixes the cell
// size W that every logged Fitts number is derived from, so both are worth pinning down exactly.

import { describe, it, expect } from 'vitest';
import {
  fitGridGeometry, cellIndexAt, cellsApart, visibleLookahead,
  availableFieldPx, fitTouchGrid, TOUCH_MIN_CELL_PX, TOUCH_GRID_LADDER,
} from '../../src/v2/view.js';
/** Grid sizes the canvas renderer is swept against. A geometry question, not a game setting —
 *  the game itself is fixed at 32×32 — so the list lives with the test that uses it. */
const GRID_SIZES = [8, 16, 24, 32, 64, 128] as const;

describe('fitGridGeometry', () => {
  it('never overflows the available space, at any offered grid size', () => {
    for (const g of GRID_SIZES) {
      for (const avail of [200, 383, 640, 720, 901, 1440]) {
        const { cellPx, fieldPx } = fitGridGeometry(avail, g);
        // Overflow would push cells outside the clipping container — targets you cannot click.
        expect(fieldPx).toBeLessThanOrEqual(avail);
        expect(cellPx).toBeGreaterThanOrEqual(1);
        expect(fieldPx).toBe(cellPx * g); // field is exactly a whole number of cells
        expect(Number.isInteger(cellPx)).toBe(true); // integer px keeps gridlines crisp
      }
    }
  });

  it('uses the whole space it can, leaving less than one cell of slack', () => {
    const { cellPx, fieldPx } = fitGridGeometry(901, 32);
    expect(cellPx).toBe(28);
    expect(901 - fieldPx).toBeLessThan(cellPx);
  });
});

describe('cellIndexAt', () => {
  const G = 32;
  const CELL = 20; // field 640

  it('maps a cell centre to that cell, for every cell in the grid', () => {
    for (let row = 0; row < G; row++) {
      for (let col = 0; col < G; col++) {
        const x = (col + 0.5) * CELL;
        const y = (row + 0.5) * CELL;
        expect(cellIndexAt(x, y, CELL, G)).toBe(row * G + col);
      }
    }
  });

  it('is half-open per cell — the boundary belongs to the higher cell', () => {
    expect(cellIndexAt(0, 0, CELL, G)).toBe(0);
    expect(cellIndexAt(CELL - 0.01, 0, CELL, G)).toBe(0);
    expect(cellIndexAt(CELL, 0, CELL, G)).toBe(1); // exact edge → next cell, never double-counted
    expect(cellIndexAt(0, CELL, CELL, G)).toBe(G); // first cell of row 1
  });

  it('returns -1 outside the field on every side', () => {
    expect(cellIndexAt(-1, 10, CELL, G)).toBe(-1);
    expect(cellIndexAt(10, -1, CELL, G)).toBe(-1);
    expect(cellIndexAt(G * CELL, 10, CELL, G)).toBe(-1); // one px past the right edge
    expect(cellIndexAt(10, G * CELL, CELL, G)).toBe(-1);
    expect(cellIndexAt(G * CELL - 0.01, G * CELL - 0.01, CELL, G)).toBe(G * G - 1); // last cell
  });
});

describe('cellsApart', () => {
  const G = 32;
  it('is Chebyshev distance in cells', () => {
    expect(cellsApart(0, 0, G)).toBe(0);
    expect(cellsApart(0, 1, G)).toBe(1); // horizontal neighbour
    expect(cellsApart(0, G, G)).toBe(1); // vertical neighbour
    expect(cellsApart(0, G + 1, G)).toBe(1); // diagonal neighbour is still 1
    expect(cellsApart(0, G * G - 1, G)).toBe(G - 1); // opposite corners
  });
  it('is symmetric', () => {
    expect(cellsApart(5, 700, G)).toBe(cellsApart(700, 5, G));
  });
});

describe('visibleLookahead', () => {
  // The i.i.d. sequence repeats a cell roughly every 1/N selections, so T+1 can land on the target
  // and T+2 on T+1. Two outlines stacked on one cell reads as two targets, which is exactly the
  // ambiguity the preview exists to remove — so only the first (brightest) claim survives.
  it('draws every lookahead when they are all distinct', () => {
    expect(visibleLookahead(5, [9, 40])).toEqual([true, true]);
  });

  it('skips a lookahead that lands on the current target', () => {
    expect(visibleLookahead(5, [5, 40])).toEqual([false, true]); // T+1 repeats the target
    expect(visibleLookahead(5, [9, 5])).toEqual([true, false]); // T+2 comes back to the target
  });

  it('skips T+2 when it repeats T+1, keeping the brighter outline', () => {
    expect(visibleLookahead(5, [9, 9])).toEqual([true, false]);
  });

  it('handles the end of the sequence and a lookahead of zero', () => {
    expect(visibleLookahead(5, [])).toEqual([]);
    expect(visibleLookahead(5, [-1])).toEqual([false]);
  });
});

describe('availableFieldPx', () => {
  // The grid is a square, so the SMALLER viewport dimension binds — the fact that makes "just fill
  // the width on mobile" impossible: on a portrait phone the width already is the smaller one.
  it('is bounded by the smaller dimension, in either orientation', () => {
    expect(availableFieldPx(342, 643)).toBe(availableFieldPx(643, 342));
    expect(availableFieldPx(800, 300)).toBeLessThan(availableFieldPx(800, 800));
  });

  it('never returns a field too small to draw', () => {
    expect(availableFieldPx(0, 0)).toBeGreaterThanOrEqual(64);
    expect(availableFieldPx(10, 10)).toBeGreaterThanOrEqual(64);
  });
});

describe('fitTouchGrid', () => {
  // Measured play areas from emulated devices; the expectations are what a fingertip can hit.
  const DEVICES: Array<[string, number]> = [
    ['iPhone SE portrait', 327],
    ['iPhone 14 portrait', 342],
    ['iPhone 14 landscape', 300],
    ['iPad portrait', 772],
  ];

  it('never returns a grid whose cells are below the touch floor', () => {
    for (const [, avail] of DEVICES) {
      const g = fitTouchGrid(avail);
      expect(Math.floor(avail / g)).toBeGreaterThanOrEqual(TOUCH_MIN_CELL_PX);
    }
  });

  it('returns the FINEST grid that still clears the floor, not merely a safe one', () => {
    for (const [, avail] of DEVICES) {
      const g = fitTouchGrid(avail);
      const finer = (TOUCH_GRID_LADDER as readonly number[]).filter((x) => x > g);
      for (const f of finer) expect(Math.floor(avail / f)).toBeLessThan(TOUCH_MIN_CELL_PX);
    }
  });

  it('gives a phone a coarse grid and a tablet a finer one', () => {
    expect(fitTouchGrid(342)).toBeLessThan(fitTouchGrid(772));
  });

  it('falls back to the coarsest rung rather than an unhittable grid', () => {
    expect(fitTouchGrid(50)).toBe(TOUCH_GRID_LADDER[0]);
  });

  it('stays on the ladder at every size, so N is always one of the known values', () => {
    for (let avail = 64; avail <= 2000; avail += 7) {
      expect(TOUCH_GRID_LADDER as readonly number[]).toContain(fitTouchGrid(avail));
    }
  });

  it('is monotonic: a bigger screen never gets a coarser grid', () => {
    let prev = 0;
    for (let avail = 64; avail <= 2000; avail += 7) {
      const g = fitTouchGrid(avail);
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
  });
});

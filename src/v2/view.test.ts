// Geometry tests for GRID MODE (v2) — the load-bearing arithmetic behind every click.
// `cellIndexAt` decides correct-vs-error on every selection, and `fitGridGeometry` fixes the cell
// size W that every logged Fitts number is derived from, so both are worth pinning down exactly.

import { describe, it, expect } from 'vitest';
import { fitGridGeometry, cellIndexAt, cellsApart } from './view.js';
import { GRID_SIZES } from '../core/config.js';

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

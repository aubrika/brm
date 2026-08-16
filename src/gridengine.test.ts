import { describe, it, expect } from 'vitest';
import { GridEngine } from './gridengine.js';
import { DEFAULT_CONFIG } from './config.js';
import { sampleCells } from './scoring.js';

function cfg(gridSize: number, gridDepth = 1) {
  return { ...DEFAULT_CONFIG, grid: true, gridSize, gridDepth, durationMs: 60_000 };
}

// Deterministic RNG: hand back a fixed list of cell indices, cycling.
function seqRand(values: number[]): (n: number) => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('sampleCells', () => {
  it('draws `count` indices in [0, cellCount) from the injected source', () => {
    const out = sampleCells(1024, 5, seqRand([0, 1023, 500, 7, 42]));
    expect(out).toEqual([0, 1023, 500, 7, 42]);
  });
});

describe('GridEngine (depth 1)', () => {
  it('sizes N as gridSize² and log2(N-1)', () => {
    const e = new GridEngine(cfg(32), true, seqRand([0]));
    expect(e.n).toBe(1024);
    expect(e.logBits).toBeCloseTo(Math.log2(1023), 10);
  });

  it('advances on a correct click and holds on a wrong one (retry-until-correct)', () => {
    const e = new GridEngine(cfg(16), true, seqRand([3, 10, 7]));
    e.start(0);
    expect(e.target()).toBe(3);
    expect(e.nextTarget()).toBe(10);

    expect(e.handleClick(3, 100)).toBe('correct');
    expect(e.sc).toBe(1);
    expect(e.target()).toBe(10); // advanced

    expect(e.handleClick(5, 200)).toBe('incorrect'); // wrong cell
    expect(e.si).toBe(1);
    expect(e.target()).toBe(10); // did NOT advance
    expect(e.lastErrorCell).toBe(5);

    expect(e.handleClick(10, 300)).toBe('correct');
    expect(e.sc).toBe(2);
  });

  it('counts an out-of-field press without recording a selection', () => {
    const e = new GridEngine(cfg(16), true, seqRand([3]));
    e.start(0);
    expect(e.handleClick(-1, 50)).toBe('ignored');
    expect(e.outOfField).toBe(1);
    expect(e.sc).toBe(0);
    expect(e.si).toBe(0);
    expect(e.target()).toBe(3); // unchanged
  });

  it('ignores clicks before start and after end', () => {
    const e = new GridEngine(cfg(16), true, seqRand([3]));
    expect(e.handleClick(3, 0)).toBe('ignored'); // idle
    e.start(0);
    e.end();
    expect(e.handleClick(3, 10)).toBe('ignored'); // ended
  });

  it('produces a RunResult with the bit-rate formula and cell-keyed errors', () => {
    const e = new GridEngine(cfg(16), true, seqRand([1, 2]));
    e.start(0);
    e.handleClick(1, 100); // correct
    e.handleClick(9, 200); // wrong (target is 2)
    const r = e.result();
    expect(r.n).toBe(256);
    expect(r.sc).toBe(1);
    expect(r.si).toBe(1);
    expect(r.bitsPerSecond).toBe(0); // sc - si = 0 → clamped
    expect(r.errorsByTarget['2']).toBe(1); // keyed by the cell index that was the target
  });
});

describe('GridEngine (depth 2 — orange+blue pairs)', () => {
  it('sizes N as (gridSize²)² for a 4-tuple', () => {
    const e = new GridEngine(cfg(32, 2), true, seqRand([0, 1]));
    expect(e.cellsPerLayer).toBe(1024);
    expect(e.n).toBe(1024 * 1024); // 1_048_576
    expect(e.logBits).toBeCloseTo(Math.log2(1024 * 1024 - 1), 10);
  });

  it('needs orange then blue to complete one selection', () => {
    // sequence: selection 0 = [5 (orange), 9 (blue)], selection 1 = [2, 7]
    const e = new GridEngine(cfg(16, 2), true, seqRand([5, 9, 2, 7]));
    e.start(0);
    expect(e.target()).toBe(5); // orange first
    expect(e.subIndex).toBe(0);
    expect(e.layerCell(0)).toBe(5);
    expect(e.layerCell(1)).toBe(9);
    expect(e.nextTarget()).toBe(2); // ghost = next orange

    expect(e.handleClick(5, 100)).toBe('partial'); // orange correct — not scored yet
    expect(e.sc).toBe(0);
    expect(e.subIndex).toBe(1);
    expect(e.target()).toBe(9); // now blue

    expect(e.handleClick(9, 200)).toBe('correct'); // blue completes the 4-tuple
    expect(e.sc).toBe(1);
    expect(e.lastCompleted).toEqual([5, 9]);
    expect(e.index).toBe(1);
    expect(e.subIndex).toBe(0);
    expect(e.target()).toBe(2); // next selection's orange
  });

  it('a wrong click during the blue phase resets to orange and counts an error', () => {
    const e = new GridEngine(cfg(16, 2), true, seqRand([5, 9, 2, 7]));
    e.start(0);
    e.handleClick(5, 100); // orange ok → blue phase
    expect(e.subIndex).toBe(1);
    expect(e.handleClick(11, 150)).toBe('incorrect'); // wrong during blue
    expect(e.si).toBe(1);
    expect(e.subIndex).toBe(0); // reset — orange reappears
    expect(e.target()).toBe(5); // must click orange again
    // clicking blue while orange is active is also wrong
    expect(e.handleClick(9, 160)).toBe('incorrect');
    expect(e.si).toBe(2);
    expect(e.target()).toBe(5);
  });
});

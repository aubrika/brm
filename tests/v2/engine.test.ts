import { describe, it, expect } from 'vitest';
import { GridEngine } from '../../src/v2/engine.js';
import { DEFAULT_GRID_CONFIG } from '../../src/core/config.js';
import { sampleCells } from '../../src/core/sequence.js';

function cfg(gridSize: number) {
  return { ...DEFAULT_GRID_CONFIG, gridSize, durationMs: 60_000 };
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

describe('GridEngine', () => {
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

  // app.ts writes String(lastCorrectCell) as the event `key` of every scored selection, and the
  // analyzer joins that column back to `sequence` to recompute B independently. If the two ever
  // disagree the log stops being self-verifying, which is the whole point of keeping one.
  it('reports the completed cell, matching the sequence entry the log will carry', () => {
    const e = new GridEngine(cfg(16), true, seqRand([3, 10, 7]));
    e.start(0);
    expect(e.handleClick(3, 100)).toBe('correct');
    expect(e.lastCorrectCell).toBe(3);
    expect(String(e.sequence[0])).toBe('3');

    e.handleClick(99, 150); // a miss must not move it
    expect(e.lastCorrectCell).toBe(3);

    e.handleClick(10, 200);
    expect(e.lastCorrectCell).toBe(10);
    expect(String(e.sequence[1])).toBe('10');
  });

  it('exposes each lookahead target, and runs out at the end of the sequence', () => {
    const e = new GridEngine(cfg(16), true, seqRand([3, 10, 7, 2]));
    e.start(0);
    expect(e.lookaheadTarget(0)).toBe(3); // 0 steps ahead is the current target
    expect(e.lookaheadTarget(1)).toBe(10);
    expect(e.lookaheadTarget(2)).toBe(7);
    expect(e.nextTarget()).toBe(e.lookaheadTarget(1)); // the ghost is just lookahead 1

    e.handleClick(3, 100);
    expect(e.lookaheadTarget(1)).toBe(7); // the whole chain shifts with the index
    expect(e.lookaheadTarget(2)).toBe(2);

    // Past the end there is nothing to preview; the renderer must get -1, not a stale cell.
    expect(e.lookaheadTarget(e.sequence.length)).toBe(-1);
  });

  it('allows a repeated target (i.i.d. sampling with replacement)', () => {
    const e = new GridEngine(cfg(16), true, seqRand([5, 5, 9])); // same cell twice in a row
    e.start(0);
    expect(e.target()).toBe(5);
    expect(e.nextTarget()).toBe(5); // the repeat: next target is the same cell
    expect(e.handleClick(5, 100)).toBe('correct');
    expect(e.sc).toBe(1);
    expect(e.target()).toBe(5); // still 5 — the repeat
    expect(e.lastCorrectCell).toBe(5); // flags the repeat for the confirm-flash
    expect(e.handleClick(5, 200)).toBe('correct');
    expect(e.sc).toBe(2);
    expect(e.target()).toBe(9);
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

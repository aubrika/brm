// The A/B harness's one job is BALANCE: whatever the coin does, each pair of scored runs must
// contain one ghost-on run and one ghost-off run. If that ever breaks, the comparison silently
// becomes confounded with session drift, and nothing downstream would notice.

import { describe, it, expect } from 'vitest';
import { initialState, peek, advance, newBlockOrder, completedPairs, type AbState, type Arm } from './ab.js';

/** Deterministic coin: cycles through the supplied values. */
function coin(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

/** The arms the next `runs` scored runs would be assigned. */
function armSequence(runs: number, rand: () => number): Arm[] {
  let s = initialState(rand);
  const out: Arm[] = [];
  for (let i = 0; i < runs; i++) {
    out.push(peek(s).arm);
    s = advance(s, rand);
  }
  return out;
}

describe('ghost A/B harness', () => {
  it('gives every pair one on and one off, whatever the coin does', () => {
    for (const flips of [[0], [0.9], [0, 0.9], [0.9, 0, 0.2, 0.7]]) {
      const arms = armSequence(20, coin(flips));
      for (let i = 0; i < arms.length; i += 2) {
        expect(new Set(arms.slice(i, i + 2))).toEqual(new Set(['on', 'off']));
      }
      // and therefore balanced overall — the property the whole design exists for
      expect(arms.filter((a) => a === 'on')).toHaveLength(10);
    }
  });

  it('randomises which arm leads each pair', () => {
    expect(newBlockOrder(() => 0.1)).toEqual(['on', 'off']);
    expect(newBlockOrder(() => 0.9)).toEqual(['off', 'on']);
    // alternating flips → the lead alternates, so arms do NOT simply alternate run to run
    expect(armSequence(4, coin([0.1, 0.9]))).toEqual(['on', 'off', 'off', 'on']);
  });

  it('peek does not consume the assignment', () => {
    const s = initialState(() => 0.1);
    expect(peek(s)).toEqual(peek(s));
    expect(peek(s).arm).toBe('on');
    expect(advance(s, () => 0.1).position).toBe(1); // only advance moves it
  });

  it('counts a pair as complete only after both runs', () => {
    let s: AbState = initialState(() => 0.1);
    expect(completedPairs(s)).toBe(0);
    s = advance(s, () => 0.1);
    expect(completedPairs(s)).toBe(0); // one run in: not a pair yet
    s = advance(s, () => 0.1);
    expect(completedPairs(s)).toBe(1);
  });

  it('stamps block and position so the analyzer can pair runs exactly', () => {
    let s = initialState(() => 0.1);
    expect(peek(s)).toEqual({ experiment: 'ghost', arm: 'on', block: 0, position: 0 });
    s = advance(s, () => 0.1);
    expect(peek(s)).toEqual({ experiment: 'ghost', arm: 'off', block: 0, position: 1 });
    s = advance(s, () => 0.9);
    expect(peek(s)).toEqual({ experiment: 'ghost', arm: 'off', block: 1, position: 0 });
  });
});

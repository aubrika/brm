import { describe, it, expect } from 'vitest';
import { Engine, type KeyInput } from './engine.js';
import { DEFAULT_CONFIG } from './config.js';

const key = (k: string): KeyInput => ({ key: k, repeat: false, ctrlKey: false, metaKey: false, altKey: false });

// buildChordSymbols('asdfjkl;') orders: 8 singles, then 2-key combos ('as' is the first, index 8).
const chordEngine = (randIndex: number): Engine =>
  new Engine({ ...DEFAULT_CONFIG, chords: true, alphabet: 'asdfjkl;' }, true, () => randIndex);

describe('chords mode (press keys together, scored on release)', () => {
  it('a chord is correct when exactly its keys were pressed together and released', () => {
    const eng = chordEngine(8); // every target = 'as'
    eng.start(0);
    expect(eng.n).toBe(8 + 28 + 56); // singles + pairs + triples
    expect(eng.target()).toBe('as');

    eng.handleKey(key('a'), 100);
    eng.handleKey(key('s'), 110);
    eng.handleKeyUp('a', 150);
    expect(eng.sc).toBe(0); // 's' still held — not complete yet
    eng.handleKeyUp('s', 160);
    expect(eng.sc).toBe(1); // all released, pressed set === target
    expect(eng.index).toBe(1);
  });

  it('a partial or wrong set is incorrect and does not advance', () => {
    const eng = chordEngine(8); // target = 'as'
    eng.start(0);
    eng.handleKey(key('a'), 100);
    eng.handleKeyUp('a', 150); // pressed {a} ≠ 'as'
    expect(eng.si).toBe(1);
    expect(eng.index).toBe(0); // retry: target unchanged

    eng.handleKey(key('a'), 200);
    eng.handleKey(key('d'), 210); // wrong extra key
    eng.handleKeyUp('a', 250);
    eng.handleKeyUp('d', 260); // pressed {a,d} ≠ 'as'
    expect(eng.si).toBe(2);
    expect(eng.sc).toBe(0);
  });

  it('key order within the chord does not matter', () => {
    const eng = chordEngine(8); // target = 'as'
    eng.start(0);
    eng.handleKey(key('s'), 100); // press s first
    eng.handleKey(key('a'), 110);
    eng.handleKeyUp('s', 150);
    eng.handleKeyUp('a', 160);
    expect(eng.sc).toBe(1);
  });
});

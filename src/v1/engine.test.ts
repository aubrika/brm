// v1 (legacy keyboard game) engine: the single-key falling-lanes path, which is all that remains
// after the chords / challenge / pacer experiments were retired. v1 is frozen but still shipped at
// /brm/v1, so its scoring is worth pinning down.

import { describe, it, expect } from 'vitest';
import { Engine } from './engine.js';
import { DEFAULT_KEYBOARD_CONFIG } from './config.js';

const cfg = { ...DEFAULT_KEYBOARD_CONFIG, alphabet: 'asdfjkl;', durationMs: 60_000 };
const key = (k: string) => ({ key: k, repeat: false, ctrlKey: false, metaKey: false, altKey: false });

/** Deterministic target sequence. */
function engineOver(targets: string[]): Engine {
  let i = 0;
  const chars = [...cfg.alphabet];
  return new Engine(cfg, true, () => chars.indexOf(targets[i++ % targets.length]));
}

describe('v1 Engine', () => {
  it('advances on the right key and holds on the wrong one', () => {
    const e = engineOver(['a', 'j', 'l']);
    e.start(0);
    expect(e.target()).toBe('a');

    expect(e.handleKey(key('a'), 100)).toBe('correct');
    expect(e.sc).toBe(1);
    expect(e.target()).toBe('j');

    expect(e.handleKey(key('f'), 200)).toBe('incorrect'); // wrong key
    expect(e.si).toBe(1);
    expect(e.target()).toBe('j'); // retry-until-correct: no advance

    expect(e.handleKey(key('j'), 300)).toBe('correct');
    expect(e.sc).toBe(2);
  });

  it('ignores auto-repeat, modified and out-of-alphabet keys', () => {
    const e = engineOver(['a']);
    e.start(0);
    expect(e.handleKey({ ...key('a'), repeat: true }, 10)).toBe('ignored');
    expect(e.handleKey({ ...key('a'), ctrlKey: true }, 20)).toBe('ignored');
    expect(e.handleKey({ ...key('a'), metaKey: true }, 30)).toBe('ignored');
    expect(e.handleKey(key('z'), 40)).toBe('ignored'); // not in the alphabet
    expect(e.sc).toBe(0);
    expect(e.si).toBe(0);
    expect(e.target()).toBe('a');
  });

  it('ignores input before start and after the window closes', () => {
    const e = engineOver(['a']);
    expect(e.handleKey(key('a'), 0)).toBe('ignored'); // idle
    e.start(0);
    expect(e.handleKey(key('a'), 60_000)).toBe('ignored'); // at the boundary
    expect(e.state).toBe('ended');
    expect(e.sc).toBe(0);
  });

  it('ends a timed run exactly at the window boundary', () => {
    const e = engineOver(['a']);
    e.start(0);
    e.tick(59_999);
    expect(e.state).toBe('running');
    e.tick(60_000);
    expect(e.state).toBe('ended');
  });

  it('result() folds the keydown log back to the same score', () => {
    const e = engineOver(['a', 'j']);
    e.start(0);
    e.handleKey(key('a'), 100); // correct
    e.handleKey(key('f'), 200); // wrong
    e.handleKey(key('j'), 300); // correct
    const r = e.result();
    expect(r.n).toBe(8);
    expect(r.sc).toBe(2);
    expect(r.si).toBe(1);
    // B = log2(N-1)·max(Sc-Si,0)/t — the fold must agree with the live counters
    expect(r.bitsPerSecond).toBeCloseTo((Math.log2(7) * 1) / 60, 10);
  });
});

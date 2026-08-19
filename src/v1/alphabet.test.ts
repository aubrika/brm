// v1's input rules: which key sets a player may choose, and which keydowns count as selections.
// Both are v1-only — the grid game answers the same questions with a hit test — so these moved out
// of core/core.test.ts alongside the module they cover.

import { describe, it, expect } from 'vitest';
import { validateAlphabet, isSelection, type RawKey } from './alphabet.js';

function rawKey(key: string, tMs: number, over: Partial<RawKey> = {}): RawKey {
  return { key, tMs, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...over };
}

describe('alphabet validation', () => {
  it('accepts the default', () => {
    expect(validateAlphabet('asdfjkl;')).toEqual({ ok: true, alphabet: 'asdfjkl;' });
  });
  it('rejects < 3 keys', () => {
    const r = validateAlphabet('ab');
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toContain('at least 3');
  });
  it('rejects repeats', () => {
    const r = validateAlphabet('aab');
    expect(r.ok).toBe(false);
  });
  it('rejects control characters', () => {
    const r = validateAlphabet('ab\n');
    expect(r.ok).toBe(false);
  });
  it('accepts a minimal 3-key set', () => {
    expect(validateAlphabet('dfj')).toEqual({ ok: true, alphabet: 'dfj' });
  });
});

describe('isSelection', () => {
  it('encodes the rule directly', () => {
    const set = new Set(['a', 's']);
    expect(isSelection(rawKey('a', 0), set)).toBe(true);
    expect(isSelection(rawKey('x', 0), set)).toBe(false);
    expect(isSelection(rawKey('a', 0, { repeat: true }), set)).toBe(false);
    expect(isSelection(rawKey('a', 0, { metaKey: true }), set)).toBe(false);
  });
});

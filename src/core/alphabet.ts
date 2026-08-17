// Keyboard alphabet helpers: validating a player-chosen key set, and turning a keydown into the
// SYMBOL it produced. Used by v1 (the falling-lanes keyboard game) and by the config screen; the
// grid game (v2) has no alphabet — its symbols are cell indices.

// ---------------------------------------------------------------- alphabet ----
export const DEFAULT_LOOKAHEAD = 7; // v1: how many upcoming targets the falling strip shows

export type AlphabetResult = { ok: true; alphabet: string } | { ok: false; error: string };

// Validate a candidate alphabet: >= 3 entries, each a single printable character, all unique.
export function validateAlphabet(input: string): AlphabetResult {
  const chars = [...input]; // split by code point
  if (chars.length < 3) return { ok: false, error: 'Alphabet needs at least 3 unique keys.' };
  for (const c of chars) {
    const cp = c.codePointAt(0);
    if (cp === undefined || cp < 0x20 || cp === 0x7f) {
      return { ok: false, error: 'Keys must be printable characters.' };
    }
  }
  if (new Set(chars).size !== chars.length) {
    return { ok: false, error: 'Alphabet keys must be unique — no repeats allowed.' };
  }
  return { ok: true, alphabet: chars.join('') };
}

// -------------------------------------------------------- state machine --------
export interface RawKey {
  key: string; // KeyboardEvent.key
  tMs: number; // ms since t=0 (the moment the first target was shown)
  repeat: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export type Outcome = 'correct' | 'incorrect' | 'ignored';

// A keydown participates in scoring (is a "selection") iff it is an in-alphabet key with no
// auto-repeat and no ctrl/meta/alt modifier. Everything else is ignored entirely.
export function isSelection(
  k: Pick<RawKey, 'key' | 'repeat' | 'ctrlKey' | 'metaKey' | 'altKey'>,
  alphabet: ReadonlySet<string>,
): boolean {
  if (k.repeat) return false;
  if (k.ctrlKey || k.metaKey || k.altKey) return false;
  return alphabet.has(k.key);
}

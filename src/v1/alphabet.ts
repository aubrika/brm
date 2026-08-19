// Keyboard alphabet helpers: validating a player-chosen key set, and deciding which keydowns
// count. v1 ONLY — the grid game has no alphabet, because its symbols are cell indices and its
// "is this a selection" question is a hit test (core/grid.js) rather than a key-set membership
// test. This lived in core/ back when both games were expected to share an input model; they
// never did, and every export below is reachable only from v1 and the v1 config screen.

// ---------------------------------------------------------------- alphabet ----
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

// Keyboard alphabet helpers: validating a player-chosen key set, and turning a keydown into the
// SYMBOL it produced. Used by v1 (the falling-lanes keyboard game) and by the config screen; the
// grid game (v2) has no alphabet — its symbols are cell indices.

// ---------------------------------------------------------------- alphabet ----
export const DEFAULT_ALPHABET = 'asdfjkl;'; // one key per finger, home row (N = 8)
export const DEFAULT_LOOKAHEAD = 7; // v1: how many upcoming targets the falling strip shows
export const MIN_LOOKAHEAD = 5;

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

export function alphabetSize(alphabet: string): number {
  return [...alphabet].length;
}

// The scored SYMBOL set. With chord on, every base key gains a "*" variant meaning "pressed
// while the spacebar (thumb) is held" — doubling N without any hand movement. The base key
// still determines finger/hand/lane; the star is purely the thumb.
export function buildSymbols(alphabet: string, chord: boolean): string[] {
  const chars = [...alphabet];
  if (!chord) return chars;
  const out: string[] = [];
  for (const c of chars) {
    out.push(c);
    out.push(c + '*');
  }
  return out;
}

// "Chords" mode symbol set: every 1-, 2-, and 3-key combination of the alphabet, each as a
// sorted key-string ('a', 'as', 'ads'). A target may be several keys pressed at once.
export function buildChordSymbols(alphabet: string): string[] {
  const chars = [...alphabet];
  const n = chars.length;
  const out: string[] = [];
  const sorted = (s: string): string => [...s].sort().join('');
  for (let i = 0; i < n; i++) out.push(chars[i]);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push(sorted(chars[i] + chars[j]));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) out.push(sorted(chars[i] + chars[j] + chars[k]));
  return out;
}

// The symbol a keydown produces: base key alone, or base+"*" when chord is on and space held.
export function symbolFor(key: string, spaceHeld: boolean, chord: boolean): string {
  return chord && spaceHeld ? key + '*' : key;
}

// -------------------------------------------------------- state machine --------
export interface RawKey {
  key: string; // KeyboardEvent.key (the base key; space is tracked separately, not logged here)
  tMs: number; // ms since t=0 (the moment the first target was shown)
  repeat: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  space?: boolean; // was the spacebar held at this keydown? (chord mode; absent = false)
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

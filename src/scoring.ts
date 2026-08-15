// Pure scoring core — NO DOM imports, no side effects beyond the injected RNG source.
// The whole submission's headline number is produced here, so it is kept small, literal,
// and exhaustively unit-tested (see scoring.test.ts). The UI layer records a raw keydown
// log and hands it to reduceLog(); that fold is the single source of truth for the score,
// so what the panel sees on screen is exactly what the exported log recomputes to.

export const DEFAULT_ALPHABET = 'asdfjkl;'; // one key per finger, home row (N=8)
export const SCORED_DURATION_MS = 60_000;
export const DEFAULT_LOOKAHEAD = 7;
export const MIN_LOOKAHEAD = 5;
export const SEQUENCE_LENGTH = 1500; // comfortably above any achievable keystroke count in 60 s

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

export function alphabetSize(alphabet: string): number {
  return [...alphabet].length;
}

// --------------------------------------------------------------------- RNG ----
// Uniform, unbiased, with replacement. The 32-bit word source is injectable so tests can
// drive it deterministically; production uses crypto.getRandomValues (see cryptoSource).
export type Uint32Source = (out: Uint32Array) => void;

const cryptoSource: Uint32Source = (out) => {
  crypto.getRandomValues(out);
};

// Integer in [0, n) via rejection sampling over 32-bit words: reject the top partial bucket
// so the modulo is exactly uniform (no modulo bias). n === 1 short-circuits to 0.
export function makeRandInt(source: Uint32Source = cryptoSource): (n: number) => number {
  const buf = new Uint32Array(1);
  return (n: number): number => {
    if (!Number.isInteger(n) || n <= 0) throw new RangeError('n must be a positive integer');
    if (n === 1) return 0;
    const limit = Math.floor(0x1_0000_0000 / n) * n; // largest multiple of n representable in 32 bits
    let x: number;
    do {
      source(buf);
      x = buf[0];
    } while (x >= limit);
    return x % n;
  };
}

// i.i.d. uniform sample with replacement. Back-to-back repeats are NOT filtered — doing so
// would break i.i.d.; the expected adjacent-repeat rate is exactly 1/N (tested).
export function generateSequence(alphabet: string, count: number, randInt: (n: number) => number): string[] {
  return sampleSequence([...alphabet], count, randInt);
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

// i.i.d. uniform sample with replacement from an arbitrary symbol list.
export function sampleSequence(symbols: readonly string[], count: number, randInt: (n: number) => number): string[] {
  const n = symbols.length;
  const out: string[] = new Array(count);
  for (let i = 0; i < count; i++) out[i] = symbols[randInt(n)];
  return out;
}

// The symbol a keydown produces: base key alone, or base+"*" when chord is on and space held.
export function symbolFor(key: string, spaceHeld: boolean, chord: boolean): string {
  return chord && spaceHeld ? key + '*' : key;
}

// ---------------------------------------------------------------- bit rate ----
// B = log2(N - 1) * max(Sc - Si, 0) / t   (bits per second). Errors subtract, hence the
// max(., 0) clamp; at accuracy p the net throughput scales as (2p - 1).
export function bitRate(n: number, sc: number, si: number, tSeconds: number): number {
  if (tSeconds <= 0) return 0;
  return (Math.log2(n - 1) * Math.max(sc - si, 0)) / tSeconds;
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

export interface RunResult {
  n: number;
  sc: number;
  si: number;
  tSeconds: number;
  bitsPerSecond: number;
  accuracy: number; // sc / (sc + si); 0 when there were no selections
  grossPerSecond: number; // (sc + si) / t
  netBits: number; // log2(N-1) * max(sc - si, 0)
  errorsByTarget: Record<string, number>; // incorrect selections made while each key was the target
  outcomes: Outcome[]; // one entry per raw key, aligned with the input log
}

// Authoritative fold over the raw keydown log. Retry-until-correct: a wrong (in-alphabet)
// key increments Si and does NOT advance the target; the next keydown is evaluated normally.
// Only keys with 0 <= tMs < windowMs count. This is the number the report rests on.
export function reduceLog(
  log: readonly RawKey[],
  alphabet: string,
  sequence: readonly string[],
  windowMs: number,
  chord = false,
): RunResult {
  const set = new Set<string>([...alphabet]); // base keys (selection keys); space is not one
  const n = chord ? set.size * 2 : set.size; // N = symbol count for the bit-rate formula
  let sc = 0;
  let si = 0;
  let index = 0;
  const errorsByTarget: Record<string, number> = {};
  const outcomes: Outcome[] = [];
  for (const k of log) {
    if (k.tMs < 0 || k.tMs >= windowMs || !isSelection(k, set)) {
      outcomes.push('ignored');
      continue;
    }
    const produced = symbolFor(k.key, k.space === true, chord);
    const target = index < sequence.length ? sequence[index] : '';
    if (produced === target) {
      sc++;
      index++;
      outcomes.push('correct');
    } else {
      si++;
      errorsByTarget[target] = (errorsByTarget[target] ?? 0) + 1;
      outcomes.push('incorrect');
    }
  }
  const tSeconds = windowMs / 1000;
  return {
    n,
    sc,
    si,
    tSeconds,
    bitsPerSecond: bitRate(n, sc, si, tSeconds),
    accuracy: sc + si > 0 ? sc / (sc + si) : 0,
    grossPerSecond: tSeconds > 0 ? (sc + si) / tSeconds : 0,
    netBits: Math.log2(n - 1) * Math.max(sc - si, 0),
    errorsByTarget,
    outcomes,
  };
}

// Sequence generation: the uniform, unbiased random source and the i.i.d. samplers both game
// modes draw their targets from. Kept separate from the scoring math (core/bitrate.ts) and from the
// keyboard alphabet helpers (core/alphabet.ts) so the randomness is auditable on its own — the
// verifiability claim rests on these draws being genuinely uniform with replacement.

export const SEQUENCE_LENGTH = 1500; // comfortably above any achievable selection count in 60 s

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

// i.i.d. uniform sample with replacement from an arbitrary symbol list.
export function sampleSequence(symbols: readonly string[], count: number, randInt: (n: number) => number): string[] {
  const n = symbols.length;
  const out: string[] = new Array<string>(count);
  for (let i = 0; i < count; i++) out[i] = symbols[randInt(n)];
  return out;
}

// GRID MODE: an i.i.d. uniform sequence of cell indices in [0, cellCount). Same RNG contract as
// sampleSequence (uniform, with replacement, injectable source) — a repeated cell can occur with
// probability 1/cellCount, exactly as the keyboard sequence allows adjacent repeats.
export function sampleCells(cellCount: number, count: number, randInt: (n: number) => number): number[] {
  const out: number[] = new Array<number>(count);
  for (let i = 0; i < count; i++) out[i] = randInt(cellCount);
  return out;
}


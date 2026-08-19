// THE SCORE. This one formula is what the whole project optimises, so it lives alone:
//
//     B = log2(N - 1) · max(Sc - Si, 0) / t      bits per second
//
// N is the alphabet size (keys in v1, grid cells in v2), Sc/Si are correct/incorrect selections,
// t is the run window. Errors SUBTRACT rather than merely not counting, hence the max(·,0) clamp:
// at accuracy p the net throughput scales as (2p - 1), which is why accuracy is worth about twice
// raw speed. Both game modes call exactly this function — there is no second scoring path.

export const SCORED_DURATION_MS = 60_000; // scored runs are always this long

/** What a raw input event did to the score. Declared here rather than in the game folders because
 *  it is a field of RunResult below, and RunResult is the one shape both games return. Only v1
 *  populates it (its reducer classifies every keydown, including the ignored ones); v2 leaves it
 *  empty, since a click outside the grid never reaches the engine to be classified. */
export type Outcome = 'correct' | 'incorrect' | 'ignored';

export function bitRate(n: number, sc: number, si: number, tSeconds: number): number {
  if (tSeconds <= 0) return 0;
  return (Math.log2(n - 1) * Math.max(sc - si, 0)) / tSeconds;
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

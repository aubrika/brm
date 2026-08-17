import { SCORED_DURATION_MS } from './bitrate.js';
import { DEFAULT_LOOKAHEAD } from './alphabet.js';
import type { PacerMode } from '../v1/pacer.js';

export type ErrorFeedback = 'none' | 'flash' | 'shake' | 'flash+shake';

// CHALLENGE MODE (experiment): the piano roll scrolls like a rhythm game and each target must be hit
// while it is inside the target band or it counts as a miss. The scroll rate follows the pacer beat
// (one target per beat), seeded at a fixed rate until the pacer establishes a tempo.
export const CHALLENGE_SEED_HZ = 2.0; // scroll rate (targets/s) before the pacer establishes a tempo
export const CHALLENGE_LEAD_BEATS = 3.0; // lead-in: beats before the first target reaches the band
export const CHALLENGE_ABOVE = 0.7; // target hittable from this many rows ABOVE the hit line...
export const CHALLENGE_BELOW = 1.3; // ...to this many rows BELOW; scrolling past that is a miss

export interface GameConfig {
  // ---- user-facing (config screen) ----
  leftFingers: string; // keys the left hand home row types (left→right) — supports alternate layouts
  rightFingers: string; // keys the right hand home row types (left→right)
  topRow: boolean; // include the top row of each hand in the alphabet (N=16 experiment)
  leftTopRow: string; // left hand top row; each key sits in the same column as its home-row finger
  rightTopRow: string; // right hand top row
  chords: boolean; // targets are 1-3 key chords pressed together (experiment)
  challenge: boolean; // CHALLENGE MODE: rhythm scroll (rate = pacer beat), hit while in the target band
  tones: boolean; // play the per-lane target tones
  abTest: boolean; // A/B mode: each run is randomly assigned a condition (none / pacer / tones)
  label: string; // free-text machine name, stamped into each log's filename + meta

  // ---- GRID MODE (pointing; mouse/trackpad — see bitrate-grid-mode-spec.md) ----
  // A separate targeting modality: click the highlighted cell of a large grid, N = cell count, so a
  // 32×32 grid scores log2(1023) ≈ 10 bits/selection. Its own engine + canvas renderer; when on it
  // replaces the keyboard game entirely (the alphabet/finger machinery is unused).
  grid: boolean; // GRID MODE on
  gridSize: number; // cells per side (16 | 24 | 32); a layer has gridSize² cells
  gridDepth: number; // stacked "transparent" grids per selection (1 | 2); N = (gridSize²)^depth
  ghost: boolean; // show the next target (T+1) as a ghost cell + connector
  crosshair: boolean; // full-field locator hairlines through the target cell
  hoverPulse: boolean; // pulse a white border while the pointer is inside the target cell

  // ---- SCOPE MODE (experiment; grid variant — see bitrate-scope-mode-spec.md) ----
  // A very fine grid whose cells are below comfortable clicking size, plus a hold-to-magnify
  // "rifle scope" that inflates the region under the cursor and slows the pointer while held.
  // Requires the Pointer Lock API (a virtual cursor + software gain). N = scopeGridSize².
  scope: boolean; // SCOPE MODE on (takes precedence over plain grid)
  scopeGridSize: number; // fine grid cells per side (128 | 256)
  magnification: number; // lens zoom (4 | 8 | 12); scoped pointer gain = 1/magnification
  lensDiameter: number; // lens diameter as a fraction of the field (default 0.4; not user-exposed)

  // ---- adaptive auditory pacer (experiment; never gates scoring — see bitrate-pacer-spec.md) ----
  pacer: PacerMode; // 'off' | 'proportional' | 'hillclimb'
  pacerPush: number; // proportional: click tempo = measured rate × (1 + push)
  pacerVolume: number; // click gain (kept low — the pacer sits under attention)
  pacerScored: boolean; // pace scored runs too? (off = practice only, the default)

  // ---- derived / fixed (no longer exposed; kept for the engine/strip/report) ----
  alphabet: string; // home rows, plus the top rows when topRow is on (see composeAlphabet)
  durationMs: number; // locked to 60_000 for scored runs
  lookahead: number; // fixed at 7
  lanes: boolean; // fixed: falling lanes
  chord: boolean; // fixed off (may return later, not user-facing)
  sound: boolean; // fixed on
  errorFeedback: ErrorFeedback; // fixed: flash only
}

// The scored alphabet: home rows, plus the top rows when that toggle is on, so the strip can
// group by position (home + top rows of a hand interleave into the same columns).
export function composeAlphabet(
  c: { leftFingers: string; rightFingers: string; topRow?: boolean; leftTopRow?: string; rightTopRow?: string },
): string {
  const top = c.topRow ? (c.leftTopRow ?? '') + (c.rightTopRow ?? '') : '';
  return c.leftFingers + c.rightFingers + top;
}

// Base key → its global lane index (0 = leftmost, ascending left→right across both hands) and hand
// (0 = left, 1 = right). Home and top rows of a hand share columns, so q and a both map to the left
// hand's first lane. Used by the target tones: the lane index picks the pitch (ascending), the hand
// picks timbre + pan.
export function laneAudio(
  c: { leftFingers: string; rightFingers: string; topRow?: boolean; leftTopRow?: string; rightTopRow?: string },
): Map<string, { lane: number; hand: 0 | 1 }> {
  const m = new Map<string, { lane: number; hand: 0 | 1 }>();
  const leftHome = [...c.leftFingers], rightHome = [...c.rightFingers];
  const leftTop = c.topRow ? [...(c.leftTopRow ?? '')] : [];
  const rightTop = c.topRow ? [...(c.rightTopRow ?? '')] : [];
  const leftCols = Math.max(leftHome.length, leftTop.length);
  leftHome.forEach((ch, j) => m.set(ch, { lane: j, hand: 0 }));
  leftTop.forEach((ch, j) => m.set(ch, { lane: j, hand: 0 }));
  rightHome.forEach((ch, j) => m.set(ch, { lane: leftCols + j, hand: 1 }));
  rightTop.forEach((ch, j) => m.set(ch, { lane: leftCols + j, hand: 1 }));
  return m;
}

// The Okabe-Ito colourblind-safe palette: one hue per lane, in order left→right across both
// hands. This is the falling strip's palette (strip.ts imports it), so a key keeps the exact
// colour it wore while falling on into the report. Okabe-Ito's 8th colour is black — invisible
// on the dark UI — so a neutral grey stands in for it on the last lane.
export const OKABE_ITO = [
  '#E69F00', // orange
  '#56B4E9', // sky blue
  '#009E73', // bluish green
  '#F0E442', // yellow
  '#0072B2', // blue
  '#D55E00', // vermillion
  '#CC79A7', // reddish purple
  '#999999', // grey (stands in for Okabe-Ito black against the dark background)
];

// char → its lane hue, matching the strip. Keyed on the base key; the spacebar and any key not
// in the alphabet are simply absent (callers fall back to the neutral ink colour).
export function laneColors(
  c: { leftFingers: string; rightFingers: string; topRow?: boolean; leftTopRow?: string; rightTopRow?: string },
): Map<string, string> {
  const m = new Map<string, string>();
  for (const [ch, info] of laneAudio(c)) m.set(ch, OKABE_ITO[info.lane % OKABE_ITO.length]);
  return m;
}

export const DEFAULT_CONFIG: GameConfig = {
  leftFingers: 'asdf',
  rightFingers: 'jkl;',
  topRow: false,
  leftTopRow: 'qwer',
  rightTopRow: 'uiop',
  chords: false,
  challenge: false,
  tones: false, // retired: the A/B found no bit-rate gain (and a small accuracy cost)
  abTest: false,
  label: '',
  grid: true, // grid is the singular default mode
  gridSize: 32, // 32×32 = 1024 cells; the geometry whose Fitts ceiling is ~2× device throughput
  gridDepth: 1, // one layer per selection; 2 stacks an orange+blue pair (N = 1024²)
  ghost: true,
  crosshair: true,
  hoverPulse: true,
  scope: false,
  scopeGridSize: 256, // 256×256 = 65,536 cells (~16 bits/selection); ~3.5px cells at 900px
  magnification: 8, // scoped cells appear ~28px, matching the 32×32 baseline feel
  lensDiameter: 0.4,
  pacer: 'off', // retired alongside the tones (see the A/B results)
  pacerPush: 0.1,
  pacerVolume: 0.22,
  pacerScored: false,
  alphabet: 'asdfjkl;',
  durationMs: SCORED_DURATION_MS,
  lookahead: DEFAULT_LOOKAHEAD,
  lanes: true,
  chord: false,
  sound: true,
  errorFeedback: 'flash',
};

const STORAGE_KEY = 'brm.config.v19'; // grid-only config screen; grid is the default mode

export const GRID_SIZES = [8, 16, 24, 32, 64, 128] as const; // cells per side offered on the config screen
export const GRID_DEPTHS = [1, 2] as const; // stacked layers per selection offered on the config screen
export const SCOPE_GRID_SIZES = [128, 256] as const; // fine grid sizes for scope mode
export const MAGNIFICATIONS = [4, 8, 12] as const; // lens zoom factors for scope mode

export function loadConfig(): GameConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<GameConfig>) };
  } catch {
    /* ignore malformed/absent storage */
  }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(c: GameConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

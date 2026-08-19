import { SCORED_DURATION_MS } from './bitrate.js';
import { DEFAULT_LOOKAHEAD } from './alphabet.js';

export interface GameConfig {
  // ---- v1 (legacy keyboard game) ----
  leftFingers: string; // keys the left hand types (left→right) — supports alternate layouts
  rightFingers: string; // keys the right hand types (left→right)
  label: string; // free-text machine name, stamped into each log's filename + meta

  // ---- GRID MODE (pointing; mouse, trackpad or touch) ----
  // A separate targeting modality: click the orange square on a large grid, N = cell count, so a
  // 32×32 grid scores log2(1023) ≈ 10 bits/selection. Its own engine + canvas renderer; when on it
  // replaces the keyboard game entirely (the alphabet/finger machinery is unused).
  grid: boolean; // GRID MODE on
  gridSize: number; // cells per side; N = gridSize²
  // How many upcoming targets are previewed (0 | 1 | 2). 1 outlines T+1 in grey and draws a
  // connector to it; 2 adds T+2 behind it, dimmer, so the preview reads as an ordered chain rather
  // than two equal targets. Measured worth: depth 1 is +2.46 bits/s over depth 0 (see README.md).
  lookaheadDepth: number;
  crosshair: boolean; // full-field locator hairlines through the target cell
  hoverPulse: boolean; // pulse a white border while the pointer is inside the target cell

  // ---- derived / fixed ----
  alphabet: string; // v1: leftFingers + rightFingers
  durationMs: number; // locked to 60_000 for scored runs
  lookahead: number; // v1: upcoming targets shown on the falling strip
  sound: boolean;
}

// v1: base key → its lane index (0 = leftmost, ascending left→right across both hands).
function laneIndexes(c: { leftFingers: string; rightFingers: string }): Map<string, number> {
  const m = new Map<string, number>();
  [...c.leftFingers].forEach((ch, j) => m.set(ch, j));
  [...c.rightFingers].forEach((ch, j) => m.set(ch, [...c.leftFingers].length + j));
  return m;
}

// The Okabe-Ito colourblind-safe palette: one hue per lane, in order left→right across both
// hands. This is the falling strip's palette (v1/view.ts imports it), so a key keeps the exact
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

// char → its lane hue, matching the strip. Keyed on the base key; any key not in the alphabet is
// simply absent (callers fall back to the neutral ink colour).
export function laneColors(c: { leftFingers: string; rightFingers: string }): Map<string, string> {
  const m = new Map<string, string>();
  for (const [ch, lane] of laneIndexes(c)) m.set(ch, OKABE_ITO[lane % OKABE_ITO.length]);
  return m;
}

export const DEFAULT_CONFIG: GameConfig = {
  leftFingers: 'asdf',
  rightFingers: 'jkl;',
  label: '',
  grid: true, // grid is the singular default mode
  gridSize: 32, // 32×32 = 1024 cells; the geometry whose Fitts ceiling is ~2× device throughput
  lookaheadDepth: 1, // T+1 previewed; measured at +2.46 bits/s over no preview
  crosshair: true,
  hoverPulse: true,
  alphabet: 'asdfjkl;',
  durationMs: SCORED_DURATION_MS,
  lookahead: DEFAULT_LOOKAHEAD,
  sound: true,
};

const STORAGE_KEY = 'brm.config.v21'; // ghost:boolean → lookaheadDepth:0|1|2

// No longer offered anywhere — the game is fixed at DEFAULT_CONFIG.gridSize. Kept as the set of
// sizes the canvas renderer is tested against (v2/view.test.ts), which is a geometry question.
export const GRID_SIZES = [8, 16, 24, 32, 64, 128] as const;

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

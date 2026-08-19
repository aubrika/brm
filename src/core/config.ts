import { SCORED_DURATION_MS } from './bitrate.js';
import { DEFAULT_LOOKAHEAD } from './alphabet.js';

// ---- the config, discriminated by which game it configures --------------------
// This used to be one flat interface holding both games' settings, so every grid run carried an
// alphabet and finger layout it never read, and every keyboard run carried a grid size. The log
// schema (RunConfig in core/stats.d.ts) had already been split on `mode` for exactly that reason —
// "stamping those defaults into the log described a keyboard game that never ran" — and this brings
// the runtime config in line with the artifact it produces.
//
// The split also removes a bug structurally rather than by vigilance. v1 and v2 are served from one
// origin and so share localStorage; with a single flat shape and a single key, playing v1 wrote
// `grid: false` where v2 would read it back. Keying storage by mode means neither variant can see
// the other's config at all.

/** What both games need regardless of how a selection is made. */
export interface CommonConfig {
  label: string; // free-text machine name, stamped into each log's filename + meta
  durationMs: number; // locked to 60_000 for scored runs
  sound: boolean;
}

/** v1, the falling-lanes keyboard game. N = alphabet length. */
export interface KeyboardConfig extends CommonConfig {
  mode: 'keyboard';
  leftFingers: string; // keys the left hand types (left→right) — supports alternate layouts
  rightFingers: string; // keys the right hand types (left→right)
  alphabet: string; // leftFingers + rightFingers
  lookahead: number; // upcoming targets shown on the falling strip
}

/** GRID MODE: the delivered game. Click the orange square on a large grid, N = cell count, so a
 *  32×32 grid scores log2(1023) ≈ 10 bits/selection. Its own engine + canvas renderer. */
export interface GridConfig extends CommonConfig {
  mode: 'grid';
  gridSize: number; // cells per side; N = gridSize²
  // How many upcoming targets are previewed (0 | 1 | 2). 1 outlines T+1 and draws a connector to
  // it; 2 adds T+2 behind it, dimmer, so the preview reads as an ordered chain rather than two
  // equal targets. Measured worth: depth 1 is +2.46 bits/s over depth 0 (see README.md).
  lookaheadDepth: number;
  crosshair: boolean; // full-field locator hairlines through the target cell
  hoverPulse: boolean; // pulse a white border while the pointer is inside the target cell
}

export type GameConfig = KeyboardConfig | GridConfig;

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

export const DEFAULT_KEYBOARD_CONFIG: KeyboardConfig = {
  mode: 'keyboard',
  label: '',
  leftFingers: 'asdf',
  rightFingers: 'jkl;',
  alphabet: 'asdfjkl;',
  lookahead: DEFAULT_LOOKAHEAD,
  durationMs: SCORED_DURATION_MS,
  sound: true,
};

export const DEFAULT_GRID_CONFIG: GridConfig = {
  mode: 'grid',
  label: '',
  gridSize: 32, // 32×32 = 1024 cells; the geometry whose Fitts ceiling is ~2× device throughput
  lookaheadDepth: 1, // T+1 previewed; measured at +2.46 bits/s over no preview
  crosshair: true,
  hoverPulse: true,
  durationMs: SCORED_DURATION_MS,
  sound: true,
};

// One key per mode. v1 and v2 share an origin and therefore localStorage, so a single key let each
// variant read back a config the other wrote — the reason app.ts had to normalise `grid` on every
// start. Separate keys make that impossible rather than merely corrected.
const STORAGE_KEY = { keyboard: 'brm.config.keyboard.v1', grid: 'brm.config.grid.v1' } as const;

export function loadConfig(mode: 'keyboard'): KeyboardConfig;
export function loadConfig(mode: 'grid'): GridConfig;
export function loadConfig(mode: 'keyboard' | 'grid'): GameConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY[mode]);
    if (raw) {
      // `mode` is re-asserted from the default, never taken from storage: a stored value cannot be
      // allowed to change which game this is.
      const stored = JSON.parse(raw) as Record<string, unknown>;
      return mode === 'grid'
        ? { ...DEFAULT_GRID_CONFIG, ...(stored as Partial<GridConfig>), mode: 'grid' }
        : { ...DEFAULT_KEYBOARD_CONFIG, ...(stored as Partial<KeyboardConfig>), mode: 'keyboard' };
    }
  } catch {
    /* ignore malformed/absent storage */
  }
  return mode === 'grid' ? { ...DEFAULT_GRID_CONFIG } : { ...DEFAULT_KEYBOARD_CONFIG };
}

export function saveConfig(c: GameConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY[c.mode], JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

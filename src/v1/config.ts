// v1's config and its lane palette. Split out of core/config.ts, which now holds only what is
// genuinely shared: the CommonConfig fields both games have, and the mode-keyed load/save.
//
// The split has a direction to it. core/ must not know what a keyboard game is — it is the shared
// model the LIVE game is built on, and a frozen variant should not be able to hold it hostage. So
// the keyboard shape, its defaults and its colours live here, and core/config.ts's loadConfig is
// parameterised by whichever defaults it is handed.

import { SCORED_DURATION_MS } from '../core/bitrate.js';
import type { CommonConfig } from '../core/config.js';

/** v1, the falling-lanes keyboard game. N = alphabet length. */
export interface KeyboardConfig extends CommonConfig {
  mode: 'keyboard';
  leftFingers: string; // keys the left hand types (left→right) — supports alternate layouts
  rightFingers: string; // keys the right hand types (left→right)
  alphabet: string; // leftFingers + rightFingers
  lookahead: number; // upcoming targets shown on the falling strip
}

export const DEFAULT_KEYBOARD_CONFIG: KeyboardConfig = {
  mode: 'keyboard',
  leftFingers: 'asdf',
  rightFingers: 'jkl;',
  alphabet: 'asdfjkl;',
  lookahead: 7, // how many upcoming targets the falling strip shows
  durationMs: SCORED_DURATION_MS,
  sound: true,
};

// ----------------------------------------------------------- lane palette ----

// base key → its lane index (0 = leftmost, ascending left→right across both hands).
function laneIndexes(c: { leftFingers: string; rightFingers: string }): Map<string, number> {
  const m = new Map<string, number>();
  [...c.leftFingers].forEach((ch, j) => m.set(ch, j));
  [...c.rightFingers].forEach((ch, j) => m.set(ch, [...c.leftFingers].length + j));
  return m;
}

// The Okabe-Ito colourblind-safe palette: one hue per lane, in order left→right across both
// hands. This is the falling strip's palette (v1/view.ts imports it) AND the report's (via
// laneColors below), so a key keeps the exact colour it wore while falling on into the report.
// Okabe-Ito's 8th colour is black — invisible on the dark UI — so a neutral grey stands in for it
// on the last lane.
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

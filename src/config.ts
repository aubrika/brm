import {
  DEFAULT_ALPHABET,
  SCORED_DURATION_MS,
  DEFAULT_LOOKAHEAD,
} from './scoring.js';

export type ErrorFeedback = 'none' | 'flash' | 'shake' | 'flash+shake';
// How the 8 keys fold onto finger-columns when `collapse` is on:
//  'leftmost' — overlay the hands preserving screen order (left pinky shares a column with
//               right index); 'digit' — same finger shares a column (left pinky ↔ right pinky).
export type FingerMapping = 'leftmost' | 'digit';

export interface GameConfig {
  alphabet: string;
  durationMs: number; // locked to 60_000 for scored runs
  lookahead: number; // glyphs visible right of the target (>= MIN_LOOKAHEAD)
  lanes: boolean; // piano-roll vertical lanes + hand colour coding
  collapse: boolean; // fold the two hands onto shared finger-columns (hand = colour)
  mapping: FingerMapping; // which folding, when collapse is on
  sound: boolean; // AudioContext click/tone feedback
  errorFeedback: ErrorFeedback; // how a miss is shown (also recorded, for the feedback A/B)
  label: string; // free-text machine name, stamped into each log's filename + meta
}

export const DEFAULT_CONFIG: GameConfig = {
  alphabet: DEFAULT_ALPHABET,
  durationMs: SCORED_DURATION_MS,
  lookahead: DEFAULT_LOOKAHEAD,
  lanes: true, // falling DDR lanes; off = chunked single row
  collapse: true, // default: 4 finger-columns, hand shown by colour
  mapping: 'leftmost',
  sound: true,
  errorFeedback: 'flash+shake',
  label: '',
};

const STORAGE_KEY = 'brm.config.v6';

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

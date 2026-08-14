import {
  DEFAULT_ALPHABET,
  SCORED_DURATION_MS,
  DEFAULT_LOOKAHEAD,
} from './scoring.js';

export interface GameConfig {
  alphabet: string;
  durationMs: number; // locked to 60_000 for scored runs
  lookahead: number; // glyphs visible right of the target (>= MIN_LOOKAHEAD)
  lanes: boolean; // piano-roll vertical lanes + hand colour coding
  sound: boolean; // AudioContext click/tone feedback
}

export const DEFAULT_CONFIG: GameConfig = {
  alphabet: DEFAULT_ALPHABET,
  durationMs: SCORED_DURATION_MS,
  lookahead: DEFAULT_LOOKAHEAD,
  lanes: false, // default is the chunked single row; on = piano-roll lanes
  sound: false,
};

const STORAGE_KEY = 'brm.config.v2';

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

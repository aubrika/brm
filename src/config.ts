import { SCORED_DURATION_MS, DEFAULT_LOOKAHEAD } from './scoring.js';

export type ErrorFeedback = 'none' | 'flash' | 'shake' | 'flash+shake';

export interface GameConfig {
  // ---- user-facing (config screen) ----
  leftFingers: string; // keys the left hand types (left→right) — supports alternate layouts
  rightFingers: string; // keys the right hand types (left→right)
  chords: boolean; // targets are 1-3 key chords pressed together (experiment)
  label: string; // free-text machine name, stamped into each log's filename + meta

  // ---- derived / fixed (no longer exposed; kept for the engine/strip/report) ----
  alphabet: string; // leftFingers + rightFingers
  durationMs: number; // locked to 60_000 for scored runs
  lookahead: number; // fixed at 7
  lanes: boolean; // fixed: falling lanes
  chord: boolean; // fixed off (may return later, not user-facing)
  sound: boolean; // fixed on
  errorFeedback: ErrorFeedback; // fixed: flash only
}

// The scored alphabet: the two hands concatenated, so the strip can group by position.
export function composeAlphabet(c: Pick<GameConfig, 'leftFingers' | 'rightFingers'>): string {
  return c.leftFingers + c.rightFingers;
}

export const DEFAULT_CONFIG: GameConfig = {
  leftFingers: 'asdf',
  rightFingers: 'jkl;',
  chords: false,
  label: '',
  alphabet: 'asdfjkl;',
  durationMs: SCORED_DURATION_MS,
  lookahead: DEFAULT_LOOKAHEAD,
  lanes: true,
  chord: false,
  sound: true,
  errorFeedback: 'flash',
};

const STORAGE_KEY = 'brm.config.v8'; // structure changed (left/right fingers + thumbs)

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

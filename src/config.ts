import { SCORED_DURATION_MS, DEFAULT_LOOKAHEAD } from './scoring.js';

export type ErrorFeedback = 'none' | 'flash' | 'shake' | 'flash+shake';

export interface GameConfig {
  // ---- user-facing (config screen) ----
  leftFingers: string; // keys typed by the left hand (left→right)
  rightFingers: string; // keys typed by the right hand (left→right)
  thumbs: boolean; // include thumb keys in the centre
  leftThumb: string; // left-thumb key(s); a space = the spacebar
  rightThumb: string; // right-thumb key(s)
  label: string; // free-text machine name, stamped into each log's filename + meta

  // ---- derived / fixed (no longer exposed; kept for the engine/strip/report) ----
  alphabet: string; // leftFingers + thumbs + rightFingers
  durationMs: number; // locked to 60_000 for scored runs
  lookahead: number; // fixed at 7
  lanes: boolean; // fixed: falling lanes
  chord: boolean; // fixed off (may return later, not user-facing)
  sound: boolean; // fixed on
  errorFeedback: ErrorFeedback; // fixed: flash only
}

// The scored alphabet, hands ordered left → centre(thumbs) → right so the strip can group by
// position. Thumb keys sit between the hands.
export function composeAlphabet(
  c: Pick<GameConfig, 'leftFingers' | 'rightFingers' | 'thumbs' | 'leftThumb' | 'rightThumb'>,
): string {
  const thumbs = c.thumbs ? c.leftThumb + c.rightThumb : '';
  return c.leftFingers + thumbs + c.rightFingers;
}

export const DEFAULT_CONFIG: GameConfig = {
  leftFingers: 'asdf',
  rightFingers: 'jkl;',
  thumbs: true,
  leftThumb: '',
  rightThumb: ' ', // the spacebar, in the centre → N = 9
  label: '',
  alphabet: 'asdf jkl;',
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

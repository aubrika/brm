import { SCORED_DURATION_MS, DEFAULT_LOOKAHEAD } from './scoring.js';

export type ErrorFeedback = 'none' | 'flash' | 'shake' | 'flash+shake';

export interface GameConfig {
  // ---- user-facing (config screen) ----
  leftFingers: string; // keys the left hand home row types (left→right) — supports alternate layouts
  rightFingers: string; // keys the right hand home row types (left→right)
  topRow: boolean; // include the top row of each hand in the alphabet (N=16 experiment)
  leftTopRow: string; // left hand top row; each key sits in the same column as its home-row finger
  rightTopRow: string; // right hand top row
  chords: boolean; // targets are 1-3 key chords pressed together (experiment)
  label: string; // free-text machine name, stamped into each log's filename + meta

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
  c: Pick<GameConfig, 'leftFingers' | 'rightFingers' | 'topRow' | 'leftTopRow' | 'rightTopRow'>,
): string {
  const top = c.topRow ? c.leftTopRow + c.rightTopRow : '';
  return c.leftFingers + c.rightFingers + top;
}

// Base key → its column order left→right (0 = leftmost lane). Home and top rows of a hand share
// columns, so q and a both map to the left hand's first column. Used to pitch the lane tones.
export function laneOrder(c: GameConfig): Map<string, number> {
  const m = new Map<string, number>();
  const leftHome = [...c.leftFingers], rightHome = [...c.rightFingers];
  const leftTop = c.topRow ? [...c.leftTopRow] : [];
  const rightTop = c.topRow ? [...c.rightTopRow] : [];
  const leftCols = Math.max(leftHome.length, leftTop.length);
  leftHome.forEach((ch, j) => m.set(ch, j));
  leftTop.forEach((ch, j) => m.set(ch, j));
  rightHome.forEach((ch, j) => m.set(ch, leftCols + j));
  rightTop.forEach((ch, j) => m.set(ch, leftCols + j));
  return m;
}

export const DEFAULT_CONFIG: GameConfig = {
  leftFingers: 'asdf',
  rightFingers: 'jkl;',
  topRow: false,
  leftTopRow: 'qwer',
  rightTopRow: 'uiop',
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

const STORAGE_KEY = 'brm.config.v10'; // top row behind a toggle; per-lane tones

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

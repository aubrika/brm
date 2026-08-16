import { SCORED_DURATION_MS, DEFAULT_LOOKAHEAD } from './scoring.js';
import type { PacerMode } from './pacer.js';

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
  c: Pick<GameConfig, 'leftFingers' | 'rightFingers' | 'topRow' | 'leftTopRow' | 'rightTopRow'>,
): string {
  const top = c.topRow ? c.leftTopRow + c.rightTopRow : '';
  return c.leftFingers + c.rightFingers + top;
}

// Base key → its global lane index (0 = leftmost, ascending left→right across both hands) and hand
// (0 = left, 1 = right). Home and top rows of a hand share columns, so q and a both map to the left
// hand's first lane. Used by the target tones: the lane index picks the pitch (ascending), the hand
// picks timbre + pan.
export function laneAudio(c: GameConfig): Map<string, { lane: number; hand: 0 | 1 }> {
  const m = new Map<string, { lane: number; hand: 0 | 1 }>();
  const leftHome = [...c.leftFingers], rightHome = [...c.rightFingers];
  const leftTop = c.topRow ? [...c.leftTopRow] : [];
  const rightTop = c.topRow ? [...c.rightTopRow] : [];
  const leftCols = Math.max(leftHome.length, leftTop.length);
  leftHome.forEach((ch, j) => m.set(ch, { lane: j, hand: 0 }));
  leftTop.forEach((ch, j) => m.set(ch, { lane: j, hand: 0 }));
  rightHome.forEach((ch, j) => m.set(ch, { lane: leftCols + j, hand: 1 }));
  rightTop.forEach((ch, j) => m.set(ch, { lane: leftCols + j, hand: 1 }));
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
  pacer: 'proportional', // fixed: always-on proportional pacer (no longer user-configurable)
  pacerPush: 0.2, // fixed: click runs 20% above the measured rate
  pacerVolume: 0.4, // fixed: kick volume (louder than the tones)
  pacerScored: true, // fixed: paces every run (practice and scored)
  alphabet: 'asdfjkl;',
  durationMs: SCORED_DURATION_MS,
  lookahead: DEFAULT_LOOKAHEAD,
  lanes: true,
  chord: false,
  sound: true,
  errorFeedback: 'flash',
};

const STORAGE_KEY = 'brm.config.v13'; // pacer fixed (proportional, 20%, always on); options removed

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

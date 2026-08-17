// The adaptive auditory pacer's TEMPO CONTROLLER — pure logic, no audio, no DOM. It ingests the
// stream of correct (and, for hill-climbing, incorrect) selections with run-relative timestamps
// and produces a target click tempo in Hz. It NEVER sees or touches Sc/Si/target advancement; its
// output drives only sound (audio.ts) and the run log. See bitrate-pacer-spec.md §1-2.
//
// The pacer is a *suggestion*: the strip stays advance-on-correct, the player may fall behind, run
// ahead, or ignore the click with zero consequence for scoring. Nothing here can gate a target.

export type PacerMode = 'off' | 'proportional' | 'hillclimb';

export const PACER_FLOOR_HZ = 0.5; // below this the click is not a rhythm
export const PACER_CEIL_HZ = 12; // above this it is not achievable

const RECOMPUTE_MS = 2000; // proportional recompute cadence
const RATE_WINDOW_MS = 10_000; // trailing window for the rate estimate (correct keystrokes only)
const MAX_MOVE_PER_UPDATE = 0.05; // glide the tempo by at most 5% per update, so it never jumps
const MIN_CORRECT_TO_START = 4; // wait for a little data before the first click

const CLIMB_WINDOW_MS = 10_000; // hill-climb evaluates B over 10 s windows
const CLIMB_STEP0 = 0.04; // initial gradient step (4%)
const CLIMB_STEP_FLOOR = 0.01; // smallest step after halving (1%)
const CLIMB_CLAMP_PER_MIN = 0.15; // cap cumulative tempo movement to ±15% per minute

export interface PacerConfig {
  mode: PacerMode;
  push: number; // proportional push fraction (e.g. 0.10 = 10% above measured rate)
  logBits: number; // log2(N-1), for the hill-climber's B estimate
}

export interface TempoChange {
  t: number; // run-relative ms (same clock as the event log)
  hz: number;
}

// Pure lookahead-scheduler step (shared by audio.ts and its test): given the current audio-clock
// time, the next scheduled click time, and the tempo, return every click falling inside the
// lookahead window plus the advanced nextClick. A tempo change takes effect from the next click
// scheduled after it — never retroactively — because we only ever read `tempoHz` going forward.
export function scheduleClicks(
  audioNow: number,
  nextClick: number,
  tempoHz: number,
  lookahead: number,
): { clicks: number[]; nextClick: number } {
  const clicks: number[] = [];
  let next = nextClick;
  const period = 1 / tempoHz;
  // guard against a pathological tempo producing an infinite loop
  while (next < audioNow + lookahead && clicks.length < 1000) {
    clicks.push(next);
    next += period;
  }
  return { clicks, nextClick: next };
}

export class PacerController {
  private readonly mode: PacerMode;
  private readonly push: number;
  private readonly logBits: number;

  private tempo = NaN; // NaN until the first click is established; then the current click tempo (Hz)
  private startTempo = NaN;
  private readonly correctT: number[] = []; // run-relative ms of correct selections
  private readonly errorT: number[] = []; // run-relative ms of incorrect selections (hill-climb only)
  readonly tempoChanges: TempoChange[] = [];

  private lastRecomputeMs = -Infinity; // proportional / establishment cadence
  private lastClimbMs = -Infinity; // hill-climb window boundary
  private prevB = NaN;
  private dir = 1; // hill-climb direction: +1 faster, -1 slower
  private step = CLIMB_STEP0;
  private worseStreak = 0;
  private pendingEval = false; // did we actually move the tempo last window (so this window judges it)?
  private minuteAnchorT = -Infinity; // for the ±15%/min movement clamp
  private minuteAnchorTempo = NaN;

  constructor(cfg: PacerConfig) {
    this.mode = cfg.mode;
    this.push = cfg.push;
    this.logBits = cfg.logBits;
  }

  get started(): boolean {
    return !Number.isNaN(this.tempo);
  }
  get currentTempo(): number {
    return this.tempo;
  }
  get startTempoHz(): number {
    return this.startTempo;
  }
  get endTempoHz(): number {
    return this.tempo;
  }

  recordCorrect(tMs: number): void {
    this.correctT.push(tMs);
  }
  recordError(tMs: number): void {
    this.errorT.push(tMs);
  }

  // Called frequently (once per frame is fine — it self-throttles). Returns a new tempo in Hz when
  // it changes (caller retunes the scheduler and logs the change), or null when nothing changed.
  update(nowMs: number): number | null {
    if (this.mode === 'proportional') return this.updateProportional(nowMs);
    if (this.mode === 'hillclimb') return this.updateHillclimb(nowMs);
    return null;
  }

  private clampHz(hz: number): number {
    return Math.min(PACER_CEIL_HZ, Math.max(PACER_FLOOR_HZ, hz));
  }

  private emit(nowMs: number, hz: number): number {
    this.tempo = hz;
    if (Number.isNaN(this.startTempo)) this.startTempo = hz;
    this.tempoChanges.push({ t: nowMs, hz });
    return hz;
  }

  // count of entries in `arr` within (nowMs - windowMs, nowMs]; arr is ascending (push order)
  private countInWindow(arr: number[], nowMs: number, windowMs: number): number {
    const start = nowMs - windowMs;
    let n = 0;
    for (let i = arr.length - 1; i >= 0 && arr[i] > start; i--) {
      if (arr[i] <= nowMs) n++;
    }
    return n;
  }

  // correct-keystroke rate (Hz) over the trailing window, using the actual elapsed time early on
  private measuredRate(nowMs: number): number {
    const nCorrect = this.countInWindow(this.correctT, nowMs, RATE_WINDOW_MS);
    const elapsedS = Math.min(RATE_WINDOW_MS, nowMs) / 1000;
    return elapsedS > 0 ? nCorrect / elapsedS : 0;
  }

  private updateProportional(nowMs: number): number | null {
    if (!this.started) {
      // establish as soon as there's a little data — don't wait out the 2 s recompute cadence, or
      // the click wouldn't start until the first cadence boundary even after enough keystrokes
      if (this.countInWindow(this.correctT, nowMs, RATE_WINDOW_MS) < MIN_CORRECT_TO_START) return null;
      this.lastRecomputeMs = nowMs;
      return this.emit(nowMs, this.clampHz(this.measuredRate(nowMs) * (1 + this.push)));
    }
    if (nowMs - this.lastRecomputeMs < RECOMPUTE_MS) return null;
    this.lastRecomputeMs = nowMs;
    const target = this.clampHz(this.measuredRate(nowMs) * (1 + this.push));
    // glide toward the target by at most 5% of the current tempo per update
    const next = this.clampHz(
      Math.min(this.tempo * (1 + MAX_MOVE_PER_UPDATE), Math.max(this.tempo * (1 - MAX_MOVE_PER_UPDATE), target)),
    );
    return Math.abs(next - this.tempo) < 1e-4 ? null : this.emit(nowMs, next);
  }

  private bOverWindow(nowMs: number, windowMs: number): number {
    const sc = this.countInWindow(this.correctT, nowMs, windowMs);
    const si = this.countInWindow(this.errorT, nowMs, windowMs);
    const t = Math.min(windowMs, nowMs) / 1000;
    return t > 0 ? (this.logBits * Math.max(sc - si, 0)) / t : 0;
  }

  private updateHillclimb(nowMs: number): number | null {
    if (!this.started) {
      // seed at the measured rate (like proportional) as soon as there's data, then climb
      if (this.countInWindow(this.correctT, nowMs, RATE_WINDOW_MS) < MIN_CORRECT_TO_START) return null;
      this.lastRecomputeMs = nowMs;
      this.lastClimbMs = nowMs;
      this.prevB = this.bOverWindow(nowMs, CLIMB_WINDOW_MS);
      this.minuteAnchorT = nowMs;
      const seed = this.clampHz(this.measuredRate(nowMs) * (1 + this.push));
      this.minuteAnchorTempo = seed;
      return this.emit(nowMs, seed);
    }
    if (nowMs - this.lastClimbMs < CLIMB_WINDOW_MS) return null;
    this.lastClimbMs = nowMs;
    const b = this.bOverWindow(nowMs, CLIMB_WINDOW_MS);
    // Judge the previous move only if it actually changed the tempo. A window where the movement
    // clamp held the tempo flat carries no gradient information, so it must not count as "worse"
    // — otherwise the clamp itself would trigger a spurious reversal.
    if (this.pendingEval) {
      if (b > this.prevB) {
        this.worseStreak = 0; // improved → keep going the same direction
      } else if (++this.worseStreak >= 2) {
        this.dir = -this.dir; // worse two windows running → reverse and take smaller steps
        this.step = Math.max(CLIMB_STEP_FLOOR, this.step / 2);
        this.worseStreak = 0;
      }
      this.pendingEval = false;
    }
    // reset the ±15%/min clamp anchor once a minute has elapsed
    if (nowMs - this.minuteAnchorT >= 60_000) {
      this.minuteAnchorT = nowMs;
      this.minuteAnchorTempo = this.tempo;
    }
    const proposed = this.tempo * (1 + this.dir * this.step);
    const next = this.clampHz(
      Math.min(this.minuteAnchorTempo * (1 + CLIMB_CLAMP_PER_MIN), Math.max(this.minuteAnchorTempo * (1 - CLIMB_CLAMP_PER_MIN), proposed)),
    );
    if (Math.abs(next - this.tempo) < 1e-4) return null; // clamped / no move — wait, don't reverse
    this.prevB = b; // B at the tempo we're about to leave; next window judges the move against it
    this.pendingEval = true;
    return this.emit(nowMs, next);
  }
}

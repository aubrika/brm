/** iOS Safari's double-tap-to-zoom, and the one reliable way to refuse it.
 *
 *  The CSS already asks: touch-action is `manipulation` page-wide and `none` on the run screen and
 *  the canvas. WebKit honours that only partially — a fast second tap in the same spot still zooms.
 *  GRID MODE produces exactly that input: an i.i.d. target repeats a cell every 1/N selections and
 *  the player is trying to be fast, so the "same spot twice, quickly" gesture is not an edge case
 *  here, it is the game. Cancelling the second touchend of a rapid pair is what actually stops it.
 *
 *  The decision lives here, apart from the DOM, because preventDefault on touchend also cancels the
 *  synthetic click — so getting the exceptions right matters more than the timing does, and the
 *  exceptions are pure logic worth testing. */

/** iOS Safari's double-tap window. 300 ms is WebKit's own threshold; the extra 50 ms covers
 *  timestamp jitter between the two touchend events. */
export const DOUBLE_TAP_MS = 350;

export interface TapContext {
  /** Fingers still on the glass after this touchend. >0 means a pinch is in progress. */
  remainingTouches: number;
  /** Fingers lifted by this event. A tap lifts exactly one. */
  liftedTouches: number;
  /** True if a control that needs its click sits under the finger (the practice tag says
   *  "tap to exit" and must keep working). */
  onControl: boolean;
  /** True only while a run is on screen; config and report are ordinary DOM and keep their clicks. */
  inRun: boolean;
}

/** Decide what a touchend means for the zoom gesture.
 *
 *  Returns whether to cancel this event's default (suppressing the zoom), and the timestamp to
 *  remember for the next call — `null` meaning "forget the previous tap", so a pinch's tail or a
 *  button press can never become the first half of a double tap. */
export function judgeTouchEnd(
  ctx: TapContext,
  nowMs: number,
  lastTapMs: number | null,
): { suppress: boolean; nextLastTapMs: number | null } {
  if (!ctx.inRun) return { suppress: false, nextLastTapMs: null };
  // Multi-touch is a pinch, not a tap: leave zoom alone (the accessibility line we don't cross).
  if (ctx.remainingTouches > 0 || ctx.liftedTouches !== 1) return { suppress: false, nextLastTapMs: null };
  if (ctx.onControl) return { suppress: false, nextLastTapMs: null };
  const suppress = lastTapMs !== null && nowMs - lastTapMs <= DOUBLE_TAP_MS;
  return { suppress, nextLastTapMs: nowMs };
}

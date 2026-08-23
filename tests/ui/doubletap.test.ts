// The iOS double-tap-to-zoom guard. preventDefault on touchend also cancels the synthetic click,
// so what matters is not the timing but the exceptions: pinch must still zoom, controls must still
// fire, and nothing outside a run may be touched. Those are the cases asserted here.

import { describe, it, expect } from 'vitest';
import { judgeTouchEnd, DOUBLE_TAP_MS, type TapContext } from '../../src/ui/doubletap.js';

const tap = (over: Partial<TapContext> = {}): TapContext => ({
  remainingTouches: 0,
  liftedTouches: 1,
  onControl: false,
  inRun: true,
  ...over,
});

describe('judgeTouchEnd', () => {
  it('lets a lone tap through and remembers it', () => {
    const r = judgeTouchEnd(tap(), 1000, null);
    expect(r.suppress).toBe(false);
    expect(r.nextLastTapMs).toBe(1000);
  });

  it('suppresses the second tap of a rapid pair', () => {
    const r = judgeTouchEnd(tap(), 1000 + DOUBLE_TAP_MS - 1, 1000);
    expect(r.suppress).toBe(true);
  });

  it('leaves a slow second tap alone', () => {
    const r = judgeTouchEnd(tap(), 1000 + DOUBLE_TAP_MS + 1, 1000);
    expect(r.suppress).toBe(false);
    expect(r.nextLastTapMs).toBe(1000 + DOUBLE_TAP_MS + 1);
  });

  it('treats the boundary as part of the gesture', () => {
    expect(judgeTouchEnd(tap(), 1000 + DOUBLE_TAP_MS, 1000).suppress).toBe(true);
  });

  // Three taps in a row: the third is measured against the second, not the first, so a sustained
  // fast stream keeps being suppressed rather than alternating.
  it('re-arms on every tap, so a fast stream stays suppressed', () => {
    let last: number | null = null;
    const suppressed: boolean[] = [];
    for (const t of [0, 100, 200, 300]) {
      const r = judgeTouchEnd(tap(), t, last);
      suppressed.push(r.suppress);
      last = r.nextLastTapMs;
    }
    expect(suppressed).toEqual([false, true, true, true]);
  });

  it('never fires outside a run, and forgets the previous tap', () => {
    const r = judgeTouchEnd(tap({ inRun: false }), 1100, 1000);
    expect(r.suppress).toBe(false);
    expect(r.nextLastTapMs).toBeNull();
  });

  it('leaves pinch-zoom alone while fingers remain down', () => {
    const r = judgeTouchEnd(tap({ remainingTouches: 1 }), 1100, 1000);
    expect(r.suppress).toBe(false);
    expect(r.nextLastTapMs).toBeNull();
  });

  it('leaves a two-finger lift alone', () => {
    expect(judgeTouchEnd(tap({ liftedTouches: 2 }), 1100, 1000).suppress).toBe(false);
  });

  // The practice tag is labelled "tap to exit" on coarse pointers; cancelling its click would
  // strand the player in a practice run with no way out.
  it('never cancels a tap on a control', () => {
    const r = judgeTouchEnd(tap({ onControl: true }), 1100, 1000);
    expect(r.suppress).toBe(false);
    expect(r.nextLastTapMs).toBeNull();
  });

  it('a pinch cannot become the first half of a double tap', () => {
    const pinch = judgeTouchEnd(tap({ remainingTouches: 1 }), 1000, null);
    const after = judgeTouchEnd(tap(), 1050, pinch.nextLastTapMs);
    expect(after.suppress).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { PacerController, scheduleClicks } from './pacer.js';
import { Engine, type KeyInput } from './engine.js';
import { DEFAULT_CONFIG } from './config.js';

const L = Math.log2(7); // log2(N-1) for N=8

describe('scheduleClicks (lookahead scheduler core)', () => {
  it('emits clicks spaced by exactly 1/tempo and never inside the window twice', () => {
    // tempo 2 Hz → period 0.5 s. Walk the audio clock forward in 0.25 s steps.
    let next = 0.05;
    const emitted: number[] = [];
    for (let now = 0; now <= 1.0 + 1e-9; now += 0.25) {
      const r = scheduleClicks(now, next, 2, 0.1);
      next = r.nextClick;
      emitted.push(...r.clicks);
    }
    expect(emitted).toEqual([0.05, 0.55, 1.05]); // 0.5 s apart
    for (let i = 1; i < emitted.length; i++) expect(emitted[i] - emitted[i - 1]).toBeCloseTo(0.5, 9);
  });

  it('a tempo change affects only clicks scheduled after it, never retroactively', () => {
    // one click at tempo 2 (period 0.5), then switch to tempo 4 (period 0.25)
    const a = scheduleClicks(0, 0.1, 2, 0.15); // → click 0.1, next 0.6
    expect(a.clicks).toEqual([0.1]);
    expect(a.nextClick).toBeCloseTo(0.6, 9);
    const b = scheduleClicks(0.55, a.nextClick, 4, 0.15); // → click 0.6, next 0.85 (new period)
    expect(b.clicks).toEqual([0.6]);
    expect(b.nextClick).toBeCloseTo(0.85, 9); // 0.6 + 0.25, not + 0.5
  });
});

// Drive a controller with a synthetic keystroke stream and return it.
function simulateRate(
  ctrl: PacerController,
  rateAt: (tMs: number) => number,
  untilMs: number,
): void {
  let nextKey = 0;
  for (let t = 0; t <= untilMs; t += 50) {
    while (nextKey <= t) {
      ctrl.recordCorrect(nextKey);
      nextKey += 1000 / rateAt(nextKey);
    }
    ctrl.update(t);
  }
}

describe('proportional controller', () => {
  it('settles the tempo near measured rate × (1 + push)', () => {
    const p = new PacerController({ mode: 'proportional', push: 0.1, logBits: L });
    simulateRate(p, () => 4, 40_000); // steady 4 keystrokes/s
    expect(p.currentTempo).toBeGreaterThan(4.2);
    expect(p.currentTempo).toBeLessThan(4.6); // ≈ 4 × 1.10 = 4.4
    expect(p.startTempoHz).toBeGreaterThan(0);
  });

  it('never moves the tempo more than 5% per update (glides, does not jump)', () => {
    const p = new PacerController({ mode: 'proportional', push: 0.1, logBits: L });
    // rate jumps 2 → 6 partway; the controller must glide up, not leap
    simulateRate(p, (t) => (t < 20_000 ? 2 : 6), 80_000);
    // every change after the first establishment moves the tempo by at most 5%
    for (let i = 1; i < p.tempoChanges.length; i++) {
      const ratio = p.tempoChanges[i].hz / p.tempoChanges[i - 1].hz;
      expect(Math.abs(ratio - 1)).toBeLessThanOrEqual(0.05 + 1e-9);
    }
    expect(p.currentTempo).toBeGreaterThan(6.0); // eventually reaches ≈ 6 × 1.10 = 6.6
    expect(p.currentTempo).toBeLessThan(6.7);
  });

  it('respects the floor and ceiling', () => {
    const fast = new PacerController({ mode: 'proportional', push: 0.1, logBits: L });
    simulateRate(fast, () => 40, 40_000); // absurdly fast → clamp to ceiling
    expect(fast.currentTempo).toBeLessThanOrEqual(12);
  });
});

describe('hill-climbing controller', () => {
  it('converges the tempo toward the B-maximising tempo rather than oscillating', () => {
    const p = new PacerController({ mode: 'hillclimb', push: 0.05, logBits: L });
    // Player model: B(tempo) peaks near ~4.4 Hz — throughput rises with tempo until accuracy
    // falls off above 4 Hz. Each 10 s window we synthesise correct/error counts from the
    // controller's current tempo, closing the loop it climbs.
    let t = 0;
    for (let w = 0; w < 90; w++) {
      const hz = p.started ? p.currentTempo : 2;
      const gross = Math.max(1, Math.round(hz * 10));
      const acc = Math.max(0.5, 0.99 - 0.1 * Math.max(0, hz - 4));
      const nCorrect = Math.round(gross * acc);
      const nError = gross - nCorrect;
      for (let i = 0; i < nCorrect; i++) p.recordCorrect(t + ((i + 0.5) * 10_000) / nCorrect);
      for (let i = 0; i < nError; i++) p.recordError(t + ((i + 0.5) * 10_000) / (nError + 1));
      t += 10_000;
      p.update(t);
    }
    expect(p.startTempoHz).toBeLessThan(2.6); // seeded near the initial ~2 Hz rate
    expect(p.currentTempo).toBeGreaterThan(3.6); // climbed toward the optimum
    expect(p.currentTempo).toBeLessThan(5.4);
    // damped, not oscillating: the last handful of moves are small
    const tail = p.tempoChanges.slice(-4);
    for (let i = 1; i < tail.length; i++) {
      expect(Math.abs(tail[i].hz / tail[i - 1].hz - 1)).toBeLessThan(0.05);
    }
  });
});

// §1 non-negotiable, guarded as a test: the pacer must never affect Sc, Si, or advancement.
describe('pacer isolation from scoring', () => {
  const key = (k: string): KeyInput => ({ key: k, repeat: false, ctrlKey: false, metaKey: false, altKey: false });

  const runScoring = (pacerMode: 'off' | 'proportional' | 'hillclimb') => {
    // deterministic sequence (all 'a'), a fixed mix of right/wrong presses
    const eng = new Engine({ ...DEFAULT_CONFIG, pacer: pacerMode, alphabet: 'asdfjkl;' }, true, () => 0);
    eng.start(0);
    let t = 100;
    for (const k of ['a', 'a', 's', 'a', 'a', 'k', 'a']) {
      eng.handleKey(key(k), t);
      t += 200;
    }
    return { sc: eng.sc, si: eng.si, index: eng.index };
  };

  it('produces identical Sc/Si/advancement with the pacer off, proportional, or hill-climbing', () => {
    const off = runScoring('off');
    expect(off).toEqual({ sc: 5, si: 2, index: 5 }); // 5 correct 'a', 2 wrong ('s','k')
    expect(runScoring('proportional')).toEqual(off);
    expect(runScoring('hillclimb')).toEqual(off);
  });
});

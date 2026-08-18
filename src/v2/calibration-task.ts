// The interactive calibration task: the screen, the click capture, and the hand-off to the pure
// maths in calibration.ts. Split out of app.ts so that everything calibration lives in exactly two
// places — the algorithm (calibration.ts, no DOM) and the task that feeds it (here, all DOM).
//
// It runs on the real game surface: the same GridEngine and the same canvas renderer, on a fixed
// 24×24 reference grid. That is deliberate. Endpoint scatter measured on some other widget would
// be scatter at that widget's target size, not at the game's, and the whole point is to measure
// the player's aim under the conditions they will actually play under.
//
// The engine's sequence is driven by the scripted targets, but its SCORING is not used: any click
// advances, hit or miss, because a miss is a data point about aim rather than a penalty. Nothing
// here decides anything — it collects (dx, dy, movement time) per click and hands the list to
// computeCalibration.

import { GridEngine } from './engine.js';
import { GridRenderer } from './view.js';
import { el } from '../ui/dom.js';
import type { GameConfig } from '../core/config.js';
import {
  generateCalibrationScript,
  computeCalibration,
  seededRandInt,
  REFERENCE_GRID,
  CALIB_CLICKS,
  type CalibrationResult,
  type CalibClick,
} from './calibration.js';

export interface CalibrationHooks {
  /** A usable result; the caller adopts it and returns to config. */
  onDone: (result: CalibrationResult) => void;
  /** Too few clicks survived rejection — the caller should prompt to try again. */
  onFailed: (message: string) => void;
  /** Per-click audio, so the task does not own an AudioContext. */
  onClick?: () => void;
}

export class CalibrationTask {
  private readonly engine: GridEngine;
  private readonly view: GridRenderer;
  private readonly clicks: CalibClick[] = [];
  private readonly cleanup = new AbortController();
  private readonly counter: HTMLElement;
  private readonly startMs: number;
  private lastClickMs: number;
  private pointerType = 'mouse';
  private rafId = 0;
  private done = false;

  constructor(root: HTMLElement, config: GameConfig, private readonly hooks: CalibrationHooks) {
    // Scripted targets, with a seeded fallback so the engine still has a source if the script runs
    // out (it cannot, at CALIB_CLICKS, but an engine with no source would be a silent trap).
    const script = generateCalibrationScript(REFERENCE_GRID, CALIB_CLICKS);
    const fallback = seededRandInt(0x1234abcd);
    let k = 0;
    const source = (n: number): number => (k < script.length ? script[k++] : fallback(n));

    // No lookahead during calibration: a visible next target invites planning the next movement
    // while finishing this one, which is worth ~150 ms of cycle time (see the ghost A/B) and would
    // measure aim under different conditions than the plain task it is meant to characterise.
    this.engine = new GridEngine({ ...config, gridSize: REFERENCE_GRID, gridDepth: 1, lookaheadDepth: 0 }, false, source);
    this.engine.start(performance.now());

    const stripRoot = el('div', { class: 'strip-root grid-root' });
    this.counter = el('div', { class: 'stats', text: `calibrating: 0 / ${CALIB_CLICKS}` });
    root.append(
      el('div', { class: 'screen run' }, [
        el('div', { class: 'calib-instruction', text: 'Click each highlighted cell as quickly as you comfortably can.' }),
        el('div', { class: 'strip-wrap' }, [stripRoot]),
        el('div', { class: 'readout' }, [this.counter]),
        el('div', { class: 'practice-tag', text: 'CALIBRATION · Esc to cancel' }),
      ]),
    );

    this.view = new GridRenderer(this.engine, stripRoot);
    this.view.element.style.cursor = 'crosshair';
    this.startMs = performance.now();
    this.lastClickMs = this.startMs;

    const signal = this.cleanup.signal;
    this.view.element.addEventListener('pointerdown', this.onDown, { signal });
    this.view.element.addEventListener('pointermove', this.onMove, { signal });
    const loop = (): void => {
      this.view.render(performance.now());
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  resize(): void {
    this.view.resize();
  }

  /** Stop without producing a result. Safe to call twice. */
  abort(): void {
    if (this.done) return;
    this.done = true;
    cancelAnimationFrame(this.rafId);
    this.cleanup.abort();
  }

  private onMove = (e: PointerEvent): void => {
    this.view.hoverCell = this.view.cellAt(e.clientX, e.clientY);
  };

  private onDown = (e: PointerEvent): void => {
    if (this.done || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const now = performance.now();
    const point = this.view.localPoint(e.clientX, e.clientY);
    const target = this.engine.target();
    const cellPx = this.view.cellPx;
    const cx = ((target % REFERENCE_GRID) + 0.5) * cellPx;
    const cy = (Math.floor(target / REFERENCE_GRID) + 0.5) * cellPx;

    this.clicks.push({
      t: Math.round(now - this.startMs),
      targetCell: target,
      dx: Math.round((point.x - cx) * 10) / 10,
      dy: Math.round((point.y - cy) * 10) / 10,
      mtMs: Math.round(now - this.lastClickMs),
    });
    this.lastClickMs = now;
    this.pointerType = e.pointerType || this.pointerType;

    // Same hit feedback as the game — bloop + particle burst at the cell actually clicked.
    // Calibration IS the warm-up, so it should feel like the game rather than like a form.
    const clicked = this.view.cellAt(e.clientX, e.clientY);
    this.engine.lastCorrectCell = clicked >= 0 ? clicked : target;
    this.engine.lastCorrectMs = now;
    this.hooks.onClick?.();
    this.engine.index++; // any click advances — the miss is data, not a penalty

    this.counter.textContent = `calibrating: ${this.clicks.length} / ${CALIB_CLICKS}`;
    if (this.clicks.length >= CALIB_CLICKS) this.finish();
  };

  private finish(): void {
    this.abort();
    const result = computeCalibration(this.clicks, {
      fieldPx: this.view.fieldPx,
      referenceGrid: REFERENCE_GRID,
      devicePixelRatio: this.view.dpr,
      pointerType: this.pointerType,
    });
    if (!result) {
      this.hooks.onFailed('Not enough clean clicks to size the grid — please calibrate again.');
      return;
    }
    this.hooks.onDone(result);
  }

  /** Dev aid (?calibrate&demo): auto-click each target with sub-cell scatter, driving the real
   *  pointerdown path so the whole σ pipeline runs end-to-end headlessly. */
  startDemo(): void {
    const tick = (): void => {
      if (this.done) return;
      const target = this.engine.target();
      const cellPx = this.view.cellPx;
      const rect = this.view.element.getBoundingClientRect();
      const col = target % REFERENCE_GRID;
      const row = Math.floor(target / REFERENCE_GRID);
      const noise = (): number => (Math.random() - 0.5) * cellPx * 0.6;
      const opts = {
        clientX: rect.left + (col + 0.5) * cellPx + noise(),
        clientY: rect.top + (row + 0.5) * cellPx + noise(),
        bubbles: true,
        pointerType: 'mouse',
      } as PointerEventInit;
      this.view.element.dispatchEvent(new PointerEvent('pointermove', opts));
      this.view.element.dispatchEvent(new PointerEvent('pointerdown', opts));
      window.setTimeout(tick, 60);
    };
    window.setTimeout(tick, 200);
  }
}

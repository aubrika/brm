// The interactive calibration task: the screen, the click capture, and the hand-off to the pure
// maths in calibration.ts. Split out of app.ts so that everything calibration lives in exactly two
// places — the algorithm (calibration.ts, no DOM) and the task that feeds it (here, all DOM).
//
// It runs on the real game surface: the same GridEngine and the same canvas renderer, at two fixed
// reference widths. That is deliberate. Click times measured on some other widget would be times at
// that widget's target size, not at the game's, and the whole point is to measure the player under
// the conditions they will actually play under.
//
// TWO BLOCKS, back to back on the same surface: a coarse one (16×16) that the player's Fitts line
// is fitted on, then a fine one (64×64) where the departure from that line is measured. The blocks
// have to be separate captures because distance and difficulty are both expressed in cell widths —
// a click cannot belong to two grids at once.
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
  generateBlockScript,
  computeCalibration,
  computeKnee,
  seededRandInt,
  BLOCK_A_GRID,
  BLOCK_B_GRID,
  BLOCK_A_WARMUP,
  BLOCK_B_WARMUP,
  BLOCK_MEASURED,
  type CalibrationResult,
  type CalibrationV2,
  type CandidateEstimate,
  type CalibClick,
} from './calibration.js';

/** The two reference widths, in order. A is the coarse block the Fitts line is fitted on; B is the
 *  fine block where the departure from that line is measured. */
const BLOCKS = [
  { id: 'A' as const, gridSize: BLOCK_A_GRID, warmup: BLOCK_A_WARMUP, seed: 0x9e3779b9 },
  { id: 'B' as const, gridSize: BLOCK_B_GRID, warmup: BLOCK_B_WARMUP, seed: 0x85ebca6b },
];
const TOTAL_CLICKS = BLOCKS.reduce((n, b) => n + b.warmup + BLOCK_MEASURED, 0);

export interface CalibrationHooks {
  /** A usable result; the caller adopts it and returns to config. */
  onDone: (result: CalibrationResult, v2: CalibrationV2, candidates: CandidateEstimate[]) => void;
  /** Too few clicks survived rejection — the caller should prompt to try again. */
  onFailed: (message: string) => void;
  /** Per-click audio, so the task does not own an AudioContext. */
  onClick?: () => void;
}

export class CalibrationTask {
  private readonly config: GameConfig;
  private readonly cleanup = new AbortController();
  private readonly counter: HTMLElement;
  private readonly stripRoot: HTMLElement;
  // Clicks per block, kept apart: each block's targets are indices into its OWN grid, so pooling
  // them would silently reinterpret a 64×64 cell index as a 16×16 one.
  private readonly captured: Record<'A' | 'B', CalibClick[]> = { A: [], B: [] };
  private blockIndex = 0;
  private engine!: GridEngine;
  private view!: GridRenderer;
  private startMs = 0;
  private lastClickMs = 0;
  private pointerType = 'mouse';
  private rafId = 0;
  private done = false;

  constructor(root: HTMLElement, config: GameConfig, private readonly hooks: CalibrationHooks) {
    this.config = config;
    this.stripRoot = el('div', { class: 'strip-root grid-root' });
    this.counter = el('div', { class: 'stats', text: `calibrating: 0 / ${TOTAL_CLICKS}` });
    root.append(
      el('div', { class: 'screen run' }, [
        el('div', { class: 'calib-instruction', text: 'Click each highlighted cell as quickly as you comfortably can.' }),
        el('div', { class: 'strip-wrap' }, [this.stripRoot]),
        el('div', { class: 'readout' }, [this.counter]),
        el('div', { class: 'practice-tag', text: 'CALIBRATION · Esc to cancel' }),
      ]),
    );
    this.startBlock();
    const loop = (): void => {
      this.view.render(performance.now());
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private get block(): (typeof BLOCKS)[number] {
    return BLOCKS[this.blockIndex];
  }

  /** Build the engine + renderer for the current block. The renderer owns a canvas, so the previous
   *  block's is dropped first; its listeners die with the element. */
  private startBlock(): void {
    const { gridSize, warmup, seed } = this.block;
    const script = generateBlockScript(gridSize, warmup + BLOCK_MEASURED, seed);
    const fallback = seededRandInt(0x1234abcd);
    let k = 0;
    const source = (n: number): number => (k < script.length ? script[k++] : fallback(n));

    // No lookahead during calibration: a visible next target invites planning the next movement
    // while finishing this one, which is worth ~150 ms of cycle time (see the ghost A/B) and would
    // measure the player under different conditions than the plain task it is meant to characterise.
    this.engine = new GridEngine({ ...this.config, gridSize, gridDepth: 1, lookaheadDepth: 0 }, false, source);
    this.engine.start(performance.now());

    this.stripRoot.replaceChildren();
    this.view = new GridRenderer(this.engine, this.stripRoot);
    this.view.element.style.cursor = 'crosshair';
    this.view.element.addEventListener('pointerdown', this.onDown, { signal: this.cleanup.signal });
    this.view.element.addEventListener('pointermove', this.onMove, { signal: this.cleanup.signal });

    const now = performance.now();
    if (this.blockIndex === 0) this.startMs = now;
    // The first click of a block has no meaningful movement time — the pointer was wherever the
    // previous block left it, and the grid just changed under it. Block B's warm-up absorbs that,
    // which is what the warm-up is for.
    this.lastClickMs = now;
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

  private get clickCount(): number {
    return this.captured.A.length + this.captured.B.length;
  }

  private onDown = (e: PointerEvent): void => {
    if (this.done || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const now = performance.now();
    const point = this.view.localPoint(e.clientX, e.clientY);
    const target = this.engine.target();
    const g = this.block.gridSize;
    const cellPx = this.view.cellPx;
    const cx = ((target % g) + 0.5) * cellPx;
    const cy = (Math.floor(target / g) + 0.5) * cellPx;

    const bucket = this.captured[this.block.id];
    bucket.push({
      t: Math.round(now - this.startMs),
      targetCell: target,
      dx: Math.round((point.x - cx) * 10) / 10,
      dy: Math.round((point.y - cy) * 10) / 10,
      mtMs: Math.round(now - this.lastClickMs),
      block: this.block.id,
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

    this.counter.textContent = `calibrating: ${this.clickCount} / ${TOTAL_CLICKS}`;
    if (bucket.length >= this.block.warmup + BLOCK_MEASURED) {
      if (this.blockIndex + 1 < BLOCKS.length) {
        this.blockIndex++;
        this.startBlock();
      } else {
        this.finish();
      }
    }
  };

  private finish(): void {
    this.abort();
    const fieldPx = this.view.fieldPx;
    const devicePixelRatio = this.view.dpr;
    // σ is still computed and logged for every calibration, from block A. It is also the fallback
    // recommendation when block A's regression turns out to be noise.
    const result = computeCalibration(this.captured.A, {
      fieldPx,
      referenceGrid: BLOCK_A_GRID,
      devicePixelRatio,
      pointerType: this.pointerType,
    });
    if (!result) {
      this.hooks.onFailed('Not enough clean clicks to size the grid — please calibrate again.');
      return;
    }
    const knee = computeKnee(this.captured.A, this.captured.B, {
      fieldPx,
      devicePixelRatio,
      sigmaFallbackGrid: result.recommendedGrid,
    });
    if (!knee) {
      this.hooks.onFailed('Not enough clean clicks to size the grid — please calibrate again.');
      return;
    }
    result.chosenGrid = knee.v2.recommendedGrid; // what is actually played, in both blocks of the log
    this.hooks.onDone(result, knee.v2, knee.candidates);
  }

  /** Dev aid (?calibrate&demo): auto-click each target through the real pointerdown path, so the
   *  whole two-block pipeline runs end to end headlessly. The synthetic times obey a Fitts line
   *  with a deliberate departure on the fine block — a constant-delay clicker would produce a
   *  zero-slope fit, exercise only the σ fallback, and never touch the knee path at all. */
  startDemo(): void {
    let lastTarget = -1;
    const tick = (): void => {
      if (this.done) return;
      const target = this.engine.target();
      const g = this.block.gridSize;
      const cellPx = this.view.cellPx;
      const rect = this.view.element.getBoundingClientRect();
      const col = target % g;
      const row = Math.floor(target / g);
      const noise = (): number => (Math.random() - 0.5) * cellPx * 0.6;
      const opts = {
        clientX: rect.left + (col + 0.5) * cellPx + noise(),
        clientY: rect.top + (row + 0.5) * cellPx + noise(),
        bubbles: true,
        pointerType: 'mouse',
      } as PointerEventInit;
      this.view.element.dispatchEvent(new PointerEvent('pointermove', opts));
      this.view.element.dispatchEvent(new PointerEvent('pointerdown', opts));

      // Time the NEXT click as a synthetic player would: 180 ms + 130 ms per bit of difficulty,
      // inflated by 30% on the fine block so there is a knee to find.
      const next = this.engine.target();
      const dist = lastTarget < 0 ? cellPx * g * 0.5 : Math.hypot((next % g) - (target % g), Math.floor(next / g) - Math.floor(target / g)) * cellPx;
      lastTarget = target;
      const id = Math.log2(dist / cellPx + 1);
      const delay = (180 + 130 * id) * (this.block.id === 'B' ? 1.3 : 1);
      window.setTimeout(tick, delay);
    };
    window.setTimeout(tick, 200);
  }
}

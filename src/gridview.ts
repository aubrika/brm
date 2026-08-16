// GRID MODE renderer. A single <canvas> — 1024 cells plus full-field locator lines redrawn on
// every advance is a canvas workload; a DOM-node-per-cell approach would fight the latency budget
// (spec §4). The app's run loop already rAFs each frame for the HUD clock, so we simply redraw
// there; the expensive thing the spec warns against (per-cell DOM) is what's avoided, not the
// redraw itself. Draw order is fixed: gridlines → crosshair → connector → ghost border → target
// fill → wrong-cell flash → pulse border.
//
// Coordinate model: the canvas is a square of side fieldPx = cellPx·gridSize, centred in its root.
// Cell (col,row) occupies [col·cellPx, (col+1)·cellPx) × [row·cellPx, …). Hit-testing and pointer
// path samples are done in these field-local pixels (getBoundingClientRect gives the origin), so
// the log is self-contained for Fitts analysis without needing the viewport offset.

import type { GridEngine } from './gridengine.js';

const MARGIN = 20; // px inset from the smaller viewport dimension
const TARGET_ORANGE = '#E69F00';
const GHOST_GRAY = '#6B7789';
const FLASH_MS = 140; // wrong-cell flash duration
const PULSE_HZ = 2;
const GHOST_ADJACENT = 2; // Chebyshev distance within which the ghost border is suppressed (§2.3)

export class GridRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly reducedMotion: boolean;

  gridSize: number;
  cellPx = 0;
  fieldPx = 0;
  dpr = 1;
  hoverCell = -1; // set by the app on pointermove; drives the pulse

  constructor(private readonly engine: GridEngine, private readonly root: HTMLElement) {
    this.gridSize = engine.gridSize;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'grid-canvas';
    root.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.resize();
  }

  // The canvas element — the app attaches pointer listeners here (they die with the element when
  // the screen is replaced, so there is nothing to detach).
  get element(): HTMLCanvasElement {
    return this.canvas;
  }

  // Largest integer-cell square that fits the root with a margin. Integer cellPx keeps gridlines
  // crisp; the canvas backing store is scaled by devicePixelRatio for sharp lines on HiDPI.
  resize(): void {
    const w = this.root.clientWidth || window.innerWidth;
    const h = this.root.clientHeight || 360;
    const avail = Math.max(64, Math.min(w, h) - MARGIN * 2);
    this.cellPx = Math.max(6, Math.floor(avail / this.gridSize));
    this.fieldPx = this.cellPx * this.gridSize;
    this.dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    this.canvas.style.width = `${this.fieldPx}px`;
    this.canvas.style.height = `${this.fieldPx}px`;
    this.canvas.width = Math.round(this.fieldPx * this.dpr);
    this.canvas.height = Math.round(this.fieldPx * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  // Client (viewport) coordinates → cell index, or -1 if outside the field. Pure arithmetic
  // (floor(x / cellPx)); never per-cell DOM hit targets.
  cellAt(clientX: number, clientY: number): number {
    const r = this.canvas.getBoundingClientRect();
    const col = Math.floor((clientX - r.left) / this.cellPx);
    const row = Math.floor((clientY - r.top) / this.cellPx);
    if (col < 0 || col >= this.gridSize || row < 0 || row >= this.gridSize) return -1;
    return row * this.gridSize + col;
  }

  // Field-local coordinates of a client point (for path sampling). Not clamped — the analyzer sees
  // exactly where the pointer was, including just outside the field.
  localPoint(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  private col(idx: number): number {
    return idx % this.gridSize;
  }
  private row(idx: number): number {
    return Math.floor(idx / this.gridSize);
  }
  private centerX(idx: number): number {
    return (this.col(idx) + 0.5) * this.cellPx;
  }
  private centerY(idx: number): number {
    return (this.row(idx) + 0.5) * this.cellPx;
  }

  // Is the current target's ghost suppressed? True when T+1 sits within GHOST_ADJACENT cells
  // (Chebyshev) of T, so its border would crowd the precision-critical end of the movement. The
  // app logs this per selection so misclick analysis can compare (§2.3).
  ghostSuppressed(): boolean {
    if (!this.engine.config.ghost) return false;
    const t = this.engine.target();
    const g = this.engine.nextTarget();
    if (t < 0 || g < 0) return false;
    return Math.max(Math.abs(this.col(t) - this.col(g)), Math.abs(this.row(t) - this.row(g))) <= GHOST_ADJACENT;
  }

  render(nowMs: number): void {
    const ctx = this.ctx;
    const f = this.fieldPx;
    const cp = this.cellPx;
    const cfg = this.engine.config;
    ctx.clearRect(0, 0, f, f);

    // 1) gridlines — low contrast texture
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(200, 212, 235, 0.06)';
    ctx.beginPath();
    for (let i = 0; i <= this.gridSize; i++) {
      const p = Math.round(i * cp) + 0.5; // +0.5 for a crisp 1px line
      ctx.moveTo(p, 0);
      ctx.lineTo(p, f);
      ctx.moveTo(0, p);
      ctx.lineTo(f, p);
    }
    ctx.stroke();

    const target = this.engine.target();
    const ghost = this.engine.nextTarget();

    // 2) crosshair locator — full-field hairlines through the target's centre, dim orange so they
    //    read as belonging to the target but stay subordinate to the fill (§2.1)
    if (cfg.crosshair && target >= 0) {
      const cx = Math.round(this.centerX(target)) + 0.5;
      const cy = Math.round(this.centerY(target)) + 0.5;
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(230, 159, 0, 0.32)';
      ctx.beginPath();
      ctx.moveTo(0, cy);
      ctx.lineTo(f, cy);
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, f);
      ctx.stroke();
    }

    // 3) connector — target centre → ghost centre, previews the next movement vector (§2.3)
    if (cfg.ghost && ghost >= 0 && target >= 0) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(107, 119, 137, 0.85)';
      ctx.beginPath();
      ctx.moveTo(this.centerX(target), this.centerY(target));
      ctx.lineTo(this.centerX(ghost), this.centerY(ghost));
      ctx.stroke();
    }

    // 4) ghost border — empty cell, gray outline; suppressed near the target during the precision
    //    phase (connector still drawn above)
    if (cfg.ghost && ghost >= 0 && !this.ghostSuppressed()) {
      const gx = this.col(ghost) * cp;
      const gy = this.row(ghost) * cp;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = GHOST_GRAY;
      ctx.strokeRect(gx + 1.5, gy + 1.5, cp - 3, cp - 3);
    }

    // 5) target fill — the active cell, solid orange
    if (target >= 0) {
      const tx = this.col(target) * cp;
      const ty = this.row(target) * cp;
      ctx.fillStyle = TARGET_ORANGE;
      ctx.fillRect(tx + 0.5, ty + 0.5, cp - 1, cp - 1);
    }

    // 6) wrong-cell flash — brief, no motion (monitoring-disruption findings: flash, never shake)
    const sinceErr = nowMs - this.engine.lastErrorMs;
    if (this.engine.lastErrorCell >= 0 && sinceErr >= 0 && sinceErr < FLASH_MS) {
      const ex = this.col(this.engine.lastErrorCell) * cp;
      const ey = this.row(this.engine.lastErrorCell) * cp;
      ctx.fillStyle = `rgba(255, 91, 104, ${(0.55 * (1 - sinceErr / FLASH_MS)).toFixed(3)})`;
      ctx.fillRect(ex + 0.5, ey + 0.5, cp - 1, cp - 1);
    }

    // 7) hover pulse — pre-click confirmation: white border while the pointer is on the target
    if (cfg.hoverPulse && target >= 0 && this.hoverCell === target) {
      const tx = this.col(target) * cp;
      const ty = this.row(target) * cp;
      const a = this.reducedMotion ? 0.95 : 0.4 + 0.6 * (0.5 + 0.5 * Math.sin((nowMs / 1000) * PULSE_HZ * 2 * Math.PI));
      ctx.lineWidth = 2;
      ctx.strokeStyle = `rgba(255, 255, 255, ${a.toFixed(3)})`;
      ctx.strokeRect(tx + 1, ty + 1, cp - 2, cp - 2);
    }
  }
}

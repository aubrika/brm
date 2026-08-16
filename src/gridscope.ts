// SCOPE MODE renderer (see bitrate-scope-mode-spec.md). A very fine grid (256²) whose cells are
// below comfortable clicking size, drawn with oversized *perceptual* acquisition aids at true scale
// (a halo ring on the target, full-field crosshair locator, a gray ghost halo + connector), plus a
// software VIRTUAL CURSOR (position accumulated from raw pointer-lock movement × gain by the app)
// and a hold-to-magnify LENS: a circular region around the cursor drawn at `magnification`× so the
// tiny target cell becomes comfortably clickable, with the pointer slowed to match while held.
//
// Scoring is identical to grid mode (the app hit-tests the virtual cursor's cell); everything here
// is presentation. The app sets `virtualCursor` (field-local px) and `scoped` each frame; the
// renderer reads the shared GridEngine for the target/ghost cells.

import type { GridEngine } from './gridengine.js';

const MARGIN = 20;
const TARGET_ORANGE = '#E69F00';
const GHOST_GRAY = '#6B7789';
const HALO_PX = 26; // outer diameter of the target ring at true scale
const RETICLE_PX = 14; // virtual-cursor crosshair arm span
const PULSE_HZ = 2;

export class ScopeRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly reducedMotion: boolean;

  gridSize: number;
  cellPx = 0; // fractional at 256 (~2.5px) — do NOT floor; hit-testing is arithmetic
  fieldPx = 0;
  dpr = 1;
  virtualCursor = { x: 0, y: 0 }; // field-local px, set by the app from locked movement × gain
  scoped = false; // is the lens held active?

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
    this.virtualCursor = { x: this.fieldPx / 2, y: this.fieldPx / 2 }; // start centred
  }

  get element(): HTMLCanvasElement {
    return this.canvas;
  }

  resize(): void {
    const w = this.root.clientWidth || window.innerWidth;
    const h = this.root.clientHeight || 360;
    this.fieldPx = Math.max(64, Math.min(w, h) - MARGIN * 2);
    this.cellPx = this.fieldPx / this.gridSize;
    this.dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    this.canvas.style.width = `${this.fieldPx}px`;
    this.canvas.style.height = `${this.fieldPx}px`;
    this.canvas.width = Math.round(this.fieldPx * this.dpr);
    this.canvas.height = Math.round(this.fieldPx * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // keep the cursor inside the (possibly resized) field
    this.virtualCursor = { x: this.clamp(this.virtualCursor.x), y: this.clamp(this.virtualCursor.y) };
  }

  private clamp(v: number): number {
    return Math.max(0, Math.min(this.fieldPx, v));
  }

  // field-local px → cell index, or -1 if outside
  cellAt(x: number, y: number): number {
    const col = Math.floor(x / this.cellPx);
    const row = Math.floor(y / this.cellPx);
    if (col < 0 || col >= this.gridSize || row < 0 || row >= this.gridSize) return -1;
    return row * this.gridSize + col;
  }

  private col(idx: number): number {
    return idx % this.gridSize;
  }
  private row(idx: number): number {
    return Math.floor(idx / this.gridSize);
  }
  private cx(idx: number): number {
    return (this.col(idx) + 0.5) * this.cellPx;
  }
  private cy(idx: number): number {
    return (this.row(idx) + 0.5) * this.cellPx;
  }

  private reticle(x: number, y: number, arm: number, color: string, lw: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(x - arm, y);
    ctx.lineTo(x - 3, y);
    ctx.moveTo(x + 3, y);
    ctx.lineTo(x + arm, y);
    ctx.moveTo(x, y - arm);
    ctx.lineTo(x, y - 3);
    ctx.moveTo(x, y + 3);
    ctx.lineTo(x, y + arm);
    ctx.stroke();
  }

  render(nowMs: number): void {
    const ctx = this.ctx;
    const f = this.fieldPx;
    const cfg = this.engine.config;
    ctx.clearRect(0, 0, f, f);
    // faint field border (the grid itself is too dense to draw at true scale)
    ctx.strokeStyle = 'rgba(200,212,235,0.10)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, f - 1, f - 1);

    const target = this.engine.target();
    const ghost = this.engine.nextTarget();

    // ---- true-scale acquisition aids ----
    // crosshair locator through the target row/column — the primary aid at this density
    if (cfg.crosshair && target >= 0) {
      const tx = Math.round(this.cx(target)) + 0.5;
      const ty = Math.round(this.cy(target)) + 0.5;
      ctx.strokeStyle = 'rgba(230,159,0,0.32)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, ty);
      ctx.lineTo(f, ty);
      ctx.moveTo(tx, 0);
      ctx.lineTo(tx, f);
      ctx.stroke();
    }
    // ghost connector + gray halo (next target)
    if (cfg.ghost && ghost >= 0 && target >= 0) {
      ctx.strokeStyle = 'rgba(107,119,137,0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.cx(target), this.cy(target));
      ctx.lineTo(this.cx(ghost), this.cy(ghost));
      ctx.stroke();
      ctx.strokeStyle = GHOST_GRAY;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(this.cx(ghost), this.cy(ghost), HALO_PX / 2, 0, Math.PI * 2);
      ctx.stroke();
    }
    // target halo: a high-contrast orange ring; the actual cell is a speck at true scale, so also
    // dot its centre so an unscoped confident click has something to aim at
    if (target >= 0) {
      const hx = this.cx(target);
      const hy = this.cy(target);
      ctx.strokeStyle = TARGET_ORANGE;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(hx, hy, HALO_PX / 2, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = TARGET_ORANGE;
      ctx.fillRect(hx - Math.max(1.5, this.cellPx / 2), hy - Math.max(1.5, this.cellPx / 2), Math.max(3, this.cellPx), Math.max(3, this.cellPx));
    }

    // wrong-cell flash (true scale) — a red ring where the last miss landed
    const sinceErr = nowMs - this.engine.lastErrorMs;
    if (this.engine.lastErrorCell >= 0 && sinceErr >= 0 && sinceErr < 160) {
      ctx.strokeStyle = `rgba(255,91,104,${(0.7 * (1 - sinceErr / 160)).toFixed(3)})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(this.cx(this.engine.lastErrorCell), this.cy(this.engine.lastErrorCell), HALO_PX / 2, 0, Math.PI * 2);
      ctx.stroke();
    }

    // virtual cursor reticle (this IS the cursor — no OS cursor under pointer lock)
    this.reticle(this.virtualCursor.x, this.virtualCursor.y, RETICLE_PX, 'rgba(255,255,255,0.9)', 1.5);

    // ---- lens (while scoped) ----
    if (this.scoped) {
      this.renderLens(nowMs, target, ghost);
    }
  }

  private renderLens(nowMs: number, target: number, ghost: number): void {
    const ctx = this.ctx;
    const f = this.fieldPx;
    const mag = Math.max(2, this.engine.config.magnification || 8);
    const R = (this.engine.config.lensDiameter || 0.4) * f * 0.5;
    const ox = this.virtualCursor.x;
    const oy = this.virtualCursor.y;

    // dim everything outside the lens
    ctx.fillStyle = 'rgba(6,8,12,0.45)';
    ctx.fillRect(0, 0, f, f);

    ctx.save();
    ctx.beginPath();
    ctx.arc(ox, oy, R, 0, Math.PI * 2);
    ctx.clip();
    // opaque lens background (undims the magnified content)
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(ox - R, oy - R, R * 2, R * 2);

    // field point p → lens coord: lensCentre + (p − cursor)·mag
    const lx = (fx: number): number => ox + (fx - ox) * mag;
    const ly = (fy: number): number => oy + (fy - oy) * mag;
    const halfField = R / mag; // field-space half-extent visible in the lens
    const kMin = Math.floor((ox - halfField) / this.cellPx);
    const kMax = Math.ceil((ox + halfField) / this.cellPx);
    const jMin = Math.floor((oy - halfField) / this.cellPx);
    const jMax = Math.ceil((oy + halfField) / this.cellPx);

    // magnified gridlines
    ctx.strokeStyle = 'rgba(200,212,235,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = kMin; k <= kMax; k++) {
      const X = lx(k * this.cellPx);
      ctx.moveTo(X, oy - R);
      ctx.lineTo(X, oy + R);
    }
    for (let j = jMin; j <= jMax; j++) {
      const Y = ly(j * this.cellPx);
      ctx.moveTo(ox - R, Y);
      ctx.lineTo(ox + R, Y);
    }
    ctx.stroke();

    const magCell = this.cellPx * mag;
    const drawCellFill = (idx: number, style: string): void => {
      ctx.fillStyle = style;
      ctx.fillRect(lx(this.col(idx) * this.cellPx), ly(this.row(idx) * this.cellPx), magCell, magCell);
    };
    const drawCellStroke = (idx: number, style: string, lw: number): void => {
      ctx.strokeStyle = style;
      ctx.lineWidth = lw;
      ctx.strokeRect(lx(this.col(idx) * this.cellPx) + lw, ly(this.row(idx) * this.cellPx) + lw, magCell - 2 * lw, magCell - 2 * lw);
    };

    if (ghost >= 0) drawCellStroke(ghost, GHOST_GRAY, 2);
    if (target >= 0) drawCellFill(target, TARGET_ORANGE);

    // the click candidate: the cell under the reticle centre — outline + hover pulse
    const candidate = this.cellAt(ox, oy);
    if (candidate >= 0) {
      const a = this.reducedMotion ? 0.9 : 0.45 + 0.55 * (0.5 + 0.5 * Math.sin((nowMs / 1000) * PULSE_HZ * 2 * Math.PI));
      const hit = this.engine.config.hoverPulse && candidate === target;
      drawCellStroke(candidate, hit ? `rgba(255,255,255,${a.toFixed(3)})` : 'rgba(200,212,235,0.5)', hit ? 2.5 : 1.5);
    }
    ctx.restore();

    // lens rim + centre reticle
    ctx.strokeStyle = 'rgba(200,212,235,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ox, oy, R, 0, Math.PI * 2);
    ctx.stroke();
    this.reticle(ox, oy, RETICLE_PX + 4, 'rgba(255,255,255,0.95)', 1.5);
  }
}

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

import type { GridEngine } from './engine.js';
import type { GridConfig } from '../core/config.js';

const MARGIN = 20; // px inset from the smaller viewport dimension
// The target's fill, and the crosshair tint (same hue at low alpha). Okabe-Ito orange. The config
// screen paints the word "orange" in this exact value via --target in style.css — if this moves,
// move that, or the instructions name a colour the game does not draw.
const TARGET_COLOR = '#E69F00';
const TARGET_CROSSHAIR = 'rgba(230, 159, 0, 0.32)';
// Lookahead ramp, indexed by how far ahead the target is (0 = T+1, 1 = T+2). Brightness falls with
// distance so the chain reads as ORDERED at a glance — two equally bright outlines would just look
// like two targets and put the "which one first?" decision back on the player, which is the cost
// the preview exists to remove. T+2 stays clearly dimmer than T+1 and both stay well below the
// orange fill, so neither competes with the cell you must click now.
const LOOKAHEAD_BORDER = ['#AEBACE', '#69748A'];
const LOOKAHEAD_BORDER_PX = [2, 1.25];
const LOOKAHEAD_LINE = ['rgba(174, 186, 206, 0.95)', 'rgba(105, 116, 138, 0.55)'];
const LOOKAHEAD_LINE_PX = [1.5, 1];
const FLASH_MS = 140; // wrong-cell flash duration
const REPEAT_FLASH_MS = 200; // white confirm-flash when the next target repeats the same cell
const PULSE_HZ = 2;
const GHOST_ADJACENT = 2; // Chebyshev distance flagged as "next target is close" (logged, not suppressed)

// ---- pure geometry (no DOM) -------------------------------------------------
// Extracted so the load-bearing arithmetic is unit-testable: cellIndexAt decides correct-vs-error
// on EVERY click, and fitGridGeometry fixes the cell size W that every logged Fitts number depends
// on. See view.test.ts.

/** Cell sizes below this are not reliably tappable with a fingertip — Apple HIG says 44pt, Material
 *  48dp, and a contact patch is ~40px wide. Only consulted on coarse pointers. */
export const TOUCH_MIN_CELL_PX = 44;
/** Grid sizes the touch fitter may choose from, coarsest first. */
export const TOUCH_GRID_LADDER = [4, 6, 8, 10, 12, 16, 20, 24, 32] as const;

/** The square the field is fitted into, from the play area's dimensions. The grid is a SQUARE, so
 *  the smaller dimension always binds — on a portrait phone that is the width, and in landscape it
 *  is the height. Exported so the run can size its grid from the same number resize() will use;
 *  computing it twice by different routes is how a run ends up with cells it did not plan for. */
export function availableFieldPx(w: number, h: number): number {
  const side = Math.min(w, h);
  // The margin is a fixed 20px inset on a roomy screen, but on a small one it is a real fraction of
  // the field and the cost is measured in grid rungs: at 300px (a phone in landscape) the full 40px
  // is the difference between a 6×6 grid and a 4×4 one — 5.13 bits per selection against 3.91.
  // Capping it at 4% of the side leaves desktop untouched — measured: a 1600×900 scored run has a
  // 720px short side, 4% of which is 29, so the cap never binds and the field is 680px either way.
  // The existing dataset keeps its geometry; the cap only bites where the inset was expensive.
  const margin = Math.min(MARGIN, Math.round(side * 0.04));
  return Math.max(64, side - margin * 2);
}

/** The finest grid on the ladder whose cells clear `minCellPx`, or the coarsest rung if none do.
 *  This is the whole of the touch adaptation: fewer, bigger cells. Widening the field cannot
 *  substitute for it — on a phone the field is already as wide as the viewport, and 32×32 there is
 *  a 9px cell against a ~40px fingertip. */
export function fitTouchGrid(availPx: number, minCellPx = TOUCH_MIN_CELL_PX, ladder: readonly number[] = TOUCH_GRID_LADDER): number {
  let best = ladder[0];
  for (const g of ladder) if (Math.floor(availPx / g) >= minCellPx) best = g;
  return best;
}

/** Largest integer-cell square fitting `availPx`. Integer cellPx keeps gridlines crisp.
 *  The floor is 1px, not 2: the play field is clipped by its container, so a field wider than the
 *  space would push cells off-screen where they cannot be clicked but can still be TARGETS — an
 *  unwinnable run. Cells too small to aim at are merely hard; cells you cannot reach are broken. */
export function fitGridGeometry(availPx: number, gridSize: number): { cellPx: number; fieldPx: number } {
  const cellPx = Math.max(1, Math.floor(availPx / gridSize));
  return { cellPx, fieldPx: cellPx * gridSize };
}

/** Field-local px → cell index, or -1 outside the grid. Pure arithmetic; never per-cell DOM. */
export function cellIndexAt(x: number, y: number, cellPx: number, gridSize: number): number {
  const col = Math.floor(x / cellPx);
  const row = Math.floor(y / cellPx);
  if (col < 0 || col >= gridSize || row < 0 || row >= gridSize) return -1;
  return row * gridSize + col;
}

/** Chebyshev distance between two cells, in cells. */
export function cellsApart(a: number, b: number, gridSize: number): number {
  return Math.max(Math.abs((a % gridSize) - (b % gridSize)), Math.abs(Math.floor(a / gridSize) - Math.floor(b / gridSize)));
}

/** Which lookahead outlines to actually draw. The i.i.d. sequence repeats a cell every 1/N
 *  selections, and at lookahead depth 2 it can also put T+2 on T+1. Stacking a second outline on a
 *  cell that already carries one — or on the orange target — reads as an extra target rather than
 *  a repeat, so only the FIRST (brightest) claim on a cell is drawn. Pure so the repeat case,
 *  which is otherwise a once-per-hundred-selections visual bug, is testable. */
export function visibleLookahead(target: number, cells: number[]): boolean[] {
  const claimed = new Set<number>([target]);
  return cells.map((c) => {
    if (c < 0 || claimed.has(c)) return false;
    claimed.add(c);
    return true;
  });
}

export class GridRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly reducedMotion: boolean;

  gridSize: number;
  cellPx = 0;
  fieldPx = 0;
  dpr = 1;
  hoverCell = -1; // set by the app on pointermove; drives the pulse

  // hit particle burst (juice on a correct click)
  private particles: Array<{ x: number; y: number; vx: number; vy: number; t0: number; life: number; r: number; color: string }> = [];
  private lastBurstMs = -Infinity;

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
    const avail = availableFieldPx(w, h);
    // integer cell px keeps gridlines crisp; min 2px so large grids (64/128) still fit the field
    // instead of overflowing it (floor keeps fieldPx ≤ avail).
    const geom = fitGridGeometry(avail, this.gridSize);
    this.cellPx = geom.cellPx;
    this.fieldPx = geom.fieldPx;
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
    return cellIndexAt(clientX - r.left, clientY - r.top, this.cellPx, this.gridSize);
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

  // Is the current target's next target "close" — T+1 within GHOST_ADJACENT cells (Chebyshev) of T?
  // The ghost border is always drawn (a preference: its irregular appearance was distracting, and
  // the grey outline is distinct enough from the orange fill even when adjacent). This is now a
  // pure geometry flag the app logs per selection, so the analyzer can test whether a close next
  // target correlates with more misclicks / a longer dwell.
  ghostAdjacent(): boolean {
    const t = this.engine.target();
    const g = this.engine.nextTarget();
    if (t < 0 || g < 0) return false;
    return cellsApart(t, g, this.gridSize) <= GHOST_ADJACENT;
  }

  /** One frame, drawn back to front. Each layer is its own method: the ordering IS the design —
   *  the target must sit on top of a lookahead outline that landed on the same cell, the flashes
   *  must sit on top of the target, and the particles on top of everything — so a reader needs to
   *  see the sequence without reading the drawing code, and a change to one layer should not be a
   *  change inside a 130-line function. */
  render(nowMs: number): void {
    const ctx = this.ctx;
    const cfg = this.engine.config;
    const target = this.engine.target(); // the cell to click now
    const lookahead = this.lookaheadCells(cfg);

    ctx.clearRect(0, 0, this.fieldPx, this.fieldPx);
    this.drawGridlines(ctx);
    if (cfg.crosshair) this.drawCrosshair(ctx, target);
    this.drawConnector(ctx, target, lookahead);
    this.drawLookaheadOutlines(ctx, target, lookahead);
    this.drawTarget(ctx, target);
    this.drawRepeatFlash(ctx, target, nowMs);
    this.drawErrorFlash(ctx, nowMs);
    if (cfg.hoverPulse) this.drawHoverPulse(ctx, target, nowMs);
    this.drawHitParticles(nowMs);
  }

  /** The previewed chain: T+1, then T+2 if the lookahead depth is 2. Clamped to the 0..2 the config
   *  offers, and truncated at the end of the sequence (lookaheadTarget returns -1 there). */
  private lookaheadCells(cfg: GridConfig): number[] {
    const depth = Math.max(0, Math.min(LOOKAHEAD_BORDER.length, Math.round(cfg.lookaheadDepth)));
    const out: number[] = [];
    for (let k = 1; k <= depth; k++) {
      const cell = this.engine.lookaheadTarget(k);
      if (cell < 0) break;
      out.push(cell);
    }
    return out;
  }

  /** 1) gridlines — low contrast texture. */
  private drawGridlines(ctx: CanvasRenderingContext2D): void {
    const f = this.fieldPx;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(200, 212, 235, 0.06)';
    ctx.beginPath();
    for (let i = 0; i <= this.gridSize; i++) {
      const p = Math.round(i * this.cellPx) + 0.5; // +0.5 for a crisp 1px line
      ctx.moveTo(p, 0);
      ctx.lineTo(p, f);
      ctx.moveTo(0, p);
      ctx.lineTo(f, p);
    }
    ctx.stroke();
  }

  /** 2) crosshair locator — full-field hairlines through the target's centre, tinted with the
   *  target's own colour so it reads as belonging to the cell you must click now (§2.1). */
  private drawCrosshair(ctx: CanvasRenderingContext2D, target: number): void {
    if (target < 0) return;
    const cx = Math.round(this.centerX(target)) + 0.5;
    const cy = Math.round(this.centerY(target)) + 0.5;
    ctx.lineWidth = 1;
    ctx.strokeStyle = TARGET_CROSSHAIR;
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(this.fieldPx, cy);
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, this.fieldPx);
    ctx.stroke();
  }

  /** 3) connector — target → T+1 → T+2, tracing the cursor travel the preview is promising.
   *  Segments are drawn one at a time because each carries its own brightness: target→T+1 is
   *  bright, T+1→T+2 is dim. One polyline could not say that, and the fade IS the information —
   *  it is what makes the chain read in order rather than as two equal destinations. */
  private drawConnector(ctx: CanvasRenderingContext2D, target: number, lookahead: number[]): void {
    if (!lookahead.length || target < 0) return;
    const pts: Array<[number, number]> = [[this.centerX(target), this.centerY(target)]];
    for (const cell of lookahead) pts.push([this.centerX(cell), this.centerY(cell)]);
    for (let i = 1; i < pts.length; i++) {
      const step = i - 1;
      ctx.lineWidth = LOOKAHEAD_LINE_PX[step] ?? 1;
      ctx.strokeStyle = LOOKAHEAD_LINE[step] ?? LOOKAHEAD_LINE[LOOKAHEAD_LINE.length - 1];
      ctx.beginPath();
      ctx.moveTo(pts[i - 1][0], pts[i - 1][1]);
      ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    }
  }

  /** 4) lookahead outlines — empty cells, grey, fading with distance. Always drawn (even adjacent
   *  to the target), so they never flicker on/off between selections; skipped only where the cell
   *  already carries an outline or the orange fill (see visibleLookahead). Drawn far-to-near so
   *  that if two land on neighbouring pixels the brighter T+1 wins the overlap. */
  private drawLookaheadOutlines(ctx: CanvasRenderingContext2D, target: number, lookahead: number[]): void {
    const visible = visibleLookahead(target, lookahead);
    const cp = this.cellPx;
    for (let k = lookahead.length - 1; k >= 0; k--) {
      if (!visible[k]) continue;
      const gx = this.col(lookahead[k]) * cp;
      const gy = this.row(lookahead[k]) * cp;
      const w = LOOKAHEAD_BORDER_PX[k] ?? 1;
      ctx.lineWidth = w;
      ctx.strokeStyle = LOOKAHEAD_BORDER[k] ?? LOOKAHEAD_BORDER[LOOKAHEAD_BORDER.length - 1];
      ctx.strokeRect(gx + w / 2 + 0.5, gy + w / 2 + 0.5, cp - w - 1, cp - w - 1);
    }
  }

  /** 5) the target fill — after the outlines, so it sits on top of a lookahead that landed on the
   *  same cell. */
  private drawTarget(ctx: CanvasRenderingContext2D, target: number): void {
    if (target < 0) return;
    ctx.fillStyle = TARGET_COLOR;
    this.fillCell(ctx, target);
  }

  /** 5b) repeated-target flash — the i.i.d. sequence can draw the same cell twice in a row (rate
   *  1/N). Then the orange cell doesn't move on a correct click, so the hit would look like a dead
   *  click; a brief white flash makes the repeat legible. Only fires when the just-completed cell
   *  IS the new target, so normal play is unchanged. */
  private drawRepeatFlash(ctx: CanvasRenderingContext2D, target: number, nowMs: number): void {
    const since = nowMs - this.engine.lastCorrectMs;
    if (target < 0 || this.engine.lastCorrectCell !== target || since < 0 || since >= REPEAT_FLASH_MS) return;
    ctx.fillStyle = `rgba(255, 255, 255, ${(0.7 * (1 - since / REPEAT_FLASH_MS)).toFixed(3)})`;
    this.fillCell(ctx, target);
  }

  /** 6) wrong-cell flash — brief, no motion (monitoring-disruption findings: flash, never shake). */
  private drawErrorFlash(ctx: CanvasRenderingContext2D, nowMs: number): void {
    const since = nowMs - this.engine.lastErrorMs;
    if (this.engine.lastErrorCell < 0 || since < 0 || since >= FLASH_MS) return;
    ctx.fillStyle = `rgba(255, 91, 104, ${(0.55 * (1 - since / FLASH_MS)).toFixed(3)})`;
    this.fillCell(ctx, this.engine.lastErrorCell);
  }

  /** 7) hover pulse — pre-click confirmation: a white border while the pointer is on the target. */
  private drawHoverPulse(ctx: CanvasRenderingContext2D, target: number, nowMs: number): void {
    if (target < 0 || this.hoverCell !== target) return;
    const cp = this.cellPx;
    const a = this.reducedMotion ? 0.95 : 0.4 + 0.6 * (0.5 + 0.5 * Math.sin((nowMs / 1000) * PULSE_HZ * 2 * Math.PI));
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(255, 255, 255, ${a.toFixed(3)})`;
    ctx.strokeRect(this.col(target) * cp + 1, this.row(target) * cp + 1, cp - 2, cp - 2);
  }

  /** 8) hit particles — spawn a burst at the just-completed cell on each correct click, then
   *  animate them on top of everything. Skipped under reduced-motion (the flash/sound remain). */
  private drawHitParticles(nowMs: number): void {
    if (this.reducedMotion) return;
    if (this.engine.lastCorrectMs > this.lastBurstMs && this.engine.lastCorrectCell >= 0) {
      this.spawnBurst(this.engine.lastCorrectCell, nowMs);
      this.lastBurstMs = this.engine.lastCorrectMs;
    }
    this.drawParticles(nowMs);
  }

  /** Fill one cell, inset half a pixel so adjacent fills do not bleed into each other. */
  private fillCell(ctx: CanvasRenderingContext2D, cell: number): void {
    const cp = this.cellPx;
    ctx.fillRect(this.col(cell) * cp + 0.5, this.row(cell) * cp + 0.5, cp - 1, cp - 1);
  }

  private spawnBurst(cell: number, nowMs: number): void {
    const cx = (this.col(cell) + 0.5) * this.cellPx;
    const cy = (this.row(cell) + 0.5) * this.cellPx;
    const speed = Math.max(70, this.cellPx * 7); // scales with cell size, floored so it shows on tiny cells
    const r = Math.max(1.5, this.cellPx * 0.14);
    const n = 16;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const sp = speed * (0.45 + Math.random() * 0.8);
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        t0: nowMs,
        life: 340 + Math.random() * 260,
        r,
        color: i % 3 === 0 ? '#ffffff' : TARGET_COLOR,
      });
    }
    if (this.particles.length > 400) this.particles.splice(0, this.particles.length - 400); // hard cap
  }

  private drawParticles(nowMs: number): void {
    const ctx = this.ctx;
    const G = 260; // gravity px/s²
    const alive: typeof this.particles = [];
    for (const p of this.particles) {
      const ms = nowMs - p.t0;
      if (ms < 0 || ms >= p.life) continue;
      const s = ms / 1000;
      const x = p.x + p.vx * s;
      const y = p.y + p.vy * s + 0.5 * G * s * s;
      const a = 1 - ms / p.life;
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(x, y, p.r * (0.5 + 0.5 * a), 0, Math.PI * 2);
      ctx.fill();
      alive.push(p);
    }
    ctx.globalAlpha = 1;
    this.particles = alive;
  }
}

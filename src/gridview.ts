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
// One fill colour per layer: layer 0 (click first) orange, layer 1 blue. Orange/blue is the
// colourblind-safe pair. crosshair tints are the same hues at low alpha.
const LAYER_COLORS = ['#E69F00', '#3B82F6'];
const LAYER_CROSSHAIR = ['rgba(230, 159, 0, 0.32)', 'rgba(59, 130, 246, 0.34)'];
const GHOST_GRAY = '#6B7789';
const FLASH_MS = 140; // wrong-cell flash duration
const REPEAT_FLASH_MS = 200; // white confirm-flash when the next target repeats the same cell
const PULSE_HZ = 2;
const GHOST_ADJACENT = 2; // Chebyshev distance flagged as "next target is close" (logged, not suppressed)

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
    const avail = Math.max(64, Math.min(w, h) - MARGIN * 2);
    // integer cell px keeps gridlines crisp; min 2px so large grids (64/128) still fit the field
    // instead of overflowing it (floor keeps fieldPx ≤ avail).
    this.cellPx = Math.max(2, Math.floor(avail / this.gridSize));
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

  // Is the current target's next target "close" — T+1 within GHOST_ADJACENT cells (Chebyshev) of T?
  // The ghost border is always drawn (a preference: its irregular appearance was distracting, and
  // the grey outline is distinct enough from the orange fill even when adjacent). This is now a
  // pure geometry flag the app logs per selection, so the analyzer can test whether a close next
  // target correlates with more misclicks / a longer dwell.
  ghostAdjacent(): boolean {
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

    const target = this.engine.target(); // the ACTIVE cell — the one to click now
    const ghost = this.engine.nextTarget(); // next selection's first (orange) cell
    const active = this.engine.subIndex; // active layer

    // 2) crosshair locator — full-field hairlines through the ACTIVE target's centre, tinted with
    //    that layer's colour so it reads as belonging to the cell you must click now (§2.1)
    if (cfg.crosshair && target >= 0) {
      const cx = Math.round(this.centerX(target)) + 0.5;
      const cy = Math.round(this.centerY(target)) + 0.5;
      ctx.lineWidth = 1;
      ctx.strokeStyle = LAYER_CROSSHAIR[active] ?? LAYER_CROSSHAIR[0];
      ctx.beginPath();
      ctx.moveTo(0, cy);
      ctx.lineTo(f, cy);
      ctx.moveTo(cx, 0);
      ctx.lineTo(cx, f);
      ctx.stroke();
    }

    // 3) connector — traces the actual click path: each still-to-click layer to the next, then on
    //    to the ghost (the next selection's orange). Depth 2 in the orange phase is orange→blue→
    //    ghost; once orange is clicked it's just blue→ghost. So the line follows real cursor travel.
    if (cfg.ghost && ghost >= 0 && target >= 0) {
      const pts: Array<[number, number]> = [];
      for (let L = active; L < this.engine.depth; L++) {
        const c = this.engine.layerCell(L);
        if (c >= 0) pts.push([this.centerX(c), this.centerY(c)]);
      }
      pts.push([this.centerX(ghost), this.centerY(ghost)]);
      if (pts.length >= 2) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(107, 119, 137, 0.85)';
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.stroke();
      }
    }

    // 4) ghost border — empty cell, gray outline; always drawn (even adjacent to the target), so it
    //    never flickers on/off between selections. But NOT when the next target repeats the current
    //    cell (ghost === target): drawing a ghost box on the same cell as the orange fill is
    //    redundant and misreads as a stray second target — so skip it (the connector, a zero-length
    //    segment there, is already invisible).
    if (cfg.ghost && ghost >= 0 && ghost !== target) {
      const gx = this.col(ghost) * cp;
      const gy = this.row(ghost) * cp;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = GHOST_GRAY;
      ctx.strokeRect(gx + 1.5, gy + 1.5, cp - 3, cp - 3);
    }

    // 5) layer fills — every layer still to be clicked is drawn at once in its colour: the active
    //    layer (click now) plus any pending layers (e.g. the blue cell shown while you click orange).
    //    Already-clicked layers are hidden. The active fill is drawn last so it sits on top.
    for (let L = this.engine.depth - 1; L >= active; L--) {
      const cell = this.engine.layerCell(L);
      if (cell < 0) continue;
      const tx = this.col(cell) * cp;
      const ty = this.row(cell) * cp;
      ctx.fillStyle = LAYER_COLORS[L] ?? LAYER_COLORS[0];
      ctx.fillRect(tx + 0.5, ty + 0.5, cp - 1, cp - 1);
    }

    // 5b) repeated-target flash — the i.i.d. sequence can draw the same cell twice in a row (rate
    //     1/N). Then the orange cell doesn't move on a correct click, so the hit would look like a
    //     dead click; a brief white flash on the target makes the repeat legible. Only fires when the
    //     just-completed cell IS the new target (i.e. an actual repeat), so normal play is unchanged.
    const sinceCorrect = nowMs - this.engine.lastCorrectMs;
    if (target >= 0 && this.engine.lastCorrectCell === target && sinceCorrect >= 0 && sinceCorrect < REPEAT_FLASH_MS) {
      const tx = this.col(target) * cp;
      const ty = this.row(target) * cp;
      ctx.fillStyle = `rgba(255, 255, 255, ${(0.7 * (1 - sinceCorrect / REPEAT_FLASH_MS)).toFixed(3)})`;
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

    // 8) hit particles — spawn a burst at the just-completed cell on each correct click, then
    //    animate them on top of everything. Skipped under reduced-motion (the flash/sound remain).
    if (!this.reducedMotion) {
      if (this.engine.lastCorrectMs > this.lastBurstMs && this.engine.lastCorrectCell >= 0) {
        this.spawnBurst(this.engine.lastCorrectCell, nowMs);
        this.lastBurstMs = this.engine.lastCorrectMs;
      }
      this.drawParticles(nowMs);
    }
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
        color: i % 3 === 0 ? '#ffffff' : '#E69F00',
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

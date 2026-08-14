// The moving strip. A fixed pool of glyph nodes is recycled on a treadmill (each maps to
// a sequence position via p % poolSize, so exactly one node's textContent changes per
// advance); every frame we set transform (translate + scale) and opacity only — never a
// layout property, so motion stays on the compositor.
//
// With lanes on it is a piano roll: each key owns a horizontal row (divider lines drawn
// behind), glyphs ride their row, and the magnifier is a cell at centre-x that GLIDES
// vertically to the current target's row — so it always encloses the character you must
// hit. With lanes off it collapses to a single centred row with a large fisheye magnifier.

import type { Engine } from './engine.js';

const TAIL = 10; // consumed glyphs retained on the left
const SLACK = 3; // spare pooled nodes past the lookahead
const TARGET_SCALE_FLAT = 4.0; // magnified target when lanes are off
const TARGET_SCALE_LANES = 1.55; // gentler when lanes are on (it must fit its row)
const SIGMA_FLAT = 1.2; // fisheye falloff width (glyph units), lanes off
const SIGMA_LANES = 0.6; // tighter, so only the target grows and rows stay clean
const SETTLE_TAU_MS = 42; // horizontal strip-slide smoothing
const MAG_TAU_MS = 55; // magnifier vertical glide between lanes
const SHAKE_MS = 120;
const SHAKE_PX = 10;

export class StripRenderer {
  private readonly root: HTMLElement;
  private readonly layer: HTMLElement;
  private readonly mag: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly nodes: HTMLDivElement[] = [];
  private readonly inners: HTMLSpanElement[] = [];
  private readonly nodeSeq: number[] = [];
  private readonly poolSize: number;
  private readonly reducedMotion: boolean;

  private W = 56; // horizontal glyph advance
  private rowH = 34; // lane row height
  private font = 22;
  private progress = 0; // smoothed horizontal index
  private magY = 0; // smoothed magnifier lane position
  private lastFrameMs = -1;

  constructor(private readonly engine: Engine, root: HTMLElement) {
    this.root = root;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.poolSize = TAIL + engine.config.lookahead + SLACK + 1;

    this.grid = document.createElement('div');
    this.grid.className = 'lane-grid';
    root.appendChild(this.grid);

    this.mag = document.createElement('div');
    this.mag.className = 'magnifier';
    root.appendChild(this.mag);

    this.layer = document.createElement('div');
    this.layer.className = 'strip-layer';
    for (let k = 0; k < this.poolSize; k++) {
      const node = document.createElement('div');
      node.className = 'glyph';
      const inner = document.createElement('span');
      inner.className = 'glyph-inner';
      node.appendChild(inner);
      this.layer.appendChild(node);
      this.nodes.push(node);
      this.inners.push(inner);
      this.nodeSeq.push(-1);
    }
    root.appendChild(this.layer);
    this.progress = engine.index;
    this.magY = this.laneY(engine.target());
    this.resize();
  }

  resize(): void {
    const w = this.root.clientWidth || window.innerWidth;
    const h = this.root.clientHeight || 320;
    this.W = Math.max(34, Math.min(78, Math.round(w / 22)));
    const lanes = this.engine.config.lanes;
    if (lanes) {
      this.rowH = Math.min(this.W * 0.92, (h * 0.86) / this.engine.n);
      this.font = Math.max(13, Math.round(this.rowH * 0.6));
    } else {
      this.rowH = 0;
      this.font = Math.round(this.W * 0.62);
    }
    this.layer.style.setProperty('--glyph-font', `${this.font}px`);

    if (lanes) {
      this.grid.style.display = 'block';
      this.grid.style.height = `${(this.engine.n * this.rowH).toFixed(1)}px`;
      this.grid.style.setProperty('--row-h', `${this.rowH.toFixed(2)}px`);
      this.mag.classList.add('cell');
      this.mag.style.width = `${(this.W * 1.5).toFixed(0)}px`;
      this.mag.style.height = `${(this.rowH * 1.1).toFixed(1)}px`;
    } else {
      this.grid.style.display = 'none';
      this.mag.classList.remove('cell');
      this.mag.style.width = `${(this.font * 2.0).toFixed(0)}px`;
      this.mag.style.height = `${(h * 0.72).toFixed(0)}px`;
    }
  }

  private laneY(glyph: string): number {
    if (!this.engine.config.lanes) return 0;
    const i = this.engine.chars.indexOf(glyph);
    if (i < 0) return 0;
    return (i - (this.engine.n - 1) / 2) * this.rowH;
  }

  private handClass(glyph: string): string {
    if (!this.engine.config.lanes) return '';
    const i = this.engine.chars.indexOf(glyph);
    if (i < 0) return '';
    return 2 * i < this.engine.n ? ' left' : ' right';
  }

  render(nowMs: number): void {
    const dt = this.lastFrameMs < 0 ? 16 : Math.min(64, nowMs - this.lastFrameMs);
    this.lastFrameMs = nowMs;
    const lanes = this.engine.config.lanes;

    // horizontal slide toward the integer target index
    const kx = 1 - Math.exp(-dt / SETTLE_TAU_MS);
    this.progress += (this.engine.index - this.progress) * kx;
    if (Math.abs(this.engine.index - this.progress) < 1e-3) this.progress = this.engine.index;

    // magnifier glides vertically to the current target's lane (so it encloses it)
    const targetY = lanes ? this.laneY(this.engine.target()) : 0;
    const km = 1 - Math.exp(-dt / MAG_TAU_MS);
    this.magY += (targetY - this.magY) * km;
    this.mag.style.transform = `translate(-50%,-50%) translateY(${this.magY.toFixed(2)}px)`;

    const prog = this.progress;
    const seq = this.engine.sequence;
    const P = this.poolSize;
    const base = Math.max(0, Math.floor(prog) - TAIL);
    const lookahead = this.engine.config.lookahead;
    const sinceErr = nowMs - this.engine.lastErrorMs;
    const shakeActive = !this.reducedMotion && sinceErr < SHAKE_MS;
    const flashActive = sinceErr < SHAKE_MS;
    const targetScale = lanes ? TARGET_SCALE_LANES : TARGET_SCALE_FLAT;
    const sigma = lanes ? SIGMA_LANES : SIGMA_FLAT;

    for (let p = base; p < base + P; p++) {
      const nk = p % P;
      const node = this.nodes[nk];
      const glyph = p < seq.length ? seq[p] : '';
      if (this.nodeSeq[nk] !== p) {
        this.nodeSeq[nk] = p;
        this.inners[nk].textContent = glyph;
        node.className = 'glyph' + this.handClass(glyph);
      }
      const d = p - prog; // glyph units from centre
      const scale = 1 + (targetScale - 1) * Math.exp(-((d / sigma) ** 2));
      const span = d >= 0 ? lookahead + 1 : TAIL + 1;
      let o = 1 - Math.abs(d) / span;
      if (o < 0) o = 0;

      const isTarget = p === this.engine.index;
      let shakeX = 0;
      if (isTarget && shakeActive) {
        const t = sinceErr / SHAKE_MS;
        shakeX = Math.sin(t * Math.PI * 3) * SHAKE_PX * (1 - t);
      }
      const x = d * this.W + shakeX;
      const y = this.laneY(glyph);
      node.style.transform = `translate(-50%,-50%) translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0) scale(${scale.toFixed(3)})`;
      node.style.opacity = o.toFixed(3);
      node.style.zIndex = isTarget ? '3' : '1';
      node.classList.toggle('error', isTarget && flashActive);
      node.classList.toggle('current', isTarget);
    }
  }
}

// The moving strip. A fixed pool of glyph nodes is recycled on a treadmill (each maps to
// a sequence position via p % poolSize, so exactly one node's textContent changes per
// advance); every frame we set transform (translate + magnifier scale) and opacity only —
// never a layout property, so motion stays on the compositor. The magnifier is a fixed
// frame at centre; the strip slides beneath it via a smoothed `progress` toward the
// engine's integer index. Input never waits on any of this.

import type { Engine } from './engine.js';

const TAIL = 10; // consumed glyphs retained on the left
const SLACK = 3; // spare pooled nodes past the lookahead
const TARGET_SCALE = 4.0; // magnified target ≈ 4× a strip glyph
const FISHEYE_SIGMA = 1.2; // gaussian falloff width, in glyph units
const SETTLE_TAU_MS = 42; // strip-slide smoothing time constant
const SHAKE_MS = 120;
const SHAKE_PX = 10;

export class StripRenderer {
  private readonly root: HTMLElement;
  private readonly layer: HTMLElement;
  private readonly nodes: HTMLDivElement[] = [];
  private readonly inners: HTMLSpanElement[] = [];
  private readonly nodeSeq: number[] = [];
  private readonly poolSize: number;
  private readonly reducedMotion: boolean;

  private W = 56;
  private laneSpacing = 22;
  private progress = 0;
  private lastFrameMs = -1;

  constructor(private readonly engine: Engine, root: HTMLElement) {
    this.root = root;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.poolSize = TAIL + engine.config.lookahead + SLACK + 1;

    const mag = document.createElement('div');
    mag.className = 'magnifier';
    root.appendChild(mag);

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
    this.resize();
  }

  resize(): void {
    const w = this.root.clientWidth || window.innerWidth;
    this.W = Math.max(34, Math.min(78, Math.round(w / 22)));
    this.laneSpacing = Math.round(this.W * 0.44);
    this.layer.style.setProperty('--glyph-font', `${Math.round(this.W * 0.62)}px`);
  }

  private laneY(glyph: string): number {
    if (!this.engine.config.lanes) return 0;
    const i = this.engine.chars.indexOf(glyph);
    if (i < 0) return 0;
    return (i - (this.engine.n - 1) / 2) * this.laneSpacing;
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

    // exponential smoothing of the slide toward the integer target index
    const k = 1 - Math.exp(-dt / SETTLE_TAU_MS);
    this.progress += (this.engine.index - this.progress) * k;
    if (Math.abs(this.engine.index - this.progress) < 1e-3) this.progress = this.engine.index;

    const prog = this.progress;
    const seq = this.engine.sequence;
    const P = this.poolSize;
    const base = Math.max(0, Math.floor(prog) - TAIL);
    const lookahead = this.engine.config.lookahead;
    const sinceErr = nowMs - this.engine.lastErrorMs;
    const shakeActive = !this.reducedMotion && sinceErr < SHAKE_MS;
    const flashActive = sinceErr < SHAKE_MS;

    for (let p = base; p < base + P; p++) {
      const nk = p % P;
      const node = this.nodes[nk];
      if (this.nodeSeq[nk] !== p) {
        this.nodeSeq[nk] = p;
        const glyph = p < seq.length ? seq[p] : '';
        this.inners[nk].textContent = glyph;
        node.className = 'glyph' + this.handClass(glyph);
      }
      const d = p - prog; // glyph units from the magnifier centre
      const scale = 1 + (TARGET_SCALE - 1) * Math.exp(-((d / FISHEYE_SIGMA) ** 2));
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
      const y = this.laneY(p < seq.length ? seq[p] : '');
      node.style.transform = `translate(-50%,-50%) translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0) scale(${scale.toFixed(3)})`;
      node.style.opacity = o.toFixed(3);
      node.style.zIndex = isTarget ? '3' : '1';
      node.classList.toggle('error', isTarget && flashActive);
    }
  }
}

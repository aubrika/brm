// The moving strip. A fixed pool of glyph nodes is recycled on a treadmill (each maps to
// a sequence position via p % poolSize); every frame we set transform (translate + scale)
// and opacity only — never a layout property, so motion stays on the compositor.
//
// Two layouts share this code via a cumulative-x model (glyph p sits at cx(p) pixels, and
// the strip slides so the target's cx is at centre):
//   • chunked row (default): a single line, letters grouped in fours with a gap between
//     groups (easier to pre-read in chunks); the magnifier is a fixed centre cell.
//   • piano-roll lanes: each key owns a horizontal row (divider lines behind), and the
//     magnifier glides vertically to the target's row.
// Hand colour (teal = left, amber = right) applies to both.

import type { Engine } from './engine.js';

const TAIL = 10; // consumed glyphs retained on the left
const SLACK = 3; // spare pooled nodes past the lookahead
const CHUNK = 4; // group size for the chunked row
const TARGET_SCALE_ROW = 1.7; // magnified target in the chunked row
const TARGET_SCALE_LANES = 1.55; // gentler in lanes (must fit its row)
const SIGMA_ROW = 0.85; // fisheye falloff width (glyph units), chunked row
const SIGMA_LANES = 0.6; // tighter for lanes so rows stay clean
const SETTLE_TAU_MS = 22; // horizontal slide smoothing — snappy, keeps up with fast typing
const MAG_TAU_MS = 26; // magnifier vertical glide (lanes only)
const MAX_LAG = 0.45; // cap target drift right of centre during bursts (keeps it in the cell)
const PULSE_MS = 110; // correct-keystroke magnifier pulse
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
  private rowH = 34; // lane row height (lanes mode)
  private font = 22;
  private gapW = 0; // extra gap between chunks (chunked row)
  private cpX = 0; // smoothed cumulative-x of the target (pixels)
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
    this.mag.className = 'magnifier cell';
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
    this.resize();
    this.cpX = this.cx(engine.index);
    this.magY = this.laneY(engine.target());
  }

  resize(): void {
    const w = this.root.clientWidth || window.innerWidth;
    const h = this.root.clientHeight || 320;
    this.W = Math.max(34, Math.min(78, Math.round(w / 22)));
    const lanes = this.engine.config.lanes;
    if (lanes) {
      this.rowH = Math.min(this.W * 0.92, (h * 0.86) / this.engine.n);
      this.font = Math.max(13, Math.round(this.rowH * 0.64));
      this.gapW = 0;
      this.grid.style.display = 'block';
      this.grid.style.height = `${(this.engine.n * this.rowH).toFixed(1)}px`;
      this.grid.style.setProperty('--row-h', `${this.rowH.toFixed(2)}px`);
      this.grid.style.setProperty('--col-w', `${(CHUNK * this.W).toFixed(2)}px`);
      this.mag.style.width = `${(this.W * 1.5).toFixed(0)}px`;
      this.mag.style.height = `${(this.rowH * 1.1).toFixed(1)}px`;
    } else {
      this.rowH = 0;
      this.font = Math.round(this.W * 0.62);
      this.gapW = Math.round(this.W * 0.7);
      this.grid.style.display = 'none';
      this.mag.style.width = `${(this.W * 1.55).toFixed(0)}px`;
      this.mag.style.height = `${(this.font * 1.9).toFixed(0)}px`;
    }
    this.layer.style.setProperty('--glyph-font', `${this.font}px`);
  }

  // cumulative pixel x of sequence position p (adds a gap after every CHUNK in row mode)
  private cx(p: number): number {
    const gaps = this.gapW > 0 ? Math.floor(p / CHUNK) : 0;
    return p * this.W + gaps * this.gapW;
  }

  private laneY(glyph: string): number {
    if (!this.engine.config.lanes) return 0;
    const i = this.engine.chars.indexOf(glyph);
    if (i < 0) return 0;
    return (i - (this.engine.n - 1) / 2) * this.rowH;
  }

  private handClass(glyph: string): string {
    const i = this.engine.chars.indexOf(glyph);
    if (i < 0) return '';
    return 2 * i < this.engine.n ? ' left' : ' right';
  }

  render(nowMs: number): void {
    const dt = this.lastFrameMs < 0 ? 16 : Math.min(64, nowMs - this.lastFrameMs);
    this.lastFrameMs = nowMs;
    const lanes = this.engine.config.lanes;

    // horizontal slide (cumulative pixels) toward the target; clamp lag so during a fast
    // burst the target stays inside the magnifier rather than drifting right of it
    const targetCx = this.cx(this.engine.index);
    const kx = 1 - Math.exp(-dt / SETTLE_TAU_MS);
    this.cpX += (targetCx - this.cpX) * kx;
    const maxLagPx = MAX_LAG * this.W;
    if (targetCx - this.cpX > maxLagPx) this.cpX = targetCx - maxLagPx;
    if (Math.abs(targetCx - this.cpX) < 0.5) this.cpX = targetCx;

    // magnifier: vertical glide to the target lane (lanes only), plus a correct-keystroke
    // pulse — rhythmic feedback that invites tempo
    const targetY = lanes ? this.laneY(this.engine.target()) : 0;
    this.magY += (targetY - this.magY) * (1 - Math.exp(-dt / MAG_TAU_MS));

    // scroll the vertical chunk dividers with the strip (a line before every 4th column)
    if (lanes) {
      const colW = CHUNK * this.W;
      const center = (this.root.clientWidth || window.innerWidth) / 2;
      const vx = (center - 0.5 * this.W - this.cpX) % colW;
      this.grid.style.setProperty('--vx', `${vx.toFixed(2)}px`);
    }

    const sinceCorrect = nowMs - this.engine.lastCorrectMs;
    const pulse = sinceCorrect < PULSE_MS ? 1 + 0.07 * (1 - sinceCorrect / PULSE_MS) : 1;
    this.mag.style.transform = `translate(-50%,-50%) translateY(${this.magY.toFixed(2)}px) scale(${pulse.toFixed(3)})`;

    const seq = this.engine.sequence;
    const P = this.poolSize;
    const idx = this.engine.index;
    const base = Math.max(0, idx - TAIL);
    const lookahead = this.engine.config.lookahead;
    const sinceErr = nowMs - this.engine.lastErrorMs;
    const shakeActive = !this.reducedMotion && sinceErr < SHAKE_MS;
    const flashActive = sinceErr < SHAKE_MS;
    const targetScale = lanes ? TARGET_SCALE_LANES : TARGET_SCALE_ROW;
    const sigma = lanes ? SIGMA_LANES : SIGMA_ROW;

    for (let p = base; p < base + P; p++) {
      const nk = p % P;
      const node = this.nodes[nk];
      const glyph = p < seq.length ? seq[p] : '';
      if (this.nodeSeq[nk] !== p) {
        this.nodeSeq[nk] = p;
        this.inners[nk].textContent = glyph;
        node.className = 'glyph' + this.handClass(glyph);
      }
      const screenX = this.cx(p) - this.cpX; // pixels from centre
      const d = screenX / this.W; // glyph units, for the fisheye
      const scale = 1 + (targetScale - 1) * Math.exp(-((d / sigma) ** 2));
      const gi = p - idx; // logical glyphs ahead(+)/behind(−), for a clean opacity fade
      const span = gi >= 0 ? lookahead + 2 : TAIL + 1;
      let o = 1 - Math.abs(gi) / span;
      if (o < 0) o = 0;

      const isTarget = p === idx;
      let shakeX = 0;
      if (isTarget && shakeActive) {
        const t = sinceErr / SHAKE_MS;
        shakeX = Math.sin(t * Math.PI * 3) * SHAKE_PX * (1 - t);
      }
      const y = this.laneY(glyph);
      node.style.transform = `translate(-50%,-50%) translate3d(${(screenX + shakeX).toFixed(2)}px,${y.toFixed(2)}px,0) scale(${scale.toFixed(3)})`;
      node.style.opacity = o.toFixed(3);
      node.style.zIndex = isTarget ? '3' : '1';
      node.classList.toggle('error', isTarget && flashActive);
      node.classList.toggle('current', isTarget);
    }
  }
}

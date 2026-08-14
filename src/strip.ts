// The moving strip. A fixed pool of glyph nodes is recycled on a treadmill (each maps to
// a sequence position via p % poolSize); every frame we set transform (translate + scale)
// and opacity only — never a layout property, so motion stays on the compositor.
//
// Two layouts share a cumulative-flow model (glyph p sits `flow` px along the flow axis,
// and the strip slides so the target sits at the target zone):
//   • DDR lanes (default): each key owns a VERTICAL column ordered left→right by finger
//     (a = left pinky … ; = right pinky); glyphs fall downward to a hit-line near the
//     bottom, with static receptors (the target's lights up) and horizontal divider lines
//     every four rows to chunk the stream.
//   • chunked row: a single horizontal line, letters grouped in fours with a gap, a fixed
//     centre magnifier.
// Hand colour (teal = left, amber = right) applies to both.

import type { Engine } from './engine.js';

const TAIL = 10; // consumed glyphs retained behind the target
const SLACK = 3; // spare pooled nodes past the lookahead
const CHUNK = 4; // group size
const HIT_FRAC = 0.8; // hit-line position (fraction down the strip) in DDR lanes
const TARGET_SCALE_LANES = 1.5;
const TARGET_SCALE_ROW = 1.7;
const SIGMA_LANES = 0.8; // fisheye falloff (rows from the hit-line)
const SIGMA_ROW = 0.85; // fisheye falloff (glyph units from centre)
const SETTLE_TAU_MS = 22; // flow smoothing — snappy, keeps up with fast typing
const MAX_LAG = 0.45; // cap drift of the target past the target zone during bursts
const PULSE_MS = 110; // correct-keystroke pulse
const SHAKE_MS = 120;
const SHAKE_PX = 10;

export class StripRenderer {
  private readonly root: HTMLElement;
  private readonly layer: HTMLElement;
  private readonly mag: HTMLElement; // chunked-row magnifier
  private readonly grid: HTMLElement;
  private readonly receptors: HTMLElement[] = [];
  private readonly nodes: HTMLDivElement[] = [];
  private readonly inners: HTMLSpanElement[] = [];
  private readonly nodeSeq: number[] = [];
  private readonly poolSize: number;
  private readonly reducedMotion: boolean;
  private readonly laneColor: string[] = []; // per-column hue, blue (left) → yellow (right)
  private readonly laneGlow: string[] = [];

  private W = 56; // horizontal glyph advance (chunked row)
  private colStep = 54; // column spacing (DDR lanes)
  private rowStep = 34; // vertical advance per glyph (DDR lanes)
  private font = 22;
  private gapW = 0; // chunk gap (chunked row)
  private hitOffset = 0; // hit-line offset from strip centre (px, +down)
  private flow = 0; // smoothed cumulative flow position of the target (px)
  private lastFrameMs = -1;

  constructor(private readonly engine: Engine, root: HTMLElement) {
    this.root = root;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.poolSize = TAIL + engine.config.lookahead + SLACK + 1;

    // one hue per column, swept blue→cyan→green→yellow across the fingers
    for (let i = 0; i < engine.n; i++) {
      const t = engine.n > 1 ? i / (engine.n - 1) : 0;
      const hue = (215 - 163 * t).toFixed(1);
      this.laneColor.push(`hsl(${hue}, 70%, 63%)`);
      this.laneGlow.push(`hsla(${hue}, 70%, 63%, 0.16)`);
    }

    this.grid = document.createElement('div');
    this.grid.className = 'lane-grid';
    root.appendChild(this.grid);

    for (let i = 0; i < engine.n; i++) {
      const r = document.createElement('div');
      r.className = 'receptor';
      root.appendChild(r);
      this.receptors.push(r);
    }

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
    this.flow = this.flowPos(engine.index);
  }

  resize(): void {
    const w = this.root.clientWidth || window.innerWidth;
    const h = this.root.clientHeight || 360;
    const lanes = this.engine.config.lanes;
    const n = this.engine.n;
    const lookahead = this.engine.config.lookahead;

    if (lanes) {
      this.colStep = Math.max(40, Math.min(128, Math.round(w / (n + 2))));
      const hitY = h * HIT_FRAC;
      this.hitOffset = hitY - h / 2;
      this.rowStep = Math.max(24, Math.min(this.colStep * 0.95, (hitY - 6) / (lookahead + 1)));
      this.font = Math.max(14, Math.round(Math.min(this.colStep, this.rowStep * 1.3) * 0.62));
      const gridW = n * this.colStep;

      this.grid.style.display = 'block';
      this.grid.style.setProperty('--grid-w', `${gridW.toFixed(1)}px`);
      this.grid.style.setProperty('--col-step', `${this.colStep.toFixed(2)}px`);
      this.grid.style.setProperty('--chunk-h', `${(CHUNK * this.rowStep).toFixed(2)}px`);

      const cx = w / 2, cy = h / 2;
      for (let i = 0; i < this.receptors.length; i++) {
        const r = this.receptors[i];
        r.style.display = 'block';
        r.style.width = `${(this.colStep * 0.82).toFixed(0)}px`;
        r.style.height = `${(this.rowStep * 1.15).toFixed(0)}px`;
        r.style.left = `${(cx + (i - (n - 1) / 2) * this.colStep).toFixed(1)}px`;
        r.style.top = `${(cy + this.hitOffset).toFixed(1)}px`;
        r.style.setProperty('--rc', this.laneColor[i]);
        r.style.setProperty('--rcbg', this.laneGlow[i]);
      }
      this.mag.style.display = 'none';
    } else {
      this.W = Math.max(34, Math.min(78, Math.round(w / 22)));
      this.font = Math.round(this.W * 0.62);
      this.gapW = Math.round(this.W * 0.7);
      this.grid.style.display = 'none';
      for (const r of this.receptors) r.style.display = 'none';
      this.mag.style.display = 'block';
      this.mag.style.width = `${(this.W * 1.55).toFixed(0)}px`;
      this.mag.style.height = `${(this.font * 1.9).toFixed(0)}px`;
    }
    this.layer.style.setProperty('--glyph-font', `${this.font}px`);
  }

  // cumulative flow position (px) of sequence position p
  private flowPos(p: number): number {
    if (this.engine.config.lanes) return p * this.rowStep;
    const gaps = this.gapW > 0 ? Math.floor(p / CHUNK) : 0;
    return p * this.W + gaps * this.gapW;
  }

  private laneX(glyph: string): number {
    const i = this.engine.chars.indexOf(glyph);
    if (i < 0) return 0;
    return (i - (this.engine.n - 1) / 2) * this.colStep;
  }

  render(nowMs: number): void {
    const dt = this.lastFrameMs < 0 ? 16 : Math.min(64, nowMs - this.lastFrameMs);
    this.lastFrameMs = nowMs;
    const lanes = this.engine.config.lanes;
    const idx = this.engine.index;
    const step = lanes ? this.rowStep : this.W;

    // flow toward the target; clamp lag so during a burst the target stays in the zone
    const targetFlow = this.flowPos(idx);
    this.flow += (targetFlow - this.flow) * (1 - Math.exp(-dt / SETTLE_TAU_MS));
    if (targetFlow - this.flow > MAX_LAG * step) this.flow = targetFlow - MAX_LAG * step;
    if (Math.abs(targetFlow - this.flow) < 0.5) this.flow = targetFlow;

    const sinceCorrect = nowMs - this.engine.lastCorrectMs;
    const pulse = sinceCorrect < PULSE_MS ? 1 + 0.07 * (1 - sinceCorrect / PULSE_MS) : 1;

    if (lanes) {
      // chunk dividers scroll down with the flow
      const chunkH = CHUNK * this.rowStep;
      const hitY = this.root.clientHeight / 2 + this.hitOffset;
      const vy = (hitY + this.flow + 0.5 * this.rowStep) % chunkH;
      this.grid.style.setProperty('--vy', `${vy.toFixed(2)}px`);
      // light up + pulse the target's receptor; the rest stay dim
      const col = this.engine.chars.indexOf(this.engine.target());
      for (let i = 0; i < this.receptors.length; i++) {
        const active = i === col;
        this.receptors[i].classList.toggle('active', active);
        this.receptors[i].style.transform = `translate(-50%,-50%) scale(${active ? pulse.toFixed(3) : '1'})`;
      }
    } else {
      // chunked-row magnifier holds at centre and pulses on correct
      this.mag.style.transform = `translate(-50%,-50%) scale(${pulse.toFixed(3)})`;
    }

    const seq = this.engine.sequence;
    const P = this.poolSize;
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
        node.className = 'glyph';
        const ci = this.engine.chars.indexOf(glyph);
        node.style.setProperty('--gc', ci >= 0 ? this.laneColor[ci] : 'var(--ink)');
      }
      const along = this.flowPos(p) - this.flow; // px from the target zone along the flow
      const d = along / step; // in glyph/row units, for the fisheye
      const scale = 1 + (targetScale - 1) * Math.exp(-((d / sigma) ** 2));
      const gi = p - idx; // logical glyphs ahead(+)/behind(−), for a clean opacity fade
      const span = gi >= 0 ? lookahead + 2 : TAIL + 1;
      let o = 1 - Math.abs(gi) / span;
      if (o < 0) o = 0;

      const isTarget = p === idx;
      let shake = 0;
      if (isTarget && shakeActive) {
        const t = sinceErr / SHAKE_MS;
        shake = Math.sin(t * Math.PI * 3) * SHAKE_PX * (1 - t);
      }
      let x: number, y: number;
      if (lanes) {
        x = this.laneX(glyph) + shake;
        y = this.hitOffset - along; // fall downward toward the hit-line
      } else {
        x = along + shake;
        y = 0;
      }
      node.style.transform = `translate(-50%,-50%) translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0) scale(${scale.toFixed(3)})`;
      node.style.opacity = o.toFixed(3);
      node.style.zIndex = isTarget ? '3' : '1';
      node.classList.toggle('error', isTarget && flashActive);
      node.classList.toggle('current', isTarget);
    }
  }
}

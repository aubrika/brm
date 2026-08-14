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
import type { FingerMapping } from './config.js';

const TAIL = 10; // consumed glyphs retained behind the target
const SLACK = 3; // spare pooled nodes past the lookahead
const CHUNK = 4; // group size
const GAP = 0.5; // centre-gap width in lane-widths (1 = a full empty lane, 0 = none)
const LINK_ARROWS = false; // true = per-digraph arrows coloured by the target's hand; false = one plain polyline
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
  private readonly gridL: HTMLElement; // left-hand lane grid (dividers + chunk lines)
  private readonly gridR: HTMLElement; // right-hand lane grid; the gap between them stays empty
  private readonly svg: SVGSVGElement; // links between consecutive glyphs (lanes)
  private readonly poly: SVGPolylineElement; // plain single-line variant (LINK_ARROWS = false)
  private readonly arrows: SVGPathElement[] = []; // one per upcoming digraph (LINK_ARROWS = true)
  private readonly bands: HTMLElement[] = []; // per-column hand-tinted background wash
  private readonly receptors: HTMLElement[] = [];
  private readonly nodes: HTMLDivElement[] = [];
  private readonly inners: HTMLSpanElement[] = [];
  private readonly nodeSeq: number[] = [];
  // peripheral copies of the falling sequence, pinned to the far left/right edges — a
  // test of whether seeing the upcoming letters in the periphery aids lookahead.
  private readonly edgeL: HTMLDivElement[] = [];
  private readonly edgeLInner: HTMLSpanElement[] = [];
  private readonly edgeR: HTMLDivElement[] = [];
  private readonly edgeRInner: HTMLSpanElement[] = [];
  private edgeX = 0; // px offset from centre for the peripheral columns
  private readonly split: number; // left-hand key count; the gap sits between the hands
  private readonly collapse: boolean; // fold the hands onto shared finger-columns
  private readonly mapping: FingerMapping; // which fold (collapse only)
  private readonly nCols: number; // visual columns: collapse → max(left,right), else n
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
    this.split = Math.floor(engine.n / 2); // gap sits between the hands (integer split for odd N)
    this.collapse = engine.config.collapse;
    this.mapping = engine.config.mapping;
    this.nCols = this.collapse ? Math.max(this.split, engine.n - this.split) : engine.n;

    // left hand blue, right hand yellow (split matches the centre gap)
    for (let i = 0; i < engine.n; i++) {
      const left = i < this.split;
      this.laneColor.push(left ? 'hsl(214, 82%, 67%)' : 'hsl(48, 85%, 60%)');
      this.laneGlow.push(left ? 'hsla(214, 82%, 67%, 0.16)' : 'hsla(48, 85%, 60%, 0.16)');
    }

    for (let i = 0; i < engine.n; i++) {
      const b = document.createElement('div');
      b.className = 'lane-band';
      root.appendChild(b);
      this.bands.push(b);
    }

    this.gridL = document.createElement('div');
    this.gridL.className = 'lane-grid';
    root.appendChild(this.gridL);
    this.gridR = document.createElement('div');
    this.gridR.className = 'lane-grid';
    root.appendChild(this.gridR);

    const NS = 'http://www.w3.org/2000/svg';
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('class', 'link-layer');
    this.poly = document.createElementNS(NS, 'polyline');
    this.svg.appendChild(this.poly);
    for (let k = 0; k < this.poolSize; k++) {
      const ap = document.createElementNS(NS, 'path');
      ap.setAttribute('class', 'link-arrow');
      this.svg.appendChild(ap);
      this.arrows.push(ap);
    }
    root.appendChild(this.svg);

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
      const [node, inner] = this.mkGlyph('glyph');
      this.nodes.push(node);
      this.inners.push(inner);
      this.nodeSeq.push(-1);
      const [ln, li] = this.mkGlyph('glyph edge');
      const [rn, ri] = this.mkGlyph('glyph edge');
      this.edgeL.push(ln);
      this.edgeLInner.push(li);
      this.edgeR.push(rn);
      this.edgeRInner.push(ri);
    }
    root.appendChild(this.layer);
    this.resize();
    this.flow = this.flowPos(engine.index);
  }

  private mkGlyph(cls: string): [HTMLDivElement, HTMLSpanElement] {
    const node = document.createElement('div');
    node.className = cls;
    const inner = document.createElement('span');
    inner.className = 'glyph-inner';
    node.appendChild(inner);
    this.layer.appendChild(node);
    return [node, inner];
  }

  resize(): void {
    const w = this.root.clientWidth || window.innerWidth;
    const h = this.root.clientHeight || 360;
    const lanes = this.engine.config.lanes;
    const lookahead = this.engine.config.lookahead;

    if (lanes) {
      // total visual width in lane-widths: collapsed → nCols; else n + centre gap. Spans the
      // centre ~80%; the outer margin holds the peripheral sequence columns.
      const total = this.collapse ? this.nCols : this.engine.n + GAP;
      this.colStep = Math.max(36, Math.min(200, Math.round((w * 0.8) / total)));
      const hitY = h * HIT_FRAC;
      this.hitOffset = hitY - h / 2;
      this.rowStep = Math.max(24, Math.min(this.colStep * 0.95, (hitY - 6) / (lookahead + 1)));
      this.font = Math.max(14, Math.round(Math.min(this.colStep, this.rowStep * 1.3) * 0.62));
      const cx = w / 2, cy = h / 2;
      const halfW = (total / 2) * this.colStep;
      const chunkH = `${(CHUNK * this.rowStep).toFixed(2)}px`;
      const colStepPx = `${this.colStep.toFixed(2)}px`;

      if (this.collapse) {
        // one contiguous block of nCols finger-columns, no gap
        const gw = this.nCols * this.colStep;
        this.gridL.style.display = 'block';
        this.gridL.style.left = `${(cx - gw / 2).toFixed(1)}px`;
        this.gridL.style.width = `${gw.toFixed(1)}px`;
        this.gridL.style.setProperty('--col-step', colStepPx);
        this.gridL.style.setProperty('--chunk-h', chunkH);
        this.gridR.style.display = 'none';
      } else {
        // two lane blocks with the gap between them; each block's chunk lines stop at its
        // edges, so no divider crosses the gap and the gap is exactly GAP·colStep.
        const leftLeft = cx - halfW;
        const rightLeft = leftLeft + (this.split + GAP) * this.colStep;
        const blocks: Array<[HTMLElement, number, number]> = [
          [this.gridL, leftLeft, this.split * this.colStep],
          [this.gridR, rightLeft, (this.engine.n - this.split) * this.colStep],
        ];
        for (const [g, gx, gw] of blocks) {
          g.style.display = 'block';
          g.style.left = `${gx.toFixed(1)}px`;
          g.style.width = `${gw.toFixed(1)}px`;
          g.style.setProperty('--col-step', colStepPx);
          g.style.setProperty('--chunk-h', chunkH);
        }
      }
      this.svg.style.display = 'block';

      // hand-tinted column washes only make sense when a column belongs to one hand; when the
      // hands share columns (collapse), the glyph colour carries the hand instead.
      if (this.collapse) {
        for (const b of this.bands) b.style.display = 'none';
      } else {
        for (let i = 0; i < this.bands.length; i++) {
          const b = this.bands[i];
          b.style.display = 'block';
          b.style.left = `${(cx + this.laneCentreX(i)).toFixed(1)}px`;
          b.style.width = `${this.colStep.toFixed(1)}px`;
          const left = i < this.split;
          const a = (i % 2 === 0 ? 1 : 0.4) * (left ? 0.08 : 0.058); // alternate intensity; balance blue vs (brighter) yellow
          b.style.background = left ? `hsla(214, 80%, 60%, ${a.toFixed(3)})` : `hsla(48, 85%, 55%, ${a.toFixed(3)})`;
        }
      }
      for (let i = 0; i < this.receptors.length; i++) {
        const r = this.receptors[i];
        r.style.display = 'block';
        r.style.width = `${(this.colStep * 0.82).toFixed(0)}px`;
        r.style.height = `${(this.rowStep * 1.15).toFixed(0)}px`;
        r.style.left = `${(cx + this.laneCentreX(i)).toFixed(1)}px`;
        r.style.top = `${(cy + this.hitOffset).toFixed(1)}px`;
        r.style.setProperty('--rc', this.laneColor[i]);
        r.style.setProperty('--rcbg', this.laneGlow[i]);
      }
      // peripheral columns sit just outside the lanes, clamped inside the container
      this.edgeX = Math.min(w / 2 - this.font * 0.72, halfW + this.font);
      for (let i = 0; i < this.edgeL.length; i++) {
        this.edgeL[i].style.display = 'block';
        this.edgeR[i].style.display = 'block';
      }
      this.mag.style.display = 'none';
    } else {
      this.W = Math.max(34, Math.min(78, Math.round(w / 22)));
      this.font = Math.round(this.W * 0.62);
      this.gapW = Math.round(this.W * 0.7);
      this.gridL.style.display = 'none';
      this.gridR.style.display = 'none';
      this.svg.style.display = 'none';
      for (const b of this.bands) b.style.display = 'none';
      for (const r of this.receptors) r.style.display = 'none';
      for (let i = 0; i < this.edgeL.length; i++) {
        this.edgeL[i].style.display = 'none';
        this.edgeR[i].style.display = 'none';
      }
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

  // character index → x offset (px) of its lane centre from the strip centre. The right hand
  // is pushed right by GAP lane-widths, leaving an empty centre gap; the whole set stays centred.
  private laneUnit(i: number): number {
    const shift = i < this.split ? 0 : GAP;
    return i + shift + 0.5 - (this.engine.n + GAP) / 2;
  }
  // When collapsed, both hands share finger-columns (hand shown by colour): 'leftmost'
  // overlays the hands preserving screen order; 'digit' pairs the same finger.
  private colOf(i: number): number {
    const left = i < this.split;
    if (this.mapping === 'digit') {
      const distOuter = left ? i : this.engine.n - 1 - i;
      return Math.min(distOuter, this.nCols - 1);
    }
    return left ? i : i - this.split;
  }
  private laneCentreX(i: number): number {
    if (this.collapse) return (this.colOf(i) - (this.nCols - 1) / 2) * this.colStep;
    return this.laneUnit(i) * this.colStep;
  }

  private laneX(glyph: string): number {
    const i = this.engine.chars.indexOf(glyph);
    if (i < 0) return 0;
    return this.laneCentreX(i);
  }

  // SVG path for an arrow from the border of an invisible box around the origin glyph to the
  // border of the box around the target glyph, with a small arrowhead at the target end.
  // Boxes scale with each glyph's fisheye. Returns null if the glyphs overlap (no room).
  private arrowD(c0x: number, c0y: number, s0: number, c1x: number, c1y: number, s1: number): string | null {
    const dx = c1x - c0x, dy = c1y - c0y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return null;
    const ux = dx / len, uy = dy / len;
    const hx = this.font * 0.52, hy = this.font * 0.6; // half-extents of the invisible box
    const exit = (s: number): number =>
      Math.min(ux !== 0 ? (hx * s) / Math.abs(ux) : Infinity, uy !== 0 ? (hy * s) / Math.abs(uy) : Infinity);
    const t0 = exit(s0), t1 = exit(s1);
    if (t0 + t1 >= len - 2) return null;
    const sx = c0x + ux * t0, sy = c0y + uy * t0;
    const ex = c1x - ux * t1, ey = c1y - uy * t1;
    const ah = Math.min(8, (len - t0 - t1) * 0.5); // arrowhead length
    const ca = Math.cos(0.42), sa = Math.sin(0.42);
    const b1x = ex + (-ux * ca + uy * sa) * ah, b1y = ey + (-ux * sa - uy * ca) * ah;
    const b2x = ex + (-ux * ca - uy * sa) * ah, b2y = ey + (ux * sa - uy * ca) * ah;
    const r = (n: number): string => n.toFixed(1);
    return `M${r(sx)} ${r(sy)}L${r(ex)} ${r(ey)}L${r(b1x)} ${r(b1y)}M${r(ex)} ${r(ey)}L${r(b2x)} ${r(b2y)}`;
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
      this.gridL.style.setProperty('--vy', `${vy.toFixed(2)}px`);
      this.gridR.style.setProperty('--vy', `${vy.toFixed(2)}px`);
      // show ONLY the target's receptor (a box around the current character), and pulse it
      const col = this.engine.chars.indexOf(this.engine.target());
      for (let i = 0; i < this.receptors.length; i++) {
        const active = i === col;
        this.receptors[i].style.display = active ? 'block' : 'none';
        this.receptors[i].classList.toggle('active', active);
        if (active) this.receptors[i].style.transform = `translate(-50%,-50%) scale(${pulse.toFixed(3)})`;
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
    const fb = this.engine.config.errorFeedback; // 'none' | 'flash' | 'shake' | 'flash+shake'
    const recentErr = sinceErr < SHAKE_MS;
    const shakeActive = recentErr && !this.reducedMotion && fb.includes('shake');
    const flashActive = recentErr && fb.includes('flash');
    const targetScale = lanes ? TARGET_SCALE_LANES : TARGET_SCALE_ROW;
    const sigma = lanes ? SIGMA_LANES : SIGMA_ROW;
    const cw = this.root.clientWidth, ch = this.root.clientHeight;
    const pts: string[] = []; // link path through the upcoming glyphs (LINK_ARROWS = false)
    // per-glyph centres/scale/hand, captured for the per-digraph arrows (LINK_ARROWS = true)
    const cX = new Array<number>(P), cY = new Array<number>(P), cCi = new Array<number>(P), cScl = new Array<number>(P);
    const cVis = new Array<boolean>(P);

    for (let p = base; p < base + P; p++) {
      const nk = p % P;
      const node = this.nodes[nk];
      const glyph = p < seq.length ? seq[p] : '';
      if (this.nodeSeq[nk] !== p) {
        this.nodeSeq[nk] = p;
        this.inners[nk].textContent = glyph;
        node.className = 'glyph';
        const ci = this.engine.chars.indexOf(glyph);
        const gc = ci >= 0 ? this.laneColor[ci] : 'var(--ink)';
        node.style.setProperty('--gc', gc);
        this.edgeLInner[nk].textContent = glyph;
        this.edgeRInner[nk].textContent = glyph;
        this.edgeL[nk].className = 'glyph edge';
        this.edgeR[nk].className = 'glyph edge';
        this.edgeL[nk].style.setProperty('--gc', gc);
        this.edgeR[nk].style.setProperty('--gc', gc);
      }
      const along = this.flowPos(p) - this.flow; // px from the target zone along the flow
      const d = along / step; // in glyph/row units, for the fisheye
      const scale = 1 + (targetScale - 1) * Math.exp(-((d / sigma) ** 2));
      const gi = p - idx; // logical glyphs ahead(+)/behind(−), for a clean opacity fade
      const span = gi >= 0 ? lookahead + 2 : TAIL + 1;
      let o = 1 - Math.abs(gi) / span;
      if (o < 0) o = 0;
      if (gi < 0) o = 0; // don't render already-selected letters beneath the target

      const isTarget = p === idx;
      let shake = 0;
      if (isTarget && shakeActive) {
        const t = sinceErr / SHAKE_MS;
        shake = Math.sin(t * Math.PI * 3) * SHAKE_PX * (1 - t);
      }
      let x: number, y: number;
      if (lanes) {
        const lx = this.laneX(glyph);
        y = this.hitOffset - along; // fall downward toward the type line
        x = lx + shake;
        const rel = p - base;
        cX[rel] = cw / 2 + lx;
        cY[rel] = ch / 2 + y;
        cCi[rel] = this.engine.chars.indexOf(glyph);
        cScl[rel] = scale;
        cVis[rel] = glyph !== '' && gi >= 0; // only upcoming glyphs are linked
        if (!LINK_ARROWS && p >= idx && glyph) pts.push(`${(cw / 2 + lx).toFixed(1)},${(ch / 2 + y).toFixed(1)}`);
      } else {
        x = along + shake;
        y = 0;
      }
      node.style.transform = `translate(-50%,-50%) translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0) scale(${scale.toFixed(3)})`;
      node.style.opacity = o.toFixed(3);
      node.style.zIndex = isTarget ? '3' : '1';
      node.classList.toggle('error', isTarget && flashActive);
      node.classList.toggle('current', isTarget);

      if (lanes) {
        // peripheral copies fall at the same height in fixed edge columns (same fisheye,
        // so the current target enlarges in the periphery too)
        const eo = (o * 0.9).toFixed(3);
        const es = scale.toFixed(3);
        this.edgeL[nk].style.transform = `translate(-50%,-50%) translate3d(${(-this.edgeX).toFixed(2)}px,${y.toFixed(2)}px,0) scale(${es})`;
        this.edgeR[nk].style.transform = `translate(-50%,-50%) translate3d(${this.edgeX.toFixed(2)}px,${y.toFixed(2)}px,0) scale(${es})`;
        this.edgeL[nk].style.opacity = eo;
        this.edgeR[nk].style.opacity = eo;
        this.edgeL[nk].classList.toggle('current', isTarget);
        this.edgeR[nk].classList.toggle('current', isTarget);
        // upcoming letters in the periphery are greyed so only the current target reads as "now"
        this.edgeL[nk].classList.toggle('pending', gi > 0);
        this.edgeR[nk].classList.toggle('pending', gi > 0);
      }
    }

    if (lanes) {
      if (LINK_ARROWS) {
        this.poly.setAttribute('points', ''); // hide the plain line
        let ai = 0;
        for (let p = idx; p < base + P - 1 && ai < this.arrows.length; p++) {
          const r0 = p - base, r1 = r0 + 1;
          if (r1 >= P || !cVis[r0] || !cVis[r1]) continue;
          const path = this.arrows[ai++];
          const d = this.arrowD(cX[r0], cY[r0], cScl[r0], cX[r1], cY[r1], cScl[r1]);
          if (!d) {
            path.style.display = 'none';
            continue;
          }
          path.setAttribute('d', d);
          const tci = cCi[r1]; // colour by the TARGET character's hand
          path.setAttribute('stroke', tci >= 0 ? this.laneColor[tci] : 'rgba(200,212,235,0.5)');
          path.style.opacity = Math.max(0.3, 1 - (p - idx) / (lookahead + 1)).toFixed(2);
          path.style.display = 'block';
        }
        for (; ai < this.arrows.length; ai++) this.arrows[ai].style.display = 'none';
      } else {
        for (const a of this.arrows) a.style.display = 'none';
        this.poly.setAttribute('points', pts.join(' '));
      }
    }
  }
}

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
const GAP = 0.5; // centre-gap width in lane-widths (1 = a full empty lane, 0 = none)
const LINK_ARROWS = false; // true = per-digraph arrows coloured by the target's hand; false = one plain polyline
const FOVEAL_CUE = false; // small hand-coloured preview of the next few chars, right above the target
const FOVEAL_N = 3; // how many upcoming chars the foveal cue shows
const LANE_HIGHLIGHT = true; // highlight the full lane of the current target (+ 50% for the next)
const TOP_ROW_CARET = true; // a small caret above every top-row glyph (cue: reach up a row)
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
  private readonly foveal: HTMLElement; // small next-N preview pinned above the target
  private readonly fovealInners: HTMLSpanElement[] = [];
  // chords mode: a separate pool (up to 3 glyphs per position) + a horizontal link per chord
  private chordLayer: HTMLElement | null = null;
  private readonly chordNodes: HTMLDivElement[] = [];
  private readonly chordInners: HTMLSpanElement[] = [];
  private chordPoly: SVGPathElement | null = null;
  private readonly gridL: HTMLElement; // left-hand lane grid (dividers + chunk lines)
  private readonly gridR: HTMLElement; // right-hand lane grid; the gap between them stays empty
  private readonly svg: SVGSVGElement; // links between consecutive glyphs (lanes)
  private readonly poly: SVGPolylineElement; // plain single-line variant (LINK_ARROWS = false)
  private readonly arrows: SVGPathElement[] = []; // one per upcoming digraph (LINK_ARROWS = true)
  private readonly bands: HTMLElement[] = []; // per-column hand-tinted background wash
  private readonly laneHiCur: HTMLElement; // full-height highlight on the current target's lane
  private readonly laneHiNext: HTMLElement; // 50% highlight on the next target's lane
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
  // per-key-index layout, precomputed from the hand structure (left fingers | thumbs | right)
  private readonly laneUnitOf: number[] = []; // lane centre in lane-widths from the strip centre
  private readonly laneKind: string[] = []; // 'L' | 'R' | 'T'(humb)
  private readonly laneTop: boolean[] = []; // true = top-row key (shares its home finger's column)
  private readonly blockIndex: number[] = []; // position within its own block (band alternation)
  private readonly leftCount: number;
  private readonly rightCount: number;
  private readonly centerWidth: number; // thumb lanes, or the empty gap when there are none
  private readonly totalUnits: number; // full width in lane-widths
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
    // Two hand blocks (left fingers blue | neutral centre gap | right fingers yellow). Each
    // hand has as many COLUMNS as its widest row; a top-row key shares the exact column of its
    // home-row finger (q over a), so it differs only in the glyph shown — same lane, same
    // colour, same everything else, just stacked a row higher on a real keyboard.
    const cfg = engine.config;
    const leftHome = [...cfg.leftFingers], rightHome = [...cfg.rightFingers];
    const leftTop = [...cfg.leftTopRow], rightTop = [...cfg.rightTopRow];
    this.leftCount = Math.max(leftHome.length, leftTop.length);
    this.rightCount = Math.max(rightHome.length, rightTop.length);
    this.centerWidth = GAP; // no thumbs; a neutral centre gap
    this.totalUnits = this.leftCount + this.centerWidth + this.rightCount;
    const half = this.totalUnits / 2;
    // char → {hand, column, top?}; the two rows of a hand index into the same columns
    const place = new Map<string, { hand: 'L' | 'R'; col: number; top: boolean }>();
    leftHome.forEach((c, j) => place.set(c, { hand: 'L', col: j, top: false }));
    rightHome.forEach((c, j) => place.set(c, { hand: 'R', col: j, top: false }));
    leftTop.forEach((c, j) => place.set(c, { hand: 'L', col: j, top: true }));
    rightTop.forEach((c, j) => place.set(c, { hand: 'R', col: j, top: true }));
    const BLUE = 'hsl(214, 82%, 67%)', BLUE_G = 'hsla(214, 82%, 67%, 0.16)';
    const YELLOW = 'hsl(48, 85%, 60%)', YELLOW_G = 'hsla(48, 85%, 60%, 0.16)';
    const GREY = 'hsl(220, 9%, 62%)', GREY_G = 'hsla(220, 9%, 62%, 0.18)';
    for (let i = 0; i < engine.chars.length; i++) {
      const p = place.get(engine.chars[i]);
      if (p && p.hand === 'L') {
        this.laneUnitOf.push(-half + p.col + 0.5);
        this.laneKind.push('L'); this.laneTop.push(p.top); this.blockIndex.push(p.col);
        this.laneColor.push(BLUE); this.laneGlow.push(BLUE_G);
      } else if (p && p.hand === 'R') {
        this.laneUnitOf.push(-half + this.leftCount + this.centerWidth + p.col + 0.5);
        this.laneKind.push('R'); this.laneTop.push(p.top); this.blockIndex.push(p.col);
        this.laneColor.push(YELLOW); this.laneGlow.push(YELLOW_G);
      } else {
        this.laneUnitOf.push(-half + this.leftCount + this.centerWidth / 2); // unclassified → centre, grey
        this.laneKind.push('T'); this.laneTop.push(false); this.blockIndex.push(0);
        this.laneColor.push(GREY); this.laneGlow.push(GREY_G);
      }
    }

    for (let i = 0; i < engine.chars.length; i++) {
      const b = document.createElement('div');
      b.className = 'lane-band';
      root.appendChild(b);
      this.bands.push(b);
    }

    this.laneHiCur = document.createElement('div');
    this.laneHiCur.className = 'lane-hi';
    root.appendChild(this.laneHiCur);
    this.laneHiNext = document.createElement('div');
    this.laneHiNext.className = 'lane-hi next';
    root.appendChild(this.laneHiNext);

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

    for (let i = 0; i < engine.chars.length; i++) {
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

    this.foveal = document.createElement('div');
    this.foveal.className = 'foveal';
    for (let k = 0; k < FOVEAL_N; k++) {
      const sp = document.createElement('span');
      this.foveal.appendChild(sp);
      this.fovealInners.push(sp);
    }
    root.appendChild(this.foveal);

    if (engine.config.chords) {
      this.chordLayer = document.createElement('div');
      this.chordLayer.className = 'strip-layer';
      for (let k = 0; k < this.poolSize * 3; k++) {
        const node = document.createElement('div');
        node.className = 'glyph';
        const inner = document.createElement('span');
        inner.className = 'glyph-inner';
        node.appendChild(inner);
        this.chordLayer.appendChild(node);
        this.chordNodes.push(node);
        this.chordInners.push(inner);
      }
      root.appendChild(this.chordLayer);
      const cp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      cp.setAttribute('class', 'chord-link');
      this.svg.appendChild(cp);
      this.chordPoly = cp;
    }

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
      // the hands + centre (thumbs or empty gap) span totalUnits lane-widths across the
      // centre ~80%; the outer margin holds the peripheral sequence columns
      const total = this.totalUnits;
      this.colStep = Math.max(36, Math.min(200, Math.round((w * 0.8) / total)));
      const hitY = h * HIT_FRAC;
      this.hitOffset = hitY - h / 2;
      this.rowStep = Math.max(24, Math.min(this.colStep * 0.95, (hitY - 6) / (lookahead + 1)));
      // cap the font so the diacritic strip + letter (box ≈ 1.4·font) fits inside one row's pitch
      this.font = Math.max(14, Math.round(Math.min(this.colStep, this.rowStep * 1.1) * 0.62));
      const cx = w / 2, cy = h / 2;
      const half = total / 2;

      // one grid block per hand; the centre (thumbs / gap) has no dividers, so chunk lines
      // never cross it. Block borders bound the neutral centre.
      const blocks: Array<[HTMLElement, number, number]> = [
        [this.gridL, cx + -half * this.colStep, this.leftCount * this.colStep],
        [this.gridR, cx + (-half + this.leftCount + this.centerWidth) * this.colStep, this.rightCount * this.colStep],
      ];
      for (const [g, gx, gw] of blocks) {
        if (gw <= 0) { g.style.display = 'none'; continue; }
        g.style.display = 'block';
        g.style.left = `${gx.toFixed(1)}px`;
        g.style.width = `${gw.toFixed(1)}px`;
        g.style.setProperty('--col-step', `${this.colStep.toFixed(2)}px`);
        g.style.setProperty('--chunk-h', `${(CHUNK * this.rowStep).toFixed(2)}px`);
      }
      this.svg.style.display = 'block';

      for (let i = 0; i < this.bands.length; i++) {
        const b = this.bands[i];
        // thumb/centre stays neutral; a top-row key shares its home finger's band (drawn once)
        if (this.laneKind[i] === 'T' || this.laneTop[i]) { b.style.display = 'none'; continue; }
        b.style.display = 'block';
        b.style.left = `${(cx + this.laneCentreX(i)).toFixed(1)}px`;
        b.style.width = `${this.colStep.toFixed(1)}px`;
        const left = this.laneKind[i] === 'L';
        const a = (this.blockIndex[i] % 2 === 0 ? 1 : 0.4) * (left ? 0.08 : 0.058); // alternate intensity; balance blue vs (brighter) yellow
        b.style.background = left ? `hsla(214, 80%, 60%, ${a.toFixed(3)})` : `hsla(48, 85%, 55%, ${a.toFixed(3)})`;
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
      this.edgeX = Math.min(w / 2 - this.font * 0.72, (total / 2) * this.colStep + this.font);
      for (let i = 0; i < this.edgeL.length; i++) {
        this.edgeL[i].style.display = 'block';
        this.edgeR[i].style.display = 'block';
      }
      this.mag.style.display = 'none';
      this.foveal.style.display = FOVEAL_CUE ? 'flex' : 'none';
      this.foveal.style.fontSize = `${Math.max(11, Math.round(this.font * 0.5))}px`;
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
      this.foveal.style.display = 'none';
    }
    this.layer.style.setProperty('--glyph-font', `${this.font}px`);

    if (this.chordLayer) {
      const on = this.engine.config.chords && lanes;
      this.chordLayer.style.display = on ? 'block' : 'none';
      this.chordLayer.style.setProperty('--glyph-font', `${this.font}px`);
      if (on) {
        // chords render into their own pool; hide the single-key glyphs/edges/link
        for (const n of this.nodes) n.style.display = 'none';
        for (const n of this.edgeL) n.style.display = 'none';
        for (const n of this.edgeR) n.style.display = 'none';
        this.poly.setAttribute('points', '');
      }
    }
  }

  // cumulative flow position (px) of sequence position p
  private flowPos(p: number): number {
    if (this.engine.config.lanes) return p * this.rowStep;
    const gaps = this.gapW > 0 ? Math.floor(p / CHUNK) : 0;
    return p * this.W + gaps * this.gapW;
  }

  private laneCentreX(i: number): number {
    return this.laneUnitOf[i] * this.colStep;
  }

  // symbol → its BASE key index (a and a* share the same finger/lane); -1 if unknown
  private baseIndexOf(symbol: string): number {
    const base = symbol.endsWith('*') ? symbol.slice(0, -1) : symbol;
    return this.engine.chars.indexOf(base);
  }

  private laneX(glyph: string): number {
    const i = this.baseIndexOf(glyph);
    if (i < 0) return 0;
    return this.laneCentreX(i);
  }

  // chords mode: each sequence position is a 1-3 key chord. Its keys fall on the SAME row
  // (one y per position), each in its own lane, joined by a horizontal link. The current
  // target's keys are all boxed (their lane receptors light up) and enlarged together.
  private renderChordFrame(nowMs: number): void {
    const seq = this.engine.sequence;
    const idx = this.engine.index;
    const lookahead = this.engine.config.lookahead;
    const cw = this.root.clientWidth, ch = this.root.clientHeight;
    const sinceCorrect = nowMs - this.engine.lastCorrectMs;
    const pulse = sinceCorrect < PULSE_MS ? 1 + 0.07 * (1 - sinceCorrect / PULSE_MS) : 1;
    const sinceErr = nowMs - this.engine.lastErrorMs;
    const flashActive = sinceErr < SHAKE_MS && this.engine.config.errorFeedback.includes('flash');

    // box every lane in the current target chord (multiple receptors lit at once)
    const targetKeys = new Set([...this.engine.target()]);
    for (let i = 0; i < this.receptors.length; i++) {
      const active = targetKeys.has(this.engine.chars[i]);
      this.receptors[i].style.display = active ? 'block' : 'none';
      this.receptors[i].classList.toggle('active', active);
      if (active) this.receptors[i].style.transform = `translate(-50%,-50%) scale(${pulse.toFixed(3)})`;
    }

    let slot = 0;
    const segs: string[] = [];
    const maxP = idx + lookahead + SLACK + 1;
    for (let p = idx; p < maxP && p < seq.length; p++) {
      const chord = seq[p];
      if (!chord) continue;
      const along = this.flowPos(p) - this.flow;
      const y = this.hitOffset - along;
      const d = along / this.rowStep;
      const scale = 1 + (TARGET_SCALE_LANES - 1) * Math.exp(-((d / SIGMA_LANES) ** 2));
      const gi = p - idx;
      const o = Math.max(0, 1 - gi / (lookahead + 2));
      const isTarget = p === idx;
      let minx = Infinity, maxx = -Infinity;
      for (const key of chord) {
        if (slot >= this.chordNodes.length) break;
        const node = this.chordNodes[slot];
        this.chordInners[slot].textContent = key;
        slot++;
        const lx = this.laneX(key);
        node.className = 'glyph' + (isTarget ? ' current' : '') + (isTarget && flashActive ? ' error' : '');
        const ci = this.engine.chars.indexOf(key);
        node.style.setProperty('--gc', ci >= 0 ? this.laneColor[ci] : 'var(--ink)');
        node.style.transform = `translate(-50%,-50%) translate3d(${lx.toFixed(2)}px,${y.toFixed(2)}px,0) scale(${scale.toFixed(3)})`;
        node.style.opacity = o.toFixed(3);
        node.style.zIndex = isTarget ? '3' : '1';
        node.style.display = 'block';
        if (lx < minx) minx = lx;
        if (lx > maxx) maxx = lx;
      }
      if (maxx > minx) segs.push(`M${(cw / 2 + minx).toFixed(1)},${(ch / 2 + y).toFixed(1)}L${(cw / 2 + maxx).toFixed(1)},${(ch / 2 + y).toFixed(1)}`);
    }
    for (; slot < this.chordNodes.length; slot++) this.chordNodes[slot].style.display = 'none';
    if (this.chordPoly) this.chordPoly.setAttribute('d', segs.join(' '));
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
      if (this.engine.config.chords) {
        this.laneHiCur.style.display = 'none';
        this.laneHiNext.style.display = 'none';
        this.renderChordFrame(nowMs);
        return; // chords use their own pool; skip the single-key glyph path
      }
      // show ONLY the target's receptor (a box around the current character), and pulse it
      const col = this.baseIndexOf(this.engine.target());
      for (let i = 0; i < this.receptors.length; i++) {
        const active = i === col;
        this.receptors[i].style.display = active ? 'block' : 'none';
        this.receptors[i].classList.toggle('active', active);
        if (active) this.receptors[i].style.transform = `translate(-50%,-50%) scale(${pulse.toFixed(3)})`;
      }
      // highlight the whole lane of the current target (+ 50% for the next one)
      if (LANE_HIGHLIGHT) {
        const cxr = this.root.clientWidth / 2;
        this.laneHiCur.style.display = 'block';
        this.laneHiCur.style.width = `${this.colStep.toFixed(1)}px`;
        this.laneHiCur.style.left = `${(cxr + this.laneX(this.engine.target())).toFixed(1)}px`;
        this.laneHiCur.style.setProperty('--hc', this.laneColor[col] ?? 'var(--ink)');
        const nxt = idx + 1 < this.engine.sequence.length ? this.engine.sequence[idx + 1] : '';
        const nci = nxt ? this.baseIndexOf(nxt) : -1;
        this.laneHiNext.style.display = nci >= 0 ? 'block' : 'none';
        if (nci >= 0) {
          this.laneHiNext.style.width = `${this.colStep.toFixed(1)}px`;
          this.laneHiNext.style.left = `${(cxr + this.laneCentreX(nci)).toFixed(1)}px`;
          this.laneHiNext.style.setProperty('--hc', this.laneColor[nci] ?? 'var(--ink)');
        }
      }
      // foveal cue: the next FOVEAL_N chars, small + hand-coloured, pinned just above the target
      if (FOVEAL_CUE) {
        const sequence = this.engine.sequence;
        const tx = this.root.clientWidth / 2 + this.laneX(this.engine.target());
        this.foveal.style.left = `${tx.toFixed(1)}px`;
        this.foveal.style.top = `${(hitY - this.rowStep * 0.8).toFixed(1)}px`;
        for (let k = 0; k < this.fovealInners.length; k++) {
          const g = idx + 1 + k < sequence.length ? sequence[idx + 1 + k] : '';
          const sp = this.fovealInners[k];
          sp.textContent = g === ' ' ? '␣' : g;
          const ci = this.engine.chars.indexOf(g);
          sp.style.color = ci >= 0 ? this.laneColor[ci] : 'var(--muted)';
          sp.style.opacity = g ? (1 - k * 0.24).toFixed(2) : '0';
        }
      }
    } else {
      // chunked-row magnifier holds at centre and pulses on correct
      this.mag.style.transform = `translate(-50%,-50%) scale(${pulse.toFixed(3)})`;
      this.laneHiCur.style.display = 'none';
      this.laneHiNext.style.display = 'none';
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
        // glyph may be a chord symbol like 'a*': show the base letter + a 'chord' class (star)
        const chorded = glyph.endsWith('*');
        const baseCh = chorded ? glyph.slice(0, -1) : glyph;
        const displayCh = baseCh === ' ' ? '␣' : baseCh; // show the space key as an open box
        const ci = this.baseIndexOf(glyph);
        const topRow = TOP_ROW_CARET && ci >= 0 && this.laneTop[ci]; // caret cue for top-row keys
        const cls = 'glyph' + (chorded ? ' chord' : '') + (topRow ? ' toprow' : '');
        const gc = ci >= 0 ? this.laneColor[ci] : 'var(--ink)';
        this.inners[nk].textContent = displayCh;
        node.className = cls;
        node.style.setProperty('--gc', gc);
        this.edgeLInner[nk].textContent = displayCh;
        this.edgeRInner[nk].textContent = displayCh;
        this.edgeL[nk].className = `${cls} edge`;
        this.edgeR[nk].className = `${cls} edge`;
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
        cCi[rel] = this.baseIndexOf(glyph);
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

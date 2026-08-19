// The post-run results screen: the end-of-run number turned into a readable picture of the
// run, computed entirely from the log via the shared stats core (no new instrumentation).
//
// Governing constraint: a 60 s run is ~120–250 selections — a small sample. So this shows
// COUNTS, not two-decimal rates; SUPPRESSES any panel whose sample is too thin to mean
// anything (misses under Si<5, a transition bucket under 8, the sparkline on run one); and
// never draws a trend line through a handful of points. Overclaiming from small n is the
// thing this screen is built to avoid.
//
// Layout of this file: each panel is a `compute → build` pair. The compute half is pure and
// returns plain data; the build half turns that data into DOM and does nothing else. Panels
// prefixed v1 apply only to the legacy keyboard game, v2 only to the grid game.

import type { RunLog, DownEvent, Histogram, MomentSample } from '../core/stats.js';
import { reportStats, digraphStats, transitionMeans, confusion, ikiList, quantile, gridFitts, momentaryRate } from '../core/stats.js';
import { laneColors } from '../v1/config.js';
import type { IndexRow } from '../io/logging.js';
import { el, svgEl, section, prefersReducedMotion, animateOver } from './dom.js';
import { colOf, rowOf } from '../core/grid.js';

export interface LogInfo {
  available: boolean;
  path?: string | undefined;
  reason?: string | undefined;
}

export interface ReportCallbacks {
  onRunAgain: () => void;
  onConfig: () => void;
  onDownload: () => void;
}

/** A panel that plays an intro animation once mounted. */
interface AnimatedPanel {
  node: HTMLElement;
  animate: () => void;
}

const SPACE_GLYPH = '␣';
function fmtKey(k: string): string {
  return k === ' ' ? SPACE_GLYPH : k;
}

// Each key wears its exact per-lane colour from the falling strip (the Okabe-Ito palette, one hue
// per finger left→right), so a letter's identity carries over from play into the report.
function coloredKey(colors: Map<string, string>, ch: string): HTMLElement {
  const node = el('code', { class: 'r-di-key', text: fmtKey(ch) });
  node.style.color = colors.get(ch) ?? 'var(--rink)';
  return node;
}

// ------------------------------------------------------------------ hero ----

const HERO_COUNT_UP_MS = 600;

// Four decimals: the score is a floating-point value (log2(N-1)·(Sc-Si)/t), not integer division —
// at N=1024 it is near-integer only because log2(1023)≈9.9986, so two places rounded 11.9983 up to
// a clean "12.00". Four places surface the real fraction.
function fmtScore(bps: number): string {
  return bps.toFixed(4);
}

function heroSection(log: RunLog): AnimatedPanel {
  const { bitsPerSecond, n, sc, si, elapsedS } = log.summary;
  const scoreNode = el('div', { class: 'r-hero-num', text: fmtScore(bitsPerSecond) });

  // Under the A/B harness the run's condition is part of what the number means, so it belongs on
  // the same line as N and the counts — otherwise two reports differing only by arm look identical.

  const node = el('div', { class: 'r-hero' }, [
    scoreNode,
    el('div', { class: 'r-hero-unit', text: 'bits per second' }),
    el('div', { class: 'r-hero-util', text: `N ${n} · Sc ${sc} · Si ${si} · ${elapsedS.toFixed(1)} s` }),
  ]);

  const animate = (): void => {
    if (prefersReducedMotion()) return;
    scoreNode.textContent = fmtScore(0);
    animateOver(HERO_COUNT_UP_MS, (p) => {
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic: fast start, settles onto the number
      scoreNode.textContent = fmtScore(bitsPerSecond * eased);
    });
  };
  return { node, animate };
}

// ------------------------------------------------------ signature: run tape ----
// The whole run in one glance: one bar per *selection*, x = order, height = the full interval since
// the previous correct selection (taller = slower). When that interval contained mistakes the bar is
// SPLIT: the bottom is the time up to the first wrong input, and the "error delay" (first wrong →
// the eventual correct one) is stacked on top in the error colour — so the share of a bar lost to
// errors reads directly. Error bars also get a notch below the baseline, so that share is never
// encoded by colour alone.

interface Bar {
  t: number; // time of the completing correct selection (or the last error, if unresolved)
  label: string; // the correct selection (or the missed target, if unresolved)
  from: string | null; // the previous correct selection — so the bar is a specific transition
  total: number; // full interval since the previous correct selection
  base: number; // portion before the first mistake
  errorDelay: number; // first mistake → correct (stacked on top)
  errCount: number;
  errKeys: string[]; // the wrong inputs during this selection, in order
}

function buildBars(log: RunLog, downs: DownEvent[], medianIkiMs: number): Bar[] {
  const bars: Bar[] = [];
  let prevCorrectT: number | null = null;
  let prevCorrectKey: string | null = null;
  let pending: Array<{ t: number; target: string; key: string }> = [];

  for (const d of downs) {
    if (d.verdict === 'err') {
      pending.push({ t: d.t, target: log.sequence[d.idx] ?? '?', key: d.key });
      continue;
    }
    if (d.verdict !== 'ok') continue;

    // The first selection has no predecessor to measure from; show it at the run's median so it
    // neither dominates nor disappears.
    const total = prevCorrectT === null ? medianIkiMs : d.t - prevCorrectT;
    const firstMistakeAt = pending.length ? pending[0].t : null;
    const base = prevCorrectT === null || firstMistakeAt === null ? total : firstMistakeAt - prevCorrectT;
    const errorDelay = prevCorrectT === null || firstMistakeAt === null ? 0 : d.t - firstMistakeAt;

    bars.push({
      t: d.t,
      label: log.sequence[d.idx] ?? d.key,
      from: prevCorrectKey,
      total,
      base,
      errorDelay,
      errCount: pending.length,
      errKeys: pending.map((p) => p.key),
    });
    prevCorrectT = d.t;
    prevCorrectKey = d.key;
    pending = [];
  }

  // A run that ended mid-error (mistakes after the last correct selection) — show the wasted time.
  if (pending.length && prevCorrectT !== null) {
    const last = pending[pending.length - 1];
    const wasted = last.t - prevCorrectT;
    bars.push({
      t: last.t,
      label: last.target,
      from: prevCorrectKey,
      total: wasted,
      base: 0,
      errorDelay: wasted,
      errCount: pending.length,
      errKeys: pending.map((p) => p.key),
    });
  }
  return bars;
}

// viewBox geometry. The SVG is stretched to fit its box, so these are drawing units, not px.
const TAPE = { width: 1000, height: 100, baselineY: 72, maxBarHeight: 60, ikiCapMs: 800, revealMs: 600 };

/** Even spacing: one column per selection, so height alone carries the interval and the comb is easy
 *  to scan for tall red-topped error bars. Still left-to-right chronological, just not to scale. */
function tapeLayout(barCount: number): { barWidth: number; xOf: (i: number) => number } {
  const columnWidth = TAPE.width / Math.max(1, barCount);
  return {
    barWidth: Math.max(1.5, Math.min(6, columnWidth * 0.62)),
    xOf: (i) => (i + 0.5) * columnWidth,
  };
}

/** The 0s → end-of-run axis row under a full-width chart (the run tape and the momentary rate). */
function timeAxis(durationS: number): HTMLElement {
  return el('div', { class: 'r-tape-axis' }, [el('span', { text: '0s' }), el('span', { text: `${durationS}s` })]);
}

/** How one selection reads in a tooltip. A grid run's sequence entries are cell indices, shown as
 *  (x, y) tuples — far more legible than a raw cell number. Keyboard runs keep the glyph. */
function makeSelectionFormatter(log: RunLog): (value: string) => string {
  const gridSize = log.grid?.enabled ? log.grid.gridSize : 0;
  if (!gridSize) return fmtKey;
  return (value) => {
    const cell = Number(value);
    return Number.isFinite(cell) ? `(${colOf(cell, gridSize)}, ${rowOf(cell, gridSize)})` : value;
  };
}

function barTooltip(bar: Bar, fmtSel: (v: string) => string): string {
  const transition = !bar.from ? fmtSel(bar.label) : `${fmtSel(bar.from)} → ${fmtSel(bar.label)}`;
  const errors = bar.errCount
    ? ` · ${Math.round(bar.errorDelay)}ms lost to ${bar.errCount} error${bar.errCount > 1 ? 's' : ''}` +
      ` (pressed ${bar.errKeys.map(fmtSel).join(', ')})`
    : '';
  return `${(bar.t / 1000).toFixed(2)}s · ${transition} · ${Math.round(bar.total)}ms${errors}`;
}

/** One bar: a base segment, an optional error segment stacked on top, and its tooltip. */
function tapeBar(bar: Bar, x: number, barWidth: number, tooltip: string, onShow: () => void): SVGElement {
  const totalH = 4 + Math.min(1, bar.total / TAPE.ikiCapMs) * TAPE.maxBarHeight;
  const baseH = bar.total > 0 ? totalH * (bar.base / bar.total) : totalH;
  const errorH = Math.max(0, totalH - baseH);
  const left = (x - barWidth / 2).toFixed(2);
  const width = barWidth.toFixed(2);

  const group = svgEl('g', { class: bar.errCount ? 'r-tick err' : 'r-tick ok', tabindex: '0', role: 'img' });
  group.append(
    svgEl('rect', { class: 'r-seg-base', x: left, y: (TAPE.baselineY - baseH).toFixed(2), width, height: baseH.toFixed(2) }),
  );
  if (errorH > 0.01) {
    group.append(
      svgEl('rect', { class: 'r-seg-err', x: left, y: (TAPE.baselineY - totalH).toFixed(2), width, height: errorH.toFixed(2) }),
    );
  }
  group.setAttribute('aria-label', tooltip);
  group.append(svgEl('title', {}, [document.createTextNode(tooltip)]));
  group.addEventListener('pointerover', onShow);
  group.addEventListener('focus', onShow);
  return group;
}

/** The red miss marker below the baseline — an HTML overlay, because the SVG is x/y-stretched and
 *  a circle drawn inside it would come out as an ellipse. */
function missDot(x: number): HTMLElement {
  const dot = el('div', { class: 'r-errdot' });
  dot.style.left = `${((x / TAPE.width) * 100).toFixed(3)}%`;
  dot.style.top = `${((TAPE.baselineY + 7) / TAPE.height) * 100}%`;
  return dot;
}

function runTapeSection(log: RunLog, downs: DownEvent[]): AnimatedPanel {
  const bars = buildBars(log, downs, log.summary.medianIkiMs || 250);
  const { barWidth, xOf } = tapeLayout(bars.length);
  const fmtSel = makeSelectionFormatter(log);

  // Declared before the bars so their hover handlers close over an initialised binding.
  const tip = el('div', {
    class: 'r-tape-tip',
    text: 'One bar per selection · height = time since the last correct selection · red = time lost to errors, red dot marks a miss. Hover for detail.',
  });

  const ticks = svgEl('g', { class: 'r-tape-ticks' });
  const missDots: HTMLElement[] = [];
  bars.forEach((bar, i) => {
    const x = xOf(i);
    const tooltip = barTooltip(bar, fmtSel);
    ticks.append(tapeBar(bar, x, barWidth, tooltip, () => { tip.textContent = tooltip; }));
    if (bar.errCount) missDots.push(missDot(x));
  });

  const svg = svgEl('svg', { class: 'r-tape-svg', viewBox: `0 0 ${TAPE.width} ${TAPE.height}`, preserveAspectRatio: 'none' }, [
    svgEl('line', { class: 'r-axis', x1: '0', y1: String(TAPE.baselineY), x2: String(TAPE.width), y2: String(TAPE.baselineY) }),
    ticks,
  ]);

  const durationS = Math.round((log.summary.elapsedS * 1000 || log.meta.config.durationMs) / 1000);
  const node = section(
    'The run',
    el('div', { class: 'r-tape' }, [el('div', { class: 'r-tape-plot' }, [svg, ...missDots]), timeAxis(durationS)]),
    tip,
  );

  // Wipe the comb in left-to-right, so the eye reads it in run order.
  const animate = (): void => {
    if (prefersReducedMotion()) return;
    ticks.style.clipPath = 'inset(0 100% 0 0)';
    animateOver(TAPE.revealMs, (p) => {
      ticks.style.clipPath = p < 1 ? `inset(0 ${(100 * (1 - p)).toFixed(2)}% 0 0)` : 'none';
    });
  };
  return { node, animate };
}


// ------------------------------------------------- momentary rate over time ----
// The run tape next door plots one bar per SELECTION; this plots B against the CLOCK. They answer
// different questions: the tape shows which selections were slow, this shows whether the run had
// stretches — a fast opening, a slump at 40 s — that no per-selection view makes visible.
//
// It is deliberately not the HUD's number. That one is cumulative (B since t=0, recomputed every
// frame), so it converges within a few seconds and a bad ten seconds late in the run barely moves
// it. This is B over a sliding window, which is the thing that actually has peaks and valleys.
//
// The chart asserts nothing. It draws the curve and the run's final score, and puts the number
// under the cursor — reading whether a given bump means anything is left to the reader, which is
// why there is no prose here claiming that it does.

const MOMENT = { width: 1000, height: 150, padTop: 10, padBottom: 20, revealMs: 700 };
const MOMENT_MIN_SELECTIONS = 20; // below this the window is mostly empty and the chart is a rumour

interface MomentChart {
  samples: MomentSample[];
  xs: number[]; // viewBox x per sample
  ys: number[]; // viewBox y per sample
  windowS: number;
  durationS: number;
  refY: number;
  zeroY: number | null;
}

function computeMomentary(log: RunLog): MomentChart | null {
  if (log.summary.sc + log.summary.si < MOMENT_MIN_SELECTIONS) return null;
  const { windowMs, samples } = momentaryRate(log);
  if (samples.length < 4) return null;
  const durationMs = samples[samples.length - 1].t || 1;

  // Scale to the DATA, not to zero. A rate that never goes near zero would spend half the panel on
  // empty axis and flatten the variation the chart exists to show; the dashed final-score rule is
  // the reference the eye needs, not the origin. Zero still gets a rule if the curve reaches it.
  const values = samples.map((s) => s.bps);
  const lo = Math.min(...values, log.summary.bitsPerSecond);
  const hi = Math.max(...values, log.summary.bitsPerSecond);
  const pad = (hi - lo || 1) * 0.12;
  const min = lo - pad;
  const max = hi + pad;
  const span = max - min || 1;
  const plotH = MOMENT.height - MOMENT.padTop - MOMENT.padBottom;
  const yOfValue = (v: number): number => MOMENT.padTop + plotH * (1 - (v - min) / span);
  const zeroY = yOfValue(0);

  return {
    samples,
    xs: samples.map((s) => (s.t / durationMs) * MOMENT.width),
    ys: values.map(yOfValue),
    windowS: windowMs / 1000,
    durationS: Math.round(durationMs / 1000),
    refY: yOfValue(log.summary.bitsPerSecond),
    zeroY: zeroY > MOMENT.padTop && zeroY < MOMENT.height - MOMENT.padBottom ? zeroY : null,
  };
}

function momentaryRateSection(log: RunLog): AnimatedPanel | null {
  const chart = computeMomentary(log);
  if (!chart) return null;
  const { samples, xs, ys } = chart;

  const kids: SVGElement[] = [];
  if (chart.zeroY !== null) {
    kids.push(svgEl('line', { class: 'r-mom-zero', x1: '0', y1: String(chart.zeroY), x2: String(MOMENT.width), y2: String(chart.zeroY) }));
  }
  kids.push(svgEl('line', { class: 'r-mom-ref', x1: '0', y1: String(chart.refY), x2: String(MOMENT.width), y2: String(chart.refY) }));
  const line = svgEl('polyline', { class: 'r-mom-line', points: xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ') });
  const stroke = svgEl('g', { class: 'r-mom-strokes' }, [line]);
  kids.push(stroke);

  const svg = svgEl('svg', { class: 'r-mom-svg', viewBox: `0 0 ${MOMENT.width} ${MOMENT.height}`, preserveAspectRatio: 'none' }, kids);

  // Crosshair + readout. Both are HTML positioned in percent over the plot rather than SVG shapes:
  // the viewBox is stretched non-uniformly to fit its box, which would turn a circle into an
  // ellipse and squash any text drawn inside it. Percentages map exactly under that same stretch.
  const guide = el('div', { class: 'r-mom-guide' });
  const dot = el('div', { class: 'r-mom-dot' });
  const tip = el('div', { class: 'r-mom-tip' });
  const plot = el('div', { class: 'r-mom-plot' }, [svg, guide, dot, tip]);

  const hide = (): void => plot.classList.remove('is-hovered');
  const show = (clientX: number): void => {
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    // Nearest sample, not the interpolated value: the readout should be a number the chart
    // actually contains rather than one invented between two points.
    const i = Math.min(samples.length - 1, Math.round(frac * (samples.length - 1)));
    const xPct = (xs[i] / MOMENT.width) * 100;
    guide.style.left = `${xPct}%`;
    dot.style.left = `${xPct}%`;
    dot.style.top = `${(ys[i] / MOMENT.height) * 100}%`;
    tip.style.left = `${xPct}%`;
    // Flip the label to whichever side of the point has room, so it never sits on the curve.
    const yPct = (ys[i] / MOMENT.height) * 100;
    tip.style.top = yPct < 50 ? `calc(${yPct}% + 24px)` : `calc(${yPct}% - 24px)`;
    // Keep it inside the panel at the ends instead of letting it run off the edge.
    tip.style.transform = xPct < 12 ? 'translate(0, -50%)' : xPct > 88 ? 'translate(-100%, -50%)' : 'translate(-50%, -50%)';
    tip.textContent = `${samples[i].bps.toFixed(2)} bits/s · ${(samples[i].t / 1000).toFixed(1)}s`;
    plot.classList.add('is-hovered');
  };

  plot.addEventListener('pointermove', (e) => show((e).clientX));
  plot.addEventListener('pointerleave', hide);

  const node = section(
    'Momentary rate',
    el('div', { class: 'r-mom' }, [plot, timeAxis(chart.durationS)]),
  );

  const animate = (): void => {
    if (prefersReducedMotion()) return;
    stroke.style.clipPath = 'inset(0 100% 0 0)';
    animateOver(MOMENT.revealMs, (p) => {
      stroke.style.clipPath = p < 1 ? `inset(0 ${(100 * (1 - p)).toFixed(2)}% 0 0)` : 'none';
    });
  };
  return { node, animate };
}

// ------------------------------------------------------------- pace: IKI ----

const HIST = { width: 460, height: 150, bottomPad: 18, topPad: 6 };

function histogramSvg(hist: Histogram, meanMs: number): SVGElement {
  const svg = svgEl('svg', { class: 'r-hist-svg', viewBox: `0 0 ${HIST.width} ${HIST.height}` });
  const plotHeight = HIST.height - HIST.bottomPad - HIST.topPad;
  const maxCount = Math.max(1, ...hist.bins);
  const binWidth = HIST.width / hist.bins.length;

  hist.bins.forEach((count, i) => {
    if (count === 0) return;
    const barHeight = (count / maxCount) * plotHeight;
    svg.append(
      svgEl('rect', {
        class: 'r-hist-bar',
        x: (i * binWidth + 0.6).toFixed(2),
        y: (HIST.height - HIST.bottomPad - barHeight).toFixed(2),
        width: (binWidth - 1.2).toFixed(2),
        height: barHeight.toFixed(2),
      }),
    );
  });

  // median (amber) + mean (blue) rules, then the baseline over the top
  const ruleX = (ms: number): string => Math.min(HIST.width, (ms / hist.maxMs) * HIST.width).toFixed(1);
  const ruleY = String(HIST.height - HIST.bottomPad);
  svg.append(svgEl('line', { class: 'r-rule', x1: ruleX(hist.median), y1: '2', x2: ruleX(hist.median), y2: ruleY }));
  svg.append(svgEl('line', { class: 'r-rule-avg', x1: ruleX(meanMs), y1: '2', x2: ruleX(meanMs), y2: ruleY }));
  svg.append(svgEl('line', { class: 'r-axis', x1: '0', y1: ruleY, x2: String(HIST.width), y2: ruleY }));
  return svg;
}

/** One label-over-value cell of a stat strip — the Transitions and Movement panels are both rows
 *  of these. `sub` adds the small n= line; when a panel has no sub-line, omit the argument rather
 *  than passing '' — .r-trans-n reserves a line of height even when empty. */
function statCell(label: string, value: string, sub?: string): HTMLElement {
  const kids = [el('span', { class: 'r-trans-label', text: label }), el('span', { class: 'r-trans-ms', text: value })];
  if (sub !== undefined) kids.push(el('span', { class: 'r-trans-n', text: sub }));
  return el('div', { class: 'r-trans-cell' }, kids);
}

/** Mean interval split by transition class — the concrete cost structure of a keyboard run.
 *  Cross-hand transitions dominate and run slowest; a class with no samples shows a dash rather
 *  than a fake 0 ms. */
function transitionMeansPanel(log: RunLog, downs: DownEvent[]): HTMLElement {
  const means = transitionMeans(downs, log.meta.config.alphabet ?? '');
  const cell = (label: string, m: { mean: number; count: number }): HTMLElement =>
    statCell(label, m.count ? `${Math.round(m.mean)} ms` : '—', m.count ? `n=${m.count}` : '');
  return el('div', { class: 'r-trans' }, [
    cell('same key', means.sameKey),
    cell('same hand', means.sameHand),
    cell('cross-hand', means.crossHand),
  ]);
}

function paceSection(log: RunLog, gridMode: boolean): HTMLElement {
  const { downs, histogram } = reportStats(log);
  if (histogram.total < 3) return section('Pace', el('p', { class: 'r-empty', text: 'Too few selections to chart.' }));

  const intervals = ikiList(downs);
  const meanMs = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;

  const chart = el('div', { class: 'r-hist' }, [
    histogramSvg(histogram, meanMs),
    el('div', { class: 'r-hist-axis' }, [
      el('span', { text: '0' }),
      el('span', { text: '500' }),
      el('span', { text: '1000 ms' }),
    ]),
  ]);
  const statline = el('div', { class: 'r-hist-stat' }, [
    el('span', { class: 'r-hist-med', text: `median ${Math.round(histogram.median)} ms` }),
    el('span', { class: 'r-hist-avg', text: `avg ${Math.round(meanMs)} ms` }),
  ]);

  // A grid run has no finger/hand structure, so the transition-class split is meaningless; the
  // Movement panel carries its analysis instead.
  return gridMode
    ? section('Pace', chart, statline)
    : section('Pace', chart, statline, transitionMeansPanel(log, downs));
}

// ---------------------------------------- v1: specific digraphs (slow + fast) ----
// The 3-bucket same-finger/same-hand/cross-hand split says little once you notice most transitions
// are cross-hand. Instead, name the specific digraphs (a→b) by median interval, each letter in its
// lane colour. Show the five slowest AND the five fastest (they answer different questions), needing
// ≥2 samples so a lone pair can't top either list.

function digraphList(colors: Map<string, string>, items: ReturnType<typeof digraphStats>): HTMLElement {
  return el(
    'div',
    { class: 'r-di-list' },
    items.map((d) =>
      el('div', { class: 'r-di-row' }, [
        coloredKey(colors, d.a),
        el('span', { class: 'r-di-arrow', text: '→' }),
        coloredKey(colors, d.b),
        el('span', { class: 'r-di-ms', text: `${Math.round(d.median)} ms` }),
        el('span', { class: 'r-di-n', text: `n=${d.count}` }),
      ]),
    ),
  );
}

function transitionsColumn(log: RunLog): HTMLElement {
  const digraphs = digraphStats(reportStats(log).downs, 2);
  if (digraphs.length === 0) {
    return section('Transitions', el('p', { class: 'r-empty', text: 'Not enough repeated transitions yet.' }));
  }
  const cfg = log.meta.config; // keyboard (v1) runs only — grid runs never reach here
  const colors = laneColors({ leftFingers: cfg.leftFingers ?? '', rightFingers: cfg.rightFingers ?? '' });

  const slowest = digraphs.slice(0, 5);
  // take the fastest from the tail, never overlapping the slowest five
  const fastest = digraphs.length > 5 ? digraphs.slice(Math.max(5, digraphs.length - 5)).reverse() : [];

  const column = el('div', { class: 'r-tcol' }, [section('Slowest transitions', digraphList(colors, slowest))]);
  if (fastest.length) column.append(section('Fastest transitions', digraphList(colors, fastest)));
  return column;
}

// --------------------------------------------------------- v2: movement ----
// The pointing analogue of the transitions panel: plain movement stats — how many moves, how far,
// how long each took. Deliberately NO second bits/s figure: the headline B is the only rate shown.
// (Fitts throughput and index-of-difficulty live in the offline analyzer for anyone who wants them;
// they do not belong on the player's screen.)

/** The Movement panel's rows, as plain label/value pairs. */
function movementStats(log: RunLog): Array<[string, string]> {
  const grid = log.grid;
  const fitts = gridFitts(log);
  const corrects = reportStats(log).downs.filter((d) => d.verdict === 'ok');

  let meanIntervalMs = 0;
  for (let i = 1; i < corrects.length; i++) meanIntervalMs += corrects[i].t - corrects[i - 1].t;
  meanIntervalMs = corrects.length > 1 ? meanIntervalMs / (corrects.length - 1) : 0;

  const rows: Array<[string, string]> = [];
  if (grid) {
    rows.push(['grid', `${grid.gridSize}×${grid.gridSize}`]);
    rows.push(['input', grid.pointerType]);
    // A touch run played a coarser grid with a different input device. B divides by log2(N−1) so
    // the two are on the same scale in principle, but measured B is not actually flat in N, so the
    // score is not a like-for-like against a desktop one. Saying so on the report is the only place
    // a player would ever find out.
    if (grid.sizing === 'touch') rows.push(['sized for', `touch · not comparable to mouse runs`]);
  }
  rows.push(['moves', String(fitts?.count ?? corrects.length)]);

  // gridFitts needs a per-move distance between cells; it comes back empty on a keyboard run, and
  // then plain selection cadence is the only cadence there is.
  const hasDistances = fitts && fitts.count > 0;
  if (hasDistances) rows.push(['mean distance', `${fitts.meanDistCells.toFixed(1)} cells`]);
  const meanTimeMs = hasDistances ? fitts.meanMt : meanIntervalMs;
  if (meanTimeMs > 0) rows.push(['mean move time', `${Math.round(meanTimeMs)} ms`]);
  return rows;
}

function movementSection(log: RunLog): HTMLElement {
  return section('Movement', el('div', { class: 'r-trans' }, movementStats(log).map(([label, value]) => statCell(label, value))));
}

// ------------------------------------------------------------ v1: misses ----

const MISS_MIN_FOR_PANEL = 5; // below this a confusion display is noise rendered as a grid
const MISS_MIN_FOR_MATRIX = 25; // below this a list reads better than a sparse matrix

function missesSection(log: RunLog): HTMLElement | null {
  const { si } = log.summary;
  if (si < MISS_MIN_FOR_PANEL) return null;

  const conf = confusion(reportStats(log).downs, log.sequence, log.meta.config.alphabet ?? '');
  const body =
    si >= MISS_MIN_FOR_MATRIX
      ? confusionMatrix(log, conf)
      : el(
          'div',
          { class: 'r-miss-list' },
          conf.pairs.map((p) =>
            el('div', { class: 'r-miss-row' }, [
              el('code', { text: fmtKey(p.target) }),
              el('span', { class: 'r-miss-arrow', text: '→' }),
              el('code', { class: 'r-miss-wrong', text: fmtKey(p.pressed) }),
              el('span', { class: 'r-miss-count', text: `(${p.count})` }),
            ]),
          ),
        );

  const reading =
    conf.adjacentShare > 0.5
      ? 'Most misses are between adjacent lanes — points at the display.'
      : conf.sameHandShare > 0.5
        ? 'Most misses are same-hand, wrong finger — points at the mapping.'
        : 'Misses are spread across the keyboard.';

  return section(`Misses (${si})`, body, el('p', { class: 'r-read', text: reading }));
}

function confusionMatrix(log: RunLog, conf: ReturnType<typeof confusion>): HTMLElement {
  const chars = [...(log.meta.config.alphabet ?? '')];
  const counts = new Map(conf.pairs.map((p) => [`${p.target} ${p.pressed}`, p.count]));

  const table = el('table', { class: 'r-matrix' }, [
    el('tr', {}, [el('th', { text: '↓tgt / →hit' }), ...chars.map((c) => el('th', { text: fmtKey(c) }))]),
    ...chars.map((target) =>
      el('tr', {}, [
        el('th', { text: fmtKey(target) }),
        ...chars.map((pressed) => {
          const n = counts.get(`${target} ${pressed}`) ?? 0;
          return el('td', { class: n > 0 ? 'r-cell hit' : 'r-cell', text: n > 0 ? String(n) : '' });
        }),
      ]),
    ),
  ]);
  return el('div', { class: 'r-matrix-wrap' }, [
    table,
    el('p', { class: 'r-note', text: 'counts, target (row) × pressed (column)' }),
  ]);
}

// ----------------------------------------------------------- this machine ----

const SPARK = { width: 460, height: 90, pad: 8 };

interface SparkPoint {
  bps: number;
  scored: boolean;
  current: boolean;
  n: number;
  startedAt: string;
  mode: string;
}

/** Prior runs on this machine, with the just-finished one appended last. */
function sparkPoints(log: RunLog, indexRows: IndexRow[]): SparkPoint[] {
  const history = indexRows
    .filter((r) => r.runId !== log.meta.runId) // dedupe the run we just saved
    .map((r) => ({ bps: r.summary.bitsPerSecond, scored: r.mode === 'scored', current: false, n: r.summary.n, startedAt: r.startedAt, mode: r.mode }));
  return [
    ...history,
    { bps: log.summary.bitsPerSecond, scored: log.meta.mode === 'scored', current: true, n: log.summary.n, startedAt: log.meta.startedAt, mode: log.meta.mode },
  ];
}

function machineSection(log: RunLog, indexRows: IndexRow[]): HTMLElement | null {
  const points = sparkPoints(log, indexRows);
  if (points.length < 2) return null; // a sparkline of one point is worse than nothing

  const scores = points.map((p) => p.bps);
  const best = Math.max(...scores);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const median = quantile([...scores].sort((a, b) => a - b), 0.5);

  const maxV = Math.max(best, 0.1);
  const xOf = (i: number): string => (SPARK.pad + (i / (points.length - 1)) * (SPARK.width - 2 * SPARK.pad)).toFixed(1);
  const yOf = (v: number): string => (SPARK.height - SPARK.pad - (v / maxV) * (SPARK.height - 2 * SPARK.pad)).toFixed(1);

  const svg = svgEl('svg', { class: 'r-spark-svg', viewBox: `0 0 ${SPARK.width} ${SPARK.height}` });
  svg.append(
    svgEl('path', { class: 'r-spark-line', d: points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i)},${yOf(p.bps)}`).join(' ') }),
  );
  points.forEach((p, i) => {
    const cls = 'r-spark-dot' + (p.current ? ' current' : '') + (p.scored ? ' scored' : ' practice');
    svg.append(svgEl('circle', { class: cls, cx: xOf(i), cy: yOf(p.bps), r: p.current ? '4' : '2.6' }));
    // transparent, larger hit target carrying the hover summary of that run
    const when = String(p.startedAt).slice(0, 16).replace('T', ' ');
    const label = `${p.bps.toFixed(2)} bps · N ${p.n} · ${p.mode}${p.current ? ' · this run' : ''} · ${when}`;
    svg.append(
      svgEl('circle', { class: 'r-spark-hit', cx: xOf(i), cy: yOf(p.bps), r: '10' }, [svgEl('title', {}, [document.createTextNode(label)])]),
    );
  });

  return section(
    'This machine',
    el('div', { class: 'r-spark' }, [svg]),
    el('div', { class: 'r-spark-legend' }, [
      el('span', { text: `best ${best.toFixed(2)} · avg ${mean.toFixed(2)} · median ${median.toFixed(2)}` }),
      el('span', { text: `${points.length} runs · ● scored ○ practice` }),
    ]),
  );
}

// -------------------------------------------------------------------- root ----

function actionButton(cls: string, text: string, onClick: () => void): HTMLElement {
  const button = el('button', { class: cls, text });
  button.addEventListener('click', onClick);
  return button;
}

export function renderReport(
  root: HTMLElement,
  log: RunLog,
  indexRows: IndexRow[],
  logInfo: LogInfo,
  cb: ReportCallbacks,
): void {
  const { downs } = reportStats(log);
  const isGrid = !!log.grid?.enabled;

  const hero = heroSection(log);
  const tape = runTapeSection(log, downs);
  const momentary = momentaryRateSection(log);

  // A grid run gets pointing-appropriate panels: the interval distribution + movement stats, in
  // place of the keyboard finger/lane transitions and miss-confusion (both meaningless here).
  const twoCol = el('div', { class: 'r-cols' }, [
    paceSection(log, isGrid),
    isGrid ? movementSection(log) : transitionsColumn(log),
  ]);

  const runAgain = actionButton('btn primary', 'Run again', cb.onRunAgain);
  const panels: Node[] = [hero.node, tape.node];
  if (momentary) panels.push(momentary.node);
  panels.push(twoCol);
  const misses = isGrid ? null : missesSection(log);
  if (misses) panels.push(misses);
  const machine = machineSection(log, indexRows);
  if (machine) panels.push(machine);
  panels.push(
    el('div', { class: 'r-actions' }, [
      runAgain,
      actionButton('btn ghost', 'Download run log', cb.onDownload),
      actionButton('btn ghost', 'Config', cb.onConfig),
    ]),
    el('p', {
      class: 'r-saved',
      text: logInfo.available && logInfo.path ? `Saved to ${logInfo.path}` : 'Local logging unavailable — use Download run log',
    }),
  );

  root.append(el('div', { class: 'screen report' }, [el('div', { class: 'r-col' }, panels)]));

  hero.animate();
  tape.animate();
  momentary?.animate();
  // Enter restarts (every extra click between runs costs practice data) — but preventScroll so
  // mount doesn't jump the view down to the button; the reader lands on their score.
  runAgain.focus({ preventScroll: true });
}

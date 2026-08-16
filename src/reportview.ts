// The post-run results screen: the end-of-run number turned into a readable picture of the
// run, computed entirely from the log via the shared stats core (no new instrumentation).
//
// Governing constraint: a 60 s run is ~120–250 keystrokes — a small sample. So this shows
// COUNTS, not two-decimal rates; SUPPRESSES any panel whose sample is too thin to mean
// anything (misses under Si<5, a transition bucket under 8, the sparkline on run one); and
// never draws a trend line through a handful of points. Overclaiming from small n is the
// thing this screen is built to avoid.

import type { RunLog, DownEvent } from './stats.js';
import { reportStats, digraphStats, transitionMeans, confusion, ikiList, quantile, gridFitts } from './stats.js';
import { laneColors } from './config.js';
import type { IndexRow } from './logging.js';

// Each key wears its exact per-lane colour from the falling strip (the Okabe-Ito palette, one hue
// per finger left→right), so a letter's identity carries over from play into the report.
function coloredKey(colors: Map<string, string>, ch: string): HTMLElement {
  const base = ch.endsWith('*') ? ch.slice(0, -1) : ch; // a chord glyph 'a*' shares 'a's lane
  const e = h('code', { class: 'r-di-key', text: fmtKey(base) });
  e.style.color = colors.get(base) ?? 'var(--rink)';
  return e;
}

export interface LogInfo {
  available: boolean;
  path?: string;
  reason?: string;
}

export interface ReportCallbacks {
  onRunAgain: () => void;
  onConfig: () => void;
  onDownload: () => void;
}

const SVGNS = 'http://www.w3.org/2000/svg';

function h(tag: string, attrs?: Record<string, string>, children?: Array<Node | string>): HTMLElement {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v);
    }
  }
  if (children) for (const c of children) e.append(c);
  return e;
}
function s(tag: string, attrs?: Record<string, string>, children?: Array<Node>): SVGElement {
  const e = document.createElementNS(SVGNS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (children) for (const c of children) e.append(c);
  return e;
}
function section(title: string, ...children: Node[]): HTMLElement {
  return h('section', { class: 'r-sec' }, [h('h2', { class: 'r-sec-title', text: title }), ...children]);
}
function reduced(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
function fmtKey(k: string): string {
  return k === ' ' ? '␣' : k;
}

// ------------------------------------------------------------------ hero ----
function heroSection(log: RunLog): { node: HTMLElement; animate: () => void } {
  const sm = log.summary;
  const num = h('div', { class: 'r-hero-num' });
  num.textContent = sm.bitsPerSecond.toFixed(2);
  const util = h('div', {
    class: 'r-hero-util',
    text: `N ${sm.n} · Sc ${sm.sc} · Si ${sm.si} · ${sm.elapsedS.toFixed(1)} s`,
  });
  const node = h('div', { class: 'r-hero' }, [
    num,
    h('div', { class: 'r-hero-unit', text: 'bits per second' }),
    util,
  ]);
  const animate = (): void => {
    if (reduced()) return;
    const target = sm.bitsPerSecond;
    const dur = 600;
    const t0 = performance.now();
    const step = (now: number): void => {
      const p = Math.min(1, (now - t0) / dur);
      num.textContent = (target * (1 - Math.pow(1 - p, 3))).toFixed(2);
      if (p < 1) requestAnimationFrame(step);
      else num.textContent = target.toFixed(2);
    };
    num.textContent = '0.00';
    requestAnimationFrame(step);
  };
  return { node, animate };
}

// ------------------------------------------------------ signature: run tape ----
// The whole run in one glance: one bar per *selection* (each correct entry), x = time,
// height = the full interval since the previous correct entry (taller = slower). When that
// interval contained mistakes, the bar is SPLIT: the bottom is the time up to the first
// wrong key, and the "error delay" (first wrong key → the eventual correct key) is stacked
// on top in the error colour — so the ratio of a bar that was lost to errors reads directly,
// and you can see roughly how costly errors are. Error bars also get a notch below the
// baseline, so the error portion is never encoded by colour alone.
interface Bar {
  t: number; // time of the completing correct entry (or the last error, if unresolved)
  label: string; // the correctly-typed key (or the missed target, if unresolved)
  from: string | null; // the previous correct key — so the bar is a specific digraph
  total: number; // full interval since the previous correct entry
  base: number; // portion before the first mistake
  errorDelay: number; // first mistake → correct (stacked on top)
  errCount: number;
  errKeys: string[]; // the wrong keys pressed during this selection, in order
}
function buildBars(log: RunLog, downs: DownEvent[], med: number): Bar[] {
  const bars: Bar[] = [];
  let prevCorrectT: number | null = null;
  let prevCorrectKey: string | null = null;
  let pending: Array<{ t: number; target: string; key: string }> = [];
  for (const d of downs) {
    if (d.verdict === 'ok') {
      let total: number, base: number, errorDelay: number;
      if (prevCorrectT === null) {
        total = med;
        base = med;
        errorDelay = 0;
      } else {
        total = d.t - prevCorrectT;
        if (pending.length) {
          base = pending[0].t - prevCorrectT;
          errorDelay = d.t - pending[0].t;
        } else {
          base = total;
          errorDelay = 0;
        }
      }
      bars.push({ t: d.t, label: log.sequence[d.idx] ?? d.key, from: prevCorrectKey, total, base, errorDelay, errCount: pending.length, errKeys: pending.map((p) => p.key) });
      prevCorrectT = d.t;
      prevCorrectKey = d.key;
      pending = [];
    } else if (d.verdict === 'err') {
      pending.push({ t: d.t, target: log.sequence[d.idx] ?? '?', key: d.key });
    }
  }
  // a run that ended mid-error (errors after the last correct) — show the wasted time
  if (pending.length && prevCorrectT !== null) {
    const last = pending[pending.length - 1];
    bars.push({ t: last.t, label: last.target, from: prevCorrectKey, total: last.t - prevCorrectT, base: 0, errorDelay: last.t - prevCorrectT, errCount: pending.length, errKeys: pending.map((p) => p.key) });
  }
  return bars;
}
function runTapeSection(log: RunLog, downs: DownEvent[]): { node: HTMLElement; animate: () => void } {
  const dur = log.summary.elapsedS * 1000 || log.meta.config.durationMs;
  const W = 1000;
  const H = 100;
  const baseY = 72;
  const maxTick = 60; // px up from baseline at the slowest
  const IKI_CAP = 800; // ms mapped to a full-height bar

  const med = log.summary.medianIkiMs || 250;
  const bars = buildBars(log, downs, med);

  // How a selection reads in the tooltip: for a grid run the sequence entries are cell indices, so
  // show them as (x, y) tuples (column, row from the top-left) — far more legible than a raw cell
  // number; keyboard runs keep the glyph.
  const gridN = log.grid?.enabled ? log.grid.gridSize : 0;
  const fmtSel = (sVal: string): string => {
    if (gridN) {
      const i = Number(sVal);
      return Number.isFinite(i) ? `(${i % gridN}, ${Math.floor(i / gridN)})` : sVal;
    }
    return fmtKey(sVal);
  };

  // Even spacing: one column per selection (index-based x), so height alone carries the
  // interval and the comb is easy to scan for the tall red-topped error bars. The tape is
  // still left-to-right chronological, just not drawn to a linear time scale.
  const step = W / Math.max(1, bars.length);
  const barW = Math.max(1.5, Math.min(6, step * 0.62));
  const xOf = (i: number): number => (i + 0.5) * step;

  const svg = s('svg', { class: 'r-tape-svg', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
  svg.append(s('line', { class: 'r-axis', x1: '0', y1: String(baseY), x2: String(W), y2: String(baseY) }));

  const errDots: HTMLElement[] = []; // rendered as round HTML overlays (the SVG is x/y-stretched)
  const group = s('g', { class: 'r-tape-ticks' });
  bars.forEach((b, i) => {
    const x = xOf(i);
    const totalH = 4 + Math.min(1, b.total / IKI_CAP) * maxTick;
    const baseH = b.total > 0 ? totalH * (b.base / b.total) : totalH;
    const errH = Math.max(0, totalH - baseH);
    const g = s('g', { class: b.errCount ? 'r-tick err' : 'r-tick ok', tabindex: '0', role: 'img' });
    g.append(s('rect', { class: 'r-seg-base', x: (x - barW / 2).toFixed(2), y: (baseY - baseH).toFixed(2), width: barW.toFixed(2), height: baseH.toFixed(2) }));
    if (errH > 0.01) g.append(s('rect', { class: 'r-seg-err', x: (x - barW / 2).toFixed(2), y: (baseY - totalH).toFixed(2), width: barW.toFixed(2), height: errH.toFixed(2) }));
    const errPart = b.errCount
      ? ` · ${Math.round(b.errorDelay)}ms lost to ${b.errCount} error${b.errCount > 1 ? 's' : ''} (pressed ${b.errKeys.map(fmtSel).join(', ')})`
      : '';
    const digraph = b.from ? `${fmtSel(b.from)} → ${fmtSel(b.label)}` : fmtSel(b.label);
    const label = `${(b.t / 1000).toFixed(2)}s · ${digraph} · ${Math.round(b.total)}ms${errPart}`;
    g.setAttribute('aria-label', label);
    g.append(s('title', {}, [document.createTextNode(label)]));
    const show = (): void => {
      tip.textContent = label;
    };
    g.addEventListener('pointerover', show);
    g.addEventListener('focus', show);
    group.append(g);
    if (b.errCount) {
      const dot = h('div', { class: 'r-errdot' });
      dot.style.left = `${((x / W) * 100).toFixed(3)}%`;
      dot.style.top = `${((baseY + 7) / H) * 100}%`;
      errDots.push(dot);
    }
  });
  svg.append(group);

  const plot = h('div', { class: 'r-tape-plot' }, [svg, ...errDots]);
  const axis = h('div', { class: 'r-tape-axis' }, [
    h('span', { text: '0s' }),
    h('span', { text: `${Math.round(dur / 1000)}s` }),
  ]);
  const tip = h('div', { class: 'r-tape-tip', text: 'One bar per selection · height = time since the last correct selection · red = time lost to errors, red dot marks a miss. Hover for detail.' });
  const node = section('The run', h('div', { class: 'r-tape' }, [plot, axis]), tip);

  const animate = (): void => {
    if (reduced()) return;
    const t0 = performance.now();
    const step = (now: number): void => {
      const p = Math.min(1, (now - t0) / 600);
      group.style.clipPath = `inset(0 ${(100 * (1 - p)).toFixed(2)}% 0 0)`;
      if (p < 1) requestAnimationFrame(step);
      else group.style.clipPath = 'none';
    };
    group.style.clipPath = 'inset(0 100% 0 0)';
    requestAnimationFrame(step);
  };
  return { node, animate };
}

// ------------------------------------------------------------- pace: IKI ----
function histogramSection(log: RunLog, gridMode = false): HTMLElement {
  const stats = reportStats(log);
  const hist = stats.histogram;
  if (hist.total < 3) return section('Pace', h('p', { class: 'r-empty', text: 'Too few selections to chart.' }));

  const W = 460;
  const H = 150;
  const padB = 18;
  const maxCount = Math.max(1, ...hist.bins);
  const bw = W / hist.bins.length;
  const svg = s('svg', { class: 'r-hist-svg', viewBox: `0 0 ${W} ${H}` });
  hist.bins.forEach((c, i) => {
    if (c === 0) return;
    const bh = (c / maxCount) * (H - padB - 6);
    svg.append(s('rect', { class: 'r-hist-bar', x: (i * bw + 0.6).toFixed(2), y: (H - padB - bh).toFixed(2), width: (bw - 1.2).toFixed(2), height: bh.toFixed(2) }));
  });
  // median (amber) + mean (blue) rules
  const ik = ikiList(stats.downs);
  const mean = ik.length ? ik.reduce((a, b) => a + b, 0) / ik.length : 0;
  const ruleX = (v: number): number => Math.min(W, (v / hist.maxMs) * W);
  svg.append(s('line', { class: 'r-rule', x1: ruleX(hist.median).toFixed(1), y1: '2', x2: ruleX(hist.median).toFixed(1), y2: String(H - padB) }));
  svg.append(s('line', { class: 'r-rule-avg', x1: ruleX(mean).toFixed(1), y1: '2', x2: ruleX(mean).toFixed(1), y2: String(H - padB) }));
  svg.append(s('line', { class: 'r-axis', x1: '0', y1: String(H - padB), x2: String(W), y2: String(H - padB) }));

  const axis = h('div', { class: 'r-hist-axis' }, [
    h('span', { text: '0' }),
    h('span', { text: '500' }),
    h('span', { text: '1000 ms' }),
  ]);
  const statline = h('div', { class: 'r-hist-stat' }, [
    h('span', { class: 'r-hist-med', text: `median ${Math.round(hist.median)} ms` }),
    h('span', { class: 'r-hist-avg', text: `avg ${Math.round(mean)} ms` }),
  ]);
  // Grid runs have no finger/hand structure — the transition-class split is meaningless, so the
  // pace panel is just the interval distribution (the grid stat line below carries the movement
  // analysis instead).
  if (gridMode) return section('Pace', h('div', { class: 'r-hist' }, [svg, axis]), statline);

  // Mean interval split by transition class — the concrete cost structure of the run, in place of
  // a one-line pace summary. Cross-hand transitions dominate and run slowest; a same-key repeat is
  // the cheapest. A class with no samples shows a dash rather than a fake 0 ms.
  const tm = transitionMeans(stats.downs, log.meta.config.alphabet);
  const cell = (label: string, m: { mean: number; count: number }): HTMLElement =>
    h('div', { class: 'r-trans-cell' }, [
      h('span', { class: 'r-trans-label', text: label }),
      h('span', { class: 'r-trans-ms', text: m.count ? `${Math.round(m.mean)} ms` : '—' }),
      h('span', { class: 'r-trans-n', text: m.count ? `n=${m.count}` : '' }),
    ]);
  const trans = h('div', { class: 'r-trans' }, [
    cell('same key', tm.sameKey),
    cell('same hand', tm.sameHand),
    cell('cross-hand', tm.crossHand),
  ]);
  return section('Pace', h('div', { class: 'r-hist' }, [svg, axis]), statline, trans);
}

// ------------------------------------------ specific digraphs (slow + fast) ----
// The 3-bucket same-finger/same-hand/cross-hand split says little once you notice most
// transitions are cross-hand. Instead, name the specific digraphs (a→b) by median interval,
// each letter in its hand colour. Show the five slowest AND the five fastest (they answer
// different questions), needing ≥2 samples so a lone pair can't top either list.
function digraphList(colors: Map<string, string>, items: ReturnType<typeof digraphStats>): HTMLElement {
  const list = h('div', { class: 'r-di-list' });
  for (const d of items) {
    list.append(
      h('div', { class: 'r-di-row' }, [
        coloredKey(colors, d.a),
        h('span', { class: 'r-di-arrow', text: '→' }),
        coloredKey(colors, d.b),
        h('span', { class: 'r-di-ms', text: `${Math.round(d.median)} ms` }),
        h('span', { class: 'r-di-n', text: `n=${d.count}` }),
      ]),
    );
  }
  return list;
}
function transitionsColumn(log: RunLog): HTMLElement {
  const downs = reportStats(log).downs;
  const colors = laneColors(log.meta.config);
  const di = digraphStats(downs, 2);
  if (di.length === 0) {
    return section('Transitions', h('p', { class: 'r-empty', text: 'Not enough repeated transitions yet.' }));
  }
  const slowest = di.slice(0, 5);
  // take the fastest from the tail, never overlapping the slowest five
  const fastest = di.length > 5 ? di.slice(Math.max(5, di.length - 5)).reverse() : [];
  const col = h('div', { class: 'r-tcol' }, [section('Slowest transitions', digraphList(colors, slowest))]);
  if (fastest.length) col.append(section('Fastest transitions', digraphList(colors, fastest)));
  return col;
}

// ------------------------------------------------------- grid: movement ----
// The pointing analogue of the transitions panel: plain movement stats — how many moves, how far,
// how long each took. Deliberately NO second bits/s figure: the headline B (the homework's
// log2(N-1)·(Sc-Si)/t) is the only rate shown. (Fitts throughput and index-of-difficulty live in
// the offline analyzer for anyone who wants them; they don't belong on the player's screen.)
function gridSection(log: RunLog): HTMLElement {
  const g = log.grid;
  const f = gridFitts(log);
  const stat = (label: string, value: string): HTMLElement =>
    h('div', { class: 'r-trans-cell' }, [
      h('span', { class: 'r-trans-label', text: label }),
      h('span', { class: 'r-trans-ms', text: value }),
    ]);
  const cells: HTMLElement[] = [];
  if (g) cells.push(stat('grid', `${g.gridSize}×${g.gridSize}`), stat('input', g.pointerType));
  if (f && f.count > 0) {
    cells.push(
      stat('moves', String(f.count)),
      stat('mean distance', `${f.meanDistCells.toFixed(1)} cells`),
      stat('mean move time', `${Math.round(f.meanMt)} ms`),
    );
  }
  return section('Movement', h('div', { class: 'r-trans' }, cells));
}

// ------------------------------------------------------------------ misses ----
function missesSection(log: RunLog): HTMLElement | null {
  const si = log.summary.si;
  if (si < 5) return null; // below this a confusion display is noise rendered as a grid
  const conf = confusion(reportStats(log).downs, log.sequence, log.meta.config.alphabet);

  let body: Node;
  if (si >= 25) {
    body = confusionMatrix(log, conf);
  } else {
    const list = h('div', { class: 'r-miss-list' });
    for (const p of conf.pairs) {
      list.append(
        h('div', { class: 'r-miss-row' }, [
          h('code', { text: fmtKey(p.target) }),
          h('span', { class: 'r-miss-arrow', text: '→' }),
          h('code', { class: 'r-miss-wrong', text: fmtKey(p.pressed) }),
          h('span', { class: 'r-miss-count', text: `(${p.count})` }),
        ]),
      );
    }
    body = list;
  }
  const derived =
    conf.adjacentShare > 0.5
      ? 'Most misses are between adjacent lanes — points at the display.'
      : conf.sameHandShare > 0.5
        ? 'Most misses are same-hand, wrong finger — points at the mapping.'
        : 'Misses are spread across the keyboard.';
  return section(`Misses (${si})`, body, h('p', { class: 'r-read', text: derived }));
}

function confusionMatrix(log: RunLog, conf: ReturnType<typeof confusion>): HTMLElement {
  const chars = [...log.meta.config.alphabet];
  const grid = new Map<string, number>();
  for (const p of conf.pairs) grid.set(`${p.target} ${p.pressed}`, p.count);
  const table = h('table', { class: 'r-matrix' });
  const head = h('tr', {}, [h('th', { text: '↓tgt / →hit' }), ...chars.map((c) => h('th', { text: fmtKey(c) }))]);
  table.append(head);
  for (const tg of chars) {
    const row = h('tr', {}, [h('th', { text: fmtKey(tg) })]);
    for (const pr of chars) {
      const c = grid.get(`${tg} ${pr}`) ?? 0;
      row.append(h('td', { class: c > 0 ? 'r-cell hit' : 'r-cell', text: c > 0 ? String(c) : '' }));
    }
    table.append(row);
  }
  return h('div', { class: 'r-matrix-wrap' }, [table, h('p', { class: 'r-note', text: 'counts, target (row) × pressed (column)' })]);
}

// ----------------------------------------------------------- this machine ----
function machineSection(log: RunLog, indexRows: IndexRow[]): HTMLElement | null {
  // Dedupe the just-saved run out of history, then append the current run as the final point.
  const history = indexRows.filter((r) => r.runId !== log.meta.runId);
  const points = [
    ...history.map((r) => ({ bps: r.summary.bitsPerSecond, scored: r.mode === 'scored', current: false, n: r.summary.n, startedAt: r.startedAt, mode: r.mode })),
    { bps: log.summary.bitsPerSecond, scored: log.meta.mode === 'scored', current: true, n: log.summary.n, startedAt: log.meta.startedAt, mode: log.meta.mode },
  ];
  if (points.length < 2) return null; // a sparkline of one point is worse than nothing

  const W = 460;
  const Hh = 90;
  const pad = 8;
  const bps = points.map((p) => p.bps);
  const best = Math.max(...bps);
  const mean = bps.reduce((a, b) => a + b, 0) / bps.length;
  const median = quantile([...bps].sort((a, b) => a - b), 0.5);
  const maxV = Math.max(best, 0.1);
  const svg = s('svg', { class: 'r-spark-svg', viewBox: `0 0 ${W} ${Hh}` });
  const xOf = (i: number): number => pad + (i / (points.length - 1)) * (W - 2 * pad);
  const yOf = (v: number): number => Hh - pad - (v / maxV) * (Hh - 2 * pad);

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(p.bps).toFixed(1)}`).join(' ');
  svg.append(s('path', { class: 'r-spark-line', d: path }));
  points.forEach((p, i) => {
    const cls = 'r-spark-dot' + (p.current ? ' current' : '') + (p.scored ? ' scored' : ' practice');
    svg.append(s('circle', { class: cls, cx: xOf(i).toFixed(1), cy: yOf(p.bps).toFixed(1), r: p.current ? '4' : '2.6' }));
    // transparent, larger hit target carrying the hover summary of that run
    const when = String(p.startedAt).slice(0, 16).replace('T', ' ');
    const label = `${p.bps.toFixed(2)} bps · N ${p.n} · ${p.mode}${p.current ? ' · this run' : ''} · ${when}`;
    const hit = s('circle', { class: 'r-spark-hit', cx: xOf(i).toFixed(1), cy: yOf(p.bps).toFixed(1), r: '10' });
    hit.append(s('title', {}, [document.createTextNode(label)]));
    svg.append(hit);
  });

  const legend = h('div', { class: 'r-spark-legend' }, [
    h('span', { text: `best ${best.toFixed(2)} · avg ${mean.toFixed(2)} · median ${median.toFixed(2)}` }),
    h('span', { text: `${points.length} runs · ● scored ○ practice` }),
  ]);
  return section('This machine', h('div', { class: 'r-spark' }, [svg]), legend);
}

// -------------------------------------------------------------------- root ----
export function renderReport(
  root: HTMLElement,
  log: RunLog,
  indexRows: IndexRow[],
  logInfo: LogInfo,
  cb: ReportCallbacks,
): void {
  const stats = reportStats(log);
  const downs = stats.downs;

  const grid = !!log.grid?.enabled;
  const hero = heroSection(log);
  const tape = runTapeSection(log, downs);

  // Grid runs get pointing-appropriate panels: the interval distribution + a movement/Fitts
  // section, in place of the keyboard finger/lane transitions and miss-confusion (meaningless here).
  const twoCol = grid
    ? h('div', { class: 'r-cols' }, [histogramSection(log, true), gridSection(log)])
    : h('div', { class: 'r-cols' }, [histogramSection(log), transitionsColumn(log)]);
  const misses = grid ? null : missesSection(log);
  const machine = machineSection(log, indexRows);

  const runAgain = h('button', { class: 'btn primary', text: 'Run again' });
  runAgain.addEventListener('click', cb.onRunAgain);
  const download = h('button', { class: 'btn ghost', text: 'Download run log' });
  download.addEventListener('click', cb.onDownload);
  const config = h('button', { class: 'btn ghost', text: 'Config' });
  config.addEventListener('click', cb.onConfig);

  const savedText = logInfo.available && logInfo.path
    ? `Saved to ${logInfo.path}`
    : 'Local logging unavailable — use Download run log';
  const saved = h('p', { class: 'r-saved', text: savedText });

  const children: Node[] = [hero.node, tape.node, twoCol];
  if (misses) children.push(misses);
  if (machine) children.push(machine);
  children.push(h('div', { class: 'r-actions' }, [runAgain, download, config]), saved);

  const screen = h('div', { class: 'screen report' }, [h('div', { class: 'r-col' }, children)]);
  root.append(screen);

  hero.animate();
  tape.animate();
  // Enter restarts (every extra click between runs costs practice data) — but preventScroll
  // so mount doesn't jump the view down to the button; the reader lands on their score.
  runAgain.focus({ preventScroll: true });
}

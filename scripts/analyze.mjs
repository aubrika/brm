// Offline cross-run analysis. Plain Node, zero dependencies. Reads every log in logs/,
// prints a text report, and writes logs/analysis.json for further work (trivially loadable
// in pandas). Run from the repo root:
//
//   node scripts/analyze.mjs [--machine calvin] [--scored-only]
//
// It shares src/stats.js with the in-browser report screen, so the offline numbers and the
// on-screen numbers are computed by the exact same functions and cannot drift. Each of the
// six analyses is a separate pure function taking the parsed logs and returning a plain
// object — adding another is a ten-line change.

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  splitEvents,
  deriveFingerMap,
  classifyTransition,
  ikiStats,
  quantile,
  ikiList,
  medianIki,
} from '../src/stats.js';

const SCHEMA = 3;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(HERE, '..', 'logs');

// ---------------------------------------------------------------- loading ----
function parseArgs(argv) {
  const args = { machine: null, scoredOnly: false, compare: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--machine') args.machine = argv[++i];
    else if (argv[i] === '--scored-only') args.scoredOnly = true;
    else if (argv[i] === '--compare') args.compare = true;
  }
  return args;
}

function loadLogs(args) {
  if (!existsSync(LOGS_DIR)) return [];
  const files = readdirSync(LOGS_DIR).filter((f) => f.endsWith('.json') && f !== 'analysis.json');
  const logs = [];
  for (const f of files) {
    let log;
    try {
      log = JSON.parse(readFileSync(path.join(LOGS_DIR, f), 'utf8'));
    } catch {
      console.warn(`! skipping ${f}: invalid JSON`);
      continue;
    }
    if (log.schemaVersion !== SCHEMA) {
      console.warn(`! skipping ${f}: schemaVersion ${log.schemaVersion} (expected ${SCHEMA})`);
      continue;
    }
    if (args.machine && log.meta?.machine?.label !== args.machine) continue;
    if (args.scoredOnly && log.meta?.mode !== 'scored') continue;
    log.__file = f;
    logs.push(log);
  }
  logs.sort((a, b) => String(a.meta.startedAt).localeCompare(String(b.meta.startedAt)));
  return logs;
}

// small array helpers for the pacer analyses
function median(arr) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;
}
// index of the first element strictly greater than x (arr ascending)
function upperBound(arr, x) {
  let lo = 0,
    hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// -------------------------------------------------------------- analyses ----
// 1. IKI by transition type, per machine (over consecutive correct pairs).
function analyzeTransitions(logs) {
  const byMachine = new Map();
  for (const log of logs) {
    const label = log.meta.machine.label || '(unlabeled)';
    if (!byMachine.has(label)) byMachine.set(label, { sameFinger: [], sameHand: [], crossHand: [] });
    const b = byMachine.get(label);
    const map = deriveFingerMap(log.meta.config.alphabet);
    const { downs } = splitEvents(log);
    for (let i = 1; i < downs.length; i++) {
      const a = downs[i - 1];
      const c = downs[i];
      if (a.verdict !== 'ok' || c.verdict !== 'ok') continue;
      const kind = classifyTransition(map, a.key, c.key);
      if (kind) b[kind].push(c.t - a.t);
    }
  }
  const out = {};
  for (const [label, b] of byMachine) {
    out[label] = {
      sameFinger: ikiStats(b.sameFinger),
      sameHand: ikiStats(b.sameHand),
      crossHand: ikiStats(b.crossHand),
    };
  }
  return out;
}

// 2. Within-run quartiles: median IKI per quarter, aggregated across runs.
function analyzeQuartiles(logs) {
  const q = [[], [], [], []];
  for (const log of logs) {
    const dur = log.meta.config.durationMs;
    const { downs } = splitEvents(log);
    for (let i = 1; i < downs.length; i++) {
      const bi = Math.min(3, Math.max(0, Math.floor(downs[i].t / (dur / 4))));
      q[bi].push(downs[i].t - downs[i - 1].t);
    }
  }
  return q.map((vals, index) => ({ quarter: index + 1, ...ikiStats(vals) }));
}

// 3. Post-error slowing, broken out by error-feedback mode.
function analyzePostError(logs) {
  const byFb = new Map();
  for (const log of logs) {
    const fb = log.meta.config.errorFeedback || 'unknown';
    if (!byFb.has(fb)) byFb.set(fb, { post: [], all: [] });
    const g = byFb.get(fb);
    const { downs } = splitEvents(log);
    for (let i = 1; i < downs.length; i++) {
      const iki = downs[i].t - downs[i - 1].t;
      g.all.push(iki);
      if (downs[i - 1].verdict === 'err') g.post.push(iki);
    }
  }
  const out = {};
  for (const [fb, g] of byFb) {
    const base = ikiStats(g.all);
    const post = ikiStats(g.post);
    out[fb] = {
      baselineMedian: base.median,
      postErrorMedian: post.median,
      postErrorCount: post.count,
      inflationMs: post.count ? post.median - base.median : 0,
    };
  }
  return out;
}

// 4. Error confusion matrix, aggregated target × pressed.
function analyzeConfusion(logs) {
  const counts = new Map();
  let total = 0;
  const alphabets = new Set();
  for (const log of logs) {
    alphabets.add(log.meta.config.alphabet);
    const { downs } = splitEvents(log);
    for (const d of downs) {
      if (d.verdict !== 'err') continue;
      const target = log.sequence[d.idx];
      if (target === undefined) continue;
      const key = `${target} ${d.key}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total++;
    }
  }
  const pairs = [...counts.entries()]
    .map(([k, count]) => {
      const [target, pressed] = k.split(' ');
      return { target, pressed, count };
    })
    .sort((a, b) => b.count - a.count);
  return { total, pairs, alphabets: [...alphabets] };
}

// 5. IKI histogram, aggregated (25 ms bins).
function analyzeHistogram(logs, binMs = 25, maxMs = 1000) {
  const nBins = Math.ceil(maxMs / binMs);
  const bins = new Array(nBins).fill(0);
  let overflow = 0;
  const all = [];
  for (const log of logs) {
    const { downs } = splitEvents(log);
    for (const v of ikiList(downs)) {
      all.push(v);
      if (v >= maxMs) overflow++;
      else if (v >= 0) bins[Math.floor(v / binMs)]++;
    }
  }
  const sorted = [...all].sort((a, b) => a - b);
  return { bins, binMs, maxMs, overflow, median: quantile(sorted, 0.5), p90: quantile(sorted, 0.9), total: all.length };
}

// 6. Specific digraphs (a→b), aggregated and ranked by median IKI, each tagged with its
// hand/finger relationship — so the commonalities among the slowest vs fastest transitions
// (e.g. "the slow ones are all cross-hand") are visible and trackable across runs.
function analyzeDigraphs(logs, minCount = 5) {
  // classification uses the most common alphabet across the logs (usually the only one)
  const alphaCounts = new Map();
  for (const log of logs) alphaCounts.set(log.meta.config.alphabet, (alphaCounts.get(log.meta.config.alphabet) ?? 0) + 1);
  const alphabet = [...alphaCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const map = deriveFingerMap(alphabet);

  const groups = new Map();
  for (const log of logs) {
    const { downs } = splitEvents(log);
    for (let i = 1; i < downs.length; i++) {
      const a = downs[i - 1];
      const b = downs[i];
      if (a.verdict !== 'ok' || b.verdict !== 'ok') continue;
      const key = `${a.key} ${b.key}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b.t - a.t);
    }
  }
  const rows = [];
  for (const [key, vals] of groups) {
    if (vals.length < minCount) continue;
    const [a, b] = key.split(' ');
    const fa = map.get(a);
    const fb = map.get(b);
    const st = ikiStats(vals);
    const kind = fa && fb ? classifyTransition(map, a, b) : null;
    rows.push({
      a, b, median: st.median, p90: st.p90, count: st.count,
      kind, // 'sameFinger' | 'sameHand' | 'crossHand' | null
      handA: fa?.hand ?? '?', handB: fb?.hand ?? '?',
      fingerA: fa?.fingerName ?? '?', fingerB: fb?.fingerName ?? '?',
      adjacent: fa && fb ? Math.abs(fa.col - fb.col) === 1 : false,
    });
  }
  rows.sort((x, y) => y.median - x.median);

  const medOfMed = (list) => quantile(list.map((r) => r.median).sort((a, b) => a - b), 0.5);
  const byKind = {};
  for (const kind of ['sameFinger', 'sameHand', 'crossHand']) {
    const g = rows.filter((r) => r.kind === kind);
    byKind[kind] = { digraphs: g.length, transitions: g.reduce((s, r) => s + r.count, 0), medianOfMediansMs: g.length ? medOfMed(g) : 0 };
  }
  const profile = (list) => ({
    n: list.length,
    crossHand: list.filter((r) => r.kind === 'crossHand').length,
    sameHand: list.filter((r) => r.kind === 'sameHand').length,
    sameFinger: list.filter((r) => r.kind === 'sameFinger').length,
    adjacentKey: list.filter((r) => r.adjacent).length,
    medianOfMediansMs: list.length ? medOfMed(list) : 0,
  });
  const groupN = Math.max(8, Math.round(rows.length * 0.25));
  return {
    alphabet,
    alphabetsPresent: [...alphaCounts.keys()],
    minCount,
    slowest: rows.slice(0, 10),
    fastest: rows.slice(-10).reverse(),
    byKind,
    slowestProfile: profile(rows.slice(0, groupN)),
    fastestProfile: profile(rows.slice(-groupN)),
  };
}

// ---------------------------------------------------------------- report ----
function ms(v) {
  return v ? `${Math.round(v)}ms` : '—';
}
function bucketLine(name, s) {
  if (s.count < 8) return `    ${name.padEnd(24)} n=${s.count} (too few)`;
  return `    ${name.padEnd(24)} median ${ms(s.median).padStart(6)}  p90 ${ms(s.p90).padStart(6)}  n=${s.count}`;
}

// 7 & 8. Pacer entrainment: for every correct keystroke in a paced run, where does it fall within
// the beat it lands in? Phase clustering (resultant length R → 1) means the player is locking to
// the click; a flat distribution (R → 0) means the click is wallpaper. Negative mean asynchrony —
// keystrokes landing slightly BEFORE the beat — is the classic sensorimotor-synchronization
// signature, so a negative mean here is evidence entrainment is real rather than assumed.
function analyzePacerPhase(logs) {
  const paced = logs.filter(
    (l) => l.pacer?.enabled && Array.isArray(l.pacer.clickTimes) && l.pacer.clickTimes.length >= 2,
  );
  const BINS = 10;
  const phaseBins = new Array(BINS).fill(0);
  const asyncs = [];
  for (const log of paced) {
    const clicks = [...log.pacer.clickTimes].sort((a, b) => a - b);
    const { downs } = splitEvents(log);
    for (const d of downs) {
      if (d.verdict !== 'ok') continue; // only correct selections
      const j = upperBound(clicks, d.t); // first click strictly after the keystroke
      if (j <= 0 || j >= clicks.length) continue; // keystroke outside the click span
      const prev = clicks[j - 1];
      const next = clicks[j];
      const iv = next - prev;
      if (iv <= 0) continue;
      const phase = (d.t - prev) / iv; // 0 = on this beat, →1 = just before the next
      phaseBins[Math.min(BINS - 1, Math.floor(phase * BINS))]++;
      asyncs.push(d.t - prev <= next - d.t ? d.t - prev : d.t - next); // signed offset to nearest beat
    }
  }
  // circular resultant length over the phase histogram: 0 = flat, 1 = perfectly locked
  let cx = 0,
    cy = 0;
  const total = asyncs.length;
  for (let b = 0; b < BINS; b++) {
    const ang = (2 * Math.PI * (b + 0.5)) / BINS;
    cx += phaseBins[b] * Math.cos(ang);
    cy += phaseBins[b] * Math.sin(ang);
  }
  return {
    pacedRuns: paced.length,
    keystrokes: total,
    bins: BINS,
    phaseBins,
    resultantLength: total ? Math.hypot(cx, cy) / total : 0,
    meanAsynchronyMs: mean(asyncs),
    medianAsynchronyMs: median(asyncs),
  };
}

// 9. Carryover: does a paced session leave the player faster on the NEXT, unpaced run? Per machine,
// in chronological order, split unpaced runs into those immediately preceded by a paced run vs the
// rest, and compare median IKI. This is the question that decides whether the pacer trains or toys.
function analyzeCarryover(logs) {
  const byMachine = new Map();
  for (const l of logs) {
    const label = l.meta.machine.label || '(unlabeled)';
    if (!byMachine.has(label)) byMachine.set(label, []);
    byMachine.get(label).push(l);
  }
  const postPaced = [];
  const baseline = [];
  for (const runs of byMachine.values()) {
    runs.sort((a, b) => String(a.meta.startedAt).localeCompare(String(b.meta.startedAt)));
    for (let i = 0; i < runs.length; i++) {
      if (runs[i].pacer?.enabled) continue; // only unpaced runs count as the outcome
      const mi = medianIki(splitEvents(runs[i]).downs);
      if (!Number.isFinite(mi) || mi <= 0) continue;
      (i > 0 && runs[i - 1].pacer?.enabled ? postPaced : baseline).push(mi);
    }
  }
  return {
    postPaced: { count: postPaced.length, medianIkiMs: median(postPaced) },
    baseline: { count: baseline.length, medianIkiMs: median(baseline) },
  };
}

// 10. bits/s grouped by build (commit) — the payoff of the version stamp: see whether a change
// moved the score. Ordered by first-seen so the chronology of builds reads top to bottom.
function analyzeByBuild(logs) {
  const byCommit = new Map();
  for (const l of logs) {
    const commit = l.meta.commit || 'unknown';
    if (!byCommit.has(commit)) byCommit.set(commit, { commit, version: l.meta.appVersion || '?', bps: [], first: l.meta.startedAt });
    const g = byCommit.get(commit);
    g.bps.push(l.summary.bitsPerSecond);
    if (String(l.meta.startedAt) < String(g.first)) g.first = l.meta.startedAt;
  }
  return [...byCommit.values()]
    .map((g) => ({ commit: g.commit, version: g.version, n: g.bps.length, medianBps: median(g.bps), meanBps: mean(g.bps), first: g.first }))
    .sort((a, b) => String(a.first).localeCompare(String(b.first)));
}

// 11. A/B by condition: group runs by which audio layer was on, derived from the log's tones/pacer
// flags — the whole point of the A/B harness. Median IKI, accuracy and bits/s per arm.
function armOf(log) {
  const tones = log.tones ? !!log.tones.enabled : true; // pre-A/B runs had tones always on
  const pacer = !!(log.pacer && log.pacer.enabled);
  if (tones && pacer) return 'both';
  if (tones) return 'tones';
  if (pacer) return 'pacer';
  return 'none';
}
function analyzeConditions(logs) {
  const byArm = new Map();
  for (const log of logs) {
    if (!log.tones) continue; // only A/B-era runs — older runs predate the tones/pacer log split
    const arm = armOf(log);
    if (!byArm.has(arm)) byArm.set(arm, { arm, iki: [], acc: [], bps: [] });
    const g = byArm.get(arm);
    const mi = medianIki(splitEvents(log).downs);
    if (Number.isFinite(mi) && mi > 0) g.iki.push(mi);
    g.acc.push(log.summary.accuracy);
    g.bps.push(log.summary.bitsPerSecond);
  }
  const order = ['none', 'pacer', 'tones', 'both'];
  return [...byArm.values()]
    .map((g) => ({
      arm: g.arm,
      n: g.bps.length,
      medianIkiMs: median(g.iki),
      medianAccuracy: median(g.acc),
      medianBps: median(g.bps),
      meanBps: mean(g.bps),
    }))
    .sort((a, b) => order.indexOf(a.arm) - order.indexOf(b.arm));
}

function conditionLines(conditions) {
  if (conditions.length === 0) return ['    no runs'];
  const L = [];
  for (const r of conditions) {
    L.push(
      `    ${r.arm.padEnd(6)} n=${String(r.n).padStart(3)}   IKI ${ms(r.medianIkiMs).padStart(6)}   acc ${(r.medianAccuracy * 100).toFixed(0).padStart(3)}%   bits/s ${r.medianBps.toFixed(2).padStart(5)} (mean ${r.meanBps.toFixed(2)})`,
    );
  }
  L.push('    arms: none = no audio layer · pacer = tick only · tones = lane tones only · both = both on');
  return L;
}

function printReport(logs, analysis) {
  const L = [];
  L.push('════════════════════════════════════════════════════════════');
  L.push('  Bit-Rate Maximizer — cross-run analysis');
  L.push('════════════════════════════════════════════════════════════');
  const machines = [...new Set(logs.map((l) => l.meta.machine.label || '(unlabeled)'))];
  const dates = logs.map((l) => l.meta.startedAt).sort();
  L.push(`  runs: ${logs.length}   machines: ${machines.join(', ')}`);
  if (dates.length) L.push(`  range: ${dates[0]} → ${dates[dates.length - 1]}`);
  L.push('');
  L.push('  bits/s by run (chronological):');
  for (const l of logs) {
    const tag = l.meta.mode === 'scored' ? '●' : '○';
    const commit = (l.meta.commit || '—').padEnd(12);
    L.push(`    ${tag} ${String(l.summary.bitsPerSecond.toFixed(2)).padStart(6)}   ${commit} ${l.__file}`);
  }
  L.push('');

  L.push('  [1] IKI by transition type (correct pairs), per machine');
  for (const [label, b] of Object.entries(analysis.transitions)) {
    L.push(`  ${label}:`);
    L.push(bucketLine('same finger', b.sameFinger));
    L.push(bucketLine('same hand, diff finger', b.sameHand));
    L.push(bucketLine('cross hand', b.crossHand));
  }
  L.push('');

  L.push('  [2] Within-run quartiles (median IKI per quarter)');
  for (const q of analysis.quartiles) L.push(`    Q${q.quarter}  median ${ms(q.median).padStart(6)}  n=${q.count}`);
  L.push('');

  L.push('  [3] Post-error slowing, by error feedback');
  for (const [fb, g] of Object.entries(analysis.postError)) {
    const sign = g.inflationMs >= 0 ? '+' : '';
    L.push(`    ${fb.padEnd(14)} baseline ${ms(g.baselineMedian).padStart(6)}  post-error ${ms(g.postErrorMedian).padStart(6)}  (${sign}${Math.round(g.inflationMs)}ms, n=${g.postErrorCount})`);
  }
  L.push('');

  L.push('  [4] Error confusion (target → pressed), top 12');
  if (analysis.confusion.total === 0) L.push('    no errors recorded');
  for (const p of analysis.confusion.pairs.slice(0, 12)) {
    L.push(`    ${p.target} → ${p.pressed}   ${p.count}`);
  }
  L.push('');

  L.push('  [5] IKI histogram (25 ms bins)');
  const hist = analysis.histogram;
  const maxCount = Math.max(1, ...hist.bins);
  hist.bins.forEach((c, i) => {
    if (c === 0) return;
    const lo = i * hist.binMs;
    const bar = '█'.repeat(Math.round((c / maxCount) * 40));
    L.push(`    ${String(lo).padStart(4)}ms ${bar} ${c}`);
  });
  if (hist.overflow) L.push(`    ${String(hist.maxMs).padStart(4)}+  (overflow) ${hist.overflow}`);
  L.push(`    median ${ms(hist.median)}   p90 ${ms(hist.p90)}   n=${hist.total}`);
  L.push('');

  const dg = analysis.digraphs;
  const KIND = { sameFinger: 'same-finger', sameHand: 'same-hand', crossHand: 'cross-hand', null: '—' };
  const dgLine = (r) =>
    `    ${r.a}→${r.b}  ${ms(r.median).padStart(6)}  p90 ${ms(r.p90).padStart(6)}  n=${String(r.count).padStart(3)}  ${(KIND[r.kind] ?? '—').padEnd(11)} ${r.handA}${r.handB}  ${r.fingerA}/${r.fingerB}`;
  L.push(`  [6] Specific digraphs, ranked by median IKI (n>=${dg.minCount})`);
  if (dg.alphabetsPresent.length > 1) L.push(`    (multiple alphabets present; classified using "${dg.alphabet}")`);
  if (dg.slowest.length === 0) {
    L.push('    not enough repeated digraphs yet');
  } else {
    L.push('    slowest:');
    for (const r of dg.slowest) L.push(dgLine(r));
    L.push('    fastest:');
    for (const r of dg.fastest) L.push(dgLine(r));
    L.push('    by kind (median of per-digraph medians):');
    for (const kind of ['sameFinger', 'sameHand', 'crossHand']) {
      const k = dg.byKind[kind];
      L.push(`      ${KIND[kind].padEnd(11)} ${ms(k.medianOfMediansMs).padStart(6)}   digraphs=${String(k.digraphs).padStart(2)}  transitions=${k.transitions}`);
    }
    const pf = (name, p) =>
      `    ${name.padEnd(9)} cross-hand ${p.crossHand}/${p.n}  same-hand ${p.sameHand}/${p.n}  same-finger ${p.sameFinger}/${p.n}  adjacent-key ${p.adjacentKey}/${p.n}  (${ms(p.medianOfMediansMs)})`;
    L.push(`    commonality (slowest ${dg.slowestProfile.n} vs fastest ${dg.fastestProfile.n}):`);
    L.push(pf('slowest', dg.slowestProfile));
    L.push(pf('fastest', dg.fastestProfile));
  }
  L.push('');

  const pp = analysis.pacerPhase;
  L.push('  [7] Pacer entrainment (correct keystrokes vs the beat they land in)');
  if (pp.keystrokes === 0) {
    L.push('    no paced runs with click times yet');
  } else {
    L.push(`    paced runs ${pp.pacedRuns}   keystrokes ${pp.keystrokes}`);
    const maxc = Math.max(1, ...pp.phaseBins);
    pp.phaseBins.forEach((c, i) => {
      const lo = (i / pp.bins).toFixed(1);
      const bar = '█'.repeat(Math.round((c / maxc) * 34));
      L.push(`    ${lo}–${((i + 1) / pp.bins).toFixed(1)}  ${bar} ${c}`);
    });
    const nma = pp.meanAsynchronyMs;
    L.push(`    phase concentration R ${pp.resultantLength.toFixed(3)}  (0 = click ignored, →1 = locked to it)`);
    L.push(`    mean asynchrony ${nma >= 0 ? '+' : ''}${nma.toFixed(1)}ms  (negative = tapping ahead of the beat — the synchronization signature)`);
  }
  L.push('');

  const co = analysis.carryover;
  L.push('  [8] Carryover: median IKI on unpaced runs, after a paced session vs not');
  if (co.postPaced.count === 0 && co.baseline.count === 0) {
    L.push('    no unpaced runs yet');
  } else {
    L.push(`    after a paced run   median ${ms(co.postPaced.medianIkiMs).padStart(6)}   n=${co.postPaced.count}`);
    L.push(`    baseline (not)      median ${ms(co.baseline.medianIkiMs).padStart(6)}   n=${co.baseline.count}`);
    if (co.postPaced.count && co.baseline.count) {
      const d = co.postPaced.medianIkiMs - co.baseline.medianIkiMs;
      L.push(`    difference ${d <= 0 ? '' : '+'}${Math.round(d)}ms  (negative = faster after pacing — the result that matters)`);
    }
  }
  L.push('');

  L.push('  [9] bits/s by build (commit), oldest first');
  for (const r of analysis.byBuild) {
    L.push(`    ${r.commit.padEnd(12)} v${String(r.version).padEnd(6)} median ${r.medianBps.toFixed(2).padStart(6)}  mean ${r.meanBps.toFixed(2).padStart(6)}  n=${String(r.n).padStart(3)}  ${String(r.first).slice(0, 10)}`);
  }
  L.push('');

  L.push('  [10] A/B by condition (audio layer on), median per arm');
  for (const line of conditionLines(analysis.conditions)) L.push(line);
  L.push('════════════════════════════════════════════════════════════');
  console.log(L.join('\n'));
}

// ------------------------------------------------------------------ main ----
function main() {
  const args = parseArgs(process.argv.slice(2));
  const logs = loadLogs(args);
  if (logs.length === 0) {
    console.log('No logs found in logs/. Play a run (served via `npm run dev`/`preview`) first.');
    return;
  }
  const analysis = {
    generatedAt: new Date().toISOString(),
    runs: logs.length,
    filter: args,
    transitions: analyzeTransitions(logs),
    quartiles: analyzeQuartiles(logs),
    postError: analyzePostError(logs),
    confusion: analyzeConfusion(logs),
    histogram: analyzeHistogram(logs),
    digraphs: analyzeDigraphs(logs),
    pacerPhase: analyzePacerPhase(logs),
    carryover: analyzeCarryover(logs),
    byBuild: analyzeByBuild(logs),
    conditions: analyzeConditions(logs),
  };
  if (args.compare) {
    console.log('════════════════════════════════════════════════════════════');
    console.log('  Bit-Rate Maximizer — A/B condition comparison');
    console.log(`  runs: ${logs.length}`);
    console.log('════════════════════════════════════════════════════════════');
    console.log(conditionLines(analysis.conditions).join('\n'));
    console.log('════════════════════════════════════════════════════════════');
  } else {
    printReport(logs, analysis);
  }
  writeFileSync(path.join(LOGS_DIR, 'analysis.json'), JSON.stringify(analysis, null, 2));
  console.log(`\nWrote ${path.join('logs', 'analysis.json')}`);
}

main();

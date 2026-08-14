// Offline cross-run analysis. Plain Node, zero dependencies. Reads every log in logs/,
// prints a text report, and writes logs/analysis.json for further work (trivially loadable
// in pandas). Run from the repo root:
//
//   node scripts/analyze.mjs [--machine calvin] [--scored-only]
//
// It shares src/stats.js with the in-browser report screen, so the offline numbers and the
// on-screen numbers are computed by the exact same functions and cannot drift. Each analysis
// is a separate pure function taking the parsed logs and returning a plain object — adding a
// sixth is a ten-line change.

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
} from '../src/stats.js';

const SCHEMA = 2;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = path.resolve(HERE, '..', 'logs');

// ---------------------------------------------------------------- loading ----
function parseArgs(argv) {
  const args = { machine: null, scoredOnly: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--machine') args.machine = argv[++i];
    else if (argv[i] === '--scored-only') args.scoredOnly = true;
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

// ---------------------------------------------------------------- report ----
function ms(v) {
  return v ? `${Math.round(v)}ms` : '—';
}
function bucketLine(name, s) {
  if (s.count < 8) return `    ${name.padEnd(24)} n=${s.count} (too few)`;
  return `    ${name.padEnd(24)} median ${ms(s.median).padStart(6)}  p90 ${ms(s.p90).padStart(6)}  n=${s.count}`;
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
    L.push(`    ${tag} ${String(l.summary.bitsPerSecond.toFixed(2)).padStart(6)}   ${l.__file}`);
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
  };
  printReport(logs, analysis);
  writeFileSync(path.join(LOGS_DIR, 'analysis.json'), JSON.stringify(analysis, null, 2));
  console.log(`\nWrote ${path.join('logs', 'analysis.json')}`);
}

main();

// Offline cross-run analysis. Plain Node, zero dependencies. Reads every log in logs/,
// prints a text report, and writes logs/analysis.json for further work (trivially loadable
// in pandas). Run from the repo root:
//
//   node scripts/analyze.mjs [--machine calvin] [--scored-only] [--logs DIR]
//
// It shares src/core/stats.js with the in-browser report screen, so the offline numbers and the
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
  gridFitts,
} from '../src/core/stats.js';

const SCHEMA = 3;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOGS_DIR = path.resolve(HERE, '..', 'logs');

// ---------------------------------------------------------------- loading ----
function parseArgs(argv) {
  // --logs points at an alternative directory: a set downloaded from another machine, or the
  // synthetic sets used to check this script's own statistics against a known answer.
  const args = { machine: null, scoredOnly: false, logsDir: DEFAULT_LOGS_DIR };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--machine') args.machine = argv[++i];
    else if (argv[i] === '--scored-only') args.scoredOnly = true;
    else if (argv[i] === '--logs') args.logsDir = path.resolve(argv[++i]);
  }
  return args;
}

function loadLogs(args) {
  const LOGS_DIR = args.logsDir;
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
// Keyboard (v1) analyses only apply to keyboard runs. A GRID run has no alphabet, fingers or
// digraphs — its logs omit those config fields entirely — so filter them out rather than deriving a
// finger map from nothing. (Older grid logs carried a fictitious 'asdfjkl;' alphabet; the
// `mode` discriminator catches those too.)
function keyboardLogs(logs) {
  return logs.filter((l) => l.meta?.config?.mode !== 'grid' && !l.grid?.enabled && l.meta?.config?.alphabet);
}

function analyzeTransitions(logs) {
  logs = keyboardLogs(logs);
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
  logs = keyboardLogs(logs);
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
  logs = keyboardLogs(logs);
  const empty = { alphabet: null, alphabetsPresent: [], minCount, slowest: [], fastest: [], byKind: {}, slowestProfile: null, fastestProfile: null };
  if (logs.length === 0) return empty; // grid-only log set: no digraphs to rank
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
// ------------------------------------------------------- GRID MODE analyses ----
// Only runs when grid logs are present. Four analyses from the spec (§5): a pooled Fitts
// regression (throughput = 1000/slope), verify-dwell (hover→click), the ghost A/B, and a
// pointer-type split. All movement geometry is reconstructed from the logged cell indices +
// cellPx (target width W = 1 cell), so the numbers are self-contained.
function olsFit(xs, ys) {
  const n = xs.length;
  if (n < 2) return { n, slope: 0, intercept: n ? mean(ys) : 0, r2: 0 };
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  return { n, slope, intercept: my - slope * mx, r2: sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 0 };
}

function cellOfXY(x, y, cellPx, gridSize) {
  const col = Math.floor(x / cellPx);
  const row = Math.floor(y / cellPx);
  if (col < 0 || col >= gridSize || row < 0 || row >= gridSize) return -1;
  return row * gridSize + col;
}

// Verify/dwell time per correct selection: (down time) − (first pointer sample that entered the
// target cell in this selection's window). This is where the hover pulse earns its place (shorter
// dwell, same accuracy) or doesn't.
function dwellTimes(log) {
  const g = log.grid;
  const path = log.pointerPath;
  if (!g || !path || path.length === 0) return [];
  const { downs } = splitEvents(log);
  const corr = downs.filter((d) => d.verdict === 'ok');
  const out = [];
  let prevT = 0;
  for (const d of corr) {
    const downT = d.t;
    const cell = Number(d.key);
    let entryT = null;
    for (const [pt, px, py] of path) {
      if (pt <= prevT) continue;
      if (pt > downT) break;
      if (cellOfXY(px, py, g.cellPx, g.gridSize) === cell) {
        entryT = pt;
        break;
      }
    }
    if (entryT !== null && downT >= entryT) out.push(downT - entryT);
    prevT = downT;
  }
  return out;
}

// Misclicks that landed on the ghost (T+1) cell specifically, and misclick rate split by whether
// the next target was CLOSE (within a couple cells) vs far — does a nearby ghost/next target draw
// the click? Arrays aligned with grid down-events.
function ghostMisclickStats(log) {
  const { downs } = splitEvents(log);
  const seq = log.sequence;
  const adj = log.grid?.ghostAdjacent ?? [];
  let ghostHits = 0;
  let errs = 0;
  const byAdj = { near: { err: 0, total: 0 }, far: { err: 0, total: 0 } };
  downs.forEach((d, j) => {
    const bucket = adj[j] ? byAdj.near : byAdj.far;
    bucket.total++;
    if (d.verdict === 'err') {
      bucket.err++;
      errs++;
      const ghostCell = seq[d.idx + 1];
      if (ghostCell !== undefined && String(d.key) === String(ghostCell)) ghostHits++;
    }
  });
  return { ghostHits, errs, byAdj };
}

function aggregateGrid(label, ls) {
  const rows = [];
  for (const l of ls) {
    const f = gridFitts(l);
    if (f) for (const r of f.rows) rows.push(r);
  }
  const fit = olsFit(rows.map((r) => r.id), rows.map((r) => r.mt));
  const throughput = fit.slope > 0 ? 1000 / fit.slope : 0;
  const bps = ls.map((l) => l.summary.bitsPerSecond);
  const acc = ls.map((l) => l.summary.accuracy);
  const cycle = ls.map((l) => gridFitts(l)?.meanMt ?? 0).filter((v) => v > 0);
  return {
    label,
    runs: ls.length,
    moves: rows.length,
    throughput,
    slopeMsPerBit: fit.slope,
    interceptMs: fit.intercept,
    r2: fit.r2,
    meanBps: mean(bps),
    meanAccuracy: mean(acc),
    meanCycleMs: mean(cycle),
  };
}

function analyzeGrid(logs) {
  const grid = logs.filter((l) => l.grid && l.grid.enabled);
  if (grid.length === 0) return null;
  const byType = {};
  for (const l of grid) {
    const t = l.grid.pointerType || 'mouse';
    (byType[t] ??= []).push(l);
  }
  const ghostOn = grid.filter((l) => l.grid.ghost);
  const ghostOff = grid.filter((l) => !l.grid.ghost);
  // Runs grouped by how many upcoming targets were previewed. Logs written before lookahead depth
  // existed carry only the boolean, so fall back to it. Grouped by (depth, gridSize) because the
  // two are not comparable across grid sizes and pooling them would invent a difference.
  const byLookahead = {};
  for (const l of grid) {
    const d = l.grid.lookahead ?? (l.grid.ghost ? 1 : 0);
    const key = `depth ${d} @ ${l.grid.gridSize}²`;
    (byLookahead[key] ??= []).push(l);
  }
  const dwellAll = grid.flatMap(dwellTimes);
  let ghostHits = 0;
  let errs = 0;
  const byAdj = { near: { err: 0, total: 0 }, far: { err: 0, total: 0 } };
  for (const l of grid) {
    const s = ghostMisclickStats(l);
    ghostHits += s.ghostHits;
    errs += s.errs;
    byAdj.near.err += s.byAdj.near.err;
    byAdj.near.total += s.byAdj.near.total;
    byAdj.far.err += s.byAdj.far.err;
    byAdj.far.total += s.byAdj.far.total;
  }
  return {
    runs: grid.length,
    overall: aggregateGrid('all', grid),
    byPointer: Object.entries(byType).map(([t, ls]) => aggregateGrid(t, ls)),
    ghost: { on: aggregateGrid('ghost on', ghostOn), off: aggregateGrid('ghost off', ghostOff) },
    byLookahead: Object.entries(byLookahead)
      .map(([label, ls]) => ({ ...aggregateGrid(label, ls), bpsList: ls.map((l) => l.summary.bitsPerSecond) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    dwell: { count: dwellAll.length, medianMs: median(dwellAll), meanMs: mean(dwellAll) },
    ghostMisclicks: { ghostHits, errs, share: errs > 0 ? ghostHits / errs : 0 },
    adjacency: {
      nearErrRate: byAdj.near.total > 0 ? byAdj.near.err / byAdj.near.total : 0,
      farErrRate: byAdj.far.total > 0 ? byAdj.far.err / byAdj.far.total : 0,
      nearN: byAdj.near.total,
      farN: byAdj.far.total,
    },
  };
}

// ------------------------------------------- the ghost A/B (paired analysis) ----
// Runs carrying `ab.experiment === 'ghost'` were assigned an arm by the in-app harness (src/core/
// ab.ts) in randomised pairs: each pair holds one ghost-on run and one ghost-off run. Pairing is by
// the logged block index, never by timestamp — an abandoned run or a reload would silently mis-pair
// otherwise, and a mis-paired difference is worse than no difference at all.
//
// The comparison is WITHIN pair. A player's bit rate drifts across a session by more than the ghost
// could plausibly be worth, so an unpaired mean-vs-mean would mostly measure the order the arms
// happened to fall in. Differencing inside a pair cancels that drift.

// Regularised incomplete beta, by the standard continued fraction — the only piece needed for an
// exact t p-value. Without it this script could only report point estimates, which invites reading
// a difference into what is noise.
function logGamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a, b, x) {
  const TINY = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-7) break;
  }
  return h;
}

function betainc(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betacf(a, b, x)) / a : 1 - (front * betacf(b, a, 1 - x)) / b;
}

/** Two-sided p for Student's t. */
function tTwoSided(t, df) {
  if (!Number.isFinite(t) || df <= 0) return 1;
  return betainc(df / 2, 0.5, df / (df + t * t));
}

/** Upper-tail t quantile (p > 0.5), by bisection on the two-sided tail. */
function tQuantile(p, df) {
  const target = 2 * (1 - p);
  let lo = 0;
  let hi = 1000;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (tTwoSided(mid, df) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const tCrit95 = (df) => tQuantile(0.975, df);

/** Paired t on a list of within-pair differences, plus the effect this many pairs could actually
 *  have detected — an experiment that reports "no difference" without stating its own resolution
 *  is claiming more than it measured. MDE is the 80%-power, α=.05 two-sided difference. */
function pairedTest(diffs) {
  const n = diffs.length;
  if (n < 2) return { n, mean: n ? diffs[0] : 0, sd: NaN, t: NaN, p: NaN, lo: NaN, hi: NaN, mde: NaN };
  const m = mean(diffs);
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - m) * (d - m), 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  const t = se > 0 ? m / se : 0;
  const crit = tCrit95(n - 1);
  return {
    n,
    mean: m,
    sd,
    t,
    p: se > 0 ? tTwoSided(Math.abs(t), n - 1) : 1,
    lo: m - crit * se,
    hi: m + crit * se,
    // (t_{.975} + t_{.80})·se. The textbook (z_{.975} + z_{.80}) = 2.802 is the LARGE-sample form
    // and is badly optimistic here: at 8 pairs it claims 80% power where a Monte-Carlo check of
    // this very function gives 67%. At these sample sizes the t quantiles are the whole story.
    mde: (tQuantile(0.975, n - 1) + tQuantile(0.8, n - 1)) * se,
  };
}

/** Per-run outcome measures. meanCycleMs is the mean movement time between correct selections —
 *  a per-selection quantity, so it carries far more information than the single bits/s number, and
 *  it is what the ghost is supposed to move. */
function armRunMetrics(l) {
  const f = gridFitts(l);
  const s = l.summary;
  return {
    file: l.__file,
    bps: s.bitsPerSecond,
    accuracy: s.accuracy,
    errRate: s.sc + s.si > 0 ? s.si / (s.sc + s.si) : 0,
    cycleMs: f && f.meanMt > 0 ? f.meanMt : NaN,
    meanId: f ? f.meanId : NaN,
    selections: s.sc,
  };
}

function analyzeGhostAb(logs) {
  const eligible = logs.filter(
    (l) => l.ab && l.ab.experiment === 'ghost' && l.grid && l.grid.enabled && !(l.scope && l.scope.enabled) && l.meta.mode === 'scored' && (l.grid.depth ?? 1) === 1,
  );
  if (eligible.length === 0) return { pairs: [], runs: 0, dropped: [] };

  const byBlock = new Map();
  for (const l of eligible) {
    const k = l.ab.block;
    if (!byBlock.has(k)) byBlock.set(k, []);
    byBlock.get(k).push(l);
  }

  // A pair only counts if it is exactly one arm each AND both runs were played on the same grid.
  // Changing grid size mid-pair changes N and the target width together, which would show up as a
  // ghost effect; such a pair is dropped and said so, not quietly averaged in.
  const pairs = [];
  const dropped = [];
  for (const [block, ls] of [...byBlock.entries()].sort((a, b) => a[0] - b[0])) {
    const on = ls.filter((l) => l.ab.arm === 'on');
    const off = ls.filter((l) => l.ab.arm === 'off');
    if (on.length !== 1 || off.length !== 1) {
      dropped.push({ block, why: `incomplete (${on.length} on, ${off.length} off)` });
      continue;
    }
    if (on[0].grid.gridSize !== off[0].grid.gridSize) {
      dropped.push({ block, why: `grid size changed mid-pair (${on[0].grid.gridSize} vs ${off[0].grid.gridSize})` });
      continue;
    }
    if (machineKey(on[0]) !== machineKey(off[0])) {
      dropped.push({ block, why: `played on two machines (${machineKey(on[0])} vs ${machineKey(off[0])})` });
      continue;
    }
    pairs.push({ block, gridSize: on[0].grid.gridSize, on: armRunMetrics(on[0]), off: armRunMetrics(off[0]) });
  }

  const diffs = (key) => pairs.map((p) => p.on[key] - p.off[key]).filter((v) => Number.isFinite(v));
  const armMean = (arm, key) => mean(pairs.map((p) => p[arm][key]).filter((v) => Number.isFinite(v)));

  // Mechanism check. The ghost can only help by letting you plan the next movement early, so its
  // benefit should live in the movement time. And in the OFF arm, where T+1 is invisible, error rate
  // must NOT depend on how close T+1 happens to be — if it does, something other than the ghost is
  // driving these numbers and the whole comparison is suspect.
  const adjacency = { on: { near: { err: 0, total: 0 }, far: { err: 0, total: 0 } }, off: { near: { err: 0, total: 0 }, far: { err: 0, total: 0 } } };
  for (const l of eligible) {
    const s = ghostMisclickStats(l);
    const a = adjacency[l.ab.arm];
    a.near.err += s.byAdj.near.err;
    a.near.total += s.byAdj.near.total;
    a.far.err += s.byAdj.far.err;
    a.far.total += s.byAdj.far.total;
  }

  return {
    runs: eligible.length,
    pairs,
    dropped,
    gridSizes: [...new Set(pairs.map((p) => p.gridSize))],
    means: {
      on: { bps: armMean('on', 'bps'), cycleMs: armMean('on', 'cycleMs'), errRate: armMean('on', 'errRate'), meanId: armMean('on', 'meanId') },
      off: { bps: armMean('off', 'bps'), cycleMs: armMean('off', 'cycleMs'), errRate: armMean('off', 'errRate'), meanId: armMean('off', 'meanId') },
    },
    tests: {
      bps: pairedTest(diffs('bps')),
      cycleMs: pairedTest(diffs('cycleMs')),
      errRate: pairedTest(diffs('errRate')),
      meanId: pairedTest(diffs('meanId')), // a randomisation check: the draw should be equal on both arms
    },
    adjacency,
  };
}

// ------------------------------------------- grid size sweep + scatter law ----
// What does grid resolution actually cost and buy? Bits per selection rise as log2(N) while cells
// shrink as 1/√N, so the score should sit on a plateau until targets get small enough to fall off
// an accuracy cliff. This measures where that plateau is, and — the part the calibration depends
// on — whether endpoint scatter is a fixed property of the hand or a function of the target.

/** Endpoint scatter for one run, reconstructed from the pointer path.
 *  Every click is measured against the cell it was AIMING at (sequence[idx]), hits AND misses.
 *  Using hits alone would truncate the distribution at the cell edge and force σ/cellPx ≤ 0.289
 *  by construction — which looks exactly like the proportionality this is testing for. */
function endpointScatter(log) {
  const g = log.grid?.gridSize;
  const cellPx = log.grid?.cellPx;
  const path = log.pointerPath;
  if (!g || !cellPx || !path?.length) return null;
  const { downs } = splitEvents(log);
  const dxs = [];
  const dys = [];
  let pi = 0;
  for (const d of downs) {
    const aim = Number(log.sequence[d.idx]);
    if (!Number.isFinite(aim)) continue;
    while (pi + 1 < path.length && path[pi + 1][0] <= d.t) pi++;
    let best = pi;
    for (let j = Math.max(0, pi - 2); j < Math.min(path.length, pi + 3); j++) {
      if (Math.abs(path[j][0] - d.t) < Math.abs(path[best][0] - d.t)) best = j;
    }
    if (Math.abs(path[best][0] - d.t) > 25) continue; // no sample close enough in time to be the endpoint
    const dx = path[best][1] - ((aim % g) + 0.5) * cellPx;
    const dy = path[best][2] - (Math.floor(aim / g) + 0.5) * cellPx;
    if (Math.hypot(dx, dy) > 4 * cellPx) continue; // gross lapse, as the calibration rejects too
    dxs.push(dx);
    dys.push(dy);
  }
  if (dxs.length < 20) return null;
  const sd = (v) => {
    const m = mean(v);
    return Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / (v.length - 1));
  };
  return { sigma: Math.sqrt((sd(dxs) ** 2 + sd(dys) ** 2) / 2), n: dxs.length, cellPx };
}

/** How a run's machine is identified for grouping. The name from the config screen when there is
 *  one, otherwise the random installId — never pooled, because cell size in px is set by the
 *  window and two displays are simply not the same experiment. */
export function machineKey(log) {
  const m = log.meta?.machine ?? {};
  return m.label || m.installId || '(unknown)';
}

/** One line describing a machine's display, for the report header. */
function machineLine(logs) {
  const m = logs[0].meta.machine;
  const fields = [...new Set(logs.filter((l) => l.grid?.fieldPx).map((l) => Math.round(l.grid.fieldPx)))].sort((a, b) => a - b);
  const screen = m.screenWidth ? `${m.screenWidth}×${m.screenHeight}` : 'screen unrecorded';
  const win = m.windowWidth ? `window ${m.windowWidth}×${m.windowHeight}` : 'window unrecorded';
  const dpr = m.devicePixelRatio ? ` @${m.devicePixelRatio}x` : '';
  return `${machineKey(logs[0]).padEnd(12)} ${String(logs.length).padStart(3)} runs · ${screen}${dpr} · ${win} · field ${fields.join('/') || '—'}px · ${m.platform || '?'} · ${m.estimatedRefreshHz || '?'}Hz`;
}

function analyzeGridSizes(logs) {
  const scored = logs.filter((l) => l.grid?.enabled && !l.scope?.enabled && l.meta.mode === 'scored' && (l.grid.depth ?? 1) === 1);
  if (!scored.length) return null;
  // Split by machine FIRST. A 700px laptop field and a 1750px desktop field put the same `16²`
  // setting 2.5× apart in cell size; pooling them fits the scatter law straight through two
  // different experiments and produces a number that looks like a result and is an artifact.
  const byMachine = new Map();
  for (const l of scored) {
    const k = machineKey(l);
    if (!byMachine.has(k)) byMachine.set(k, []);
    byMachine.get(k).push(l);
  }
  if (byMachine.size > 1) {
    return { perMachine: [...byMachine.entries()].map(([key, ls]) => ({ key, ...gridSizeRows(ls) })) };
  }
  return { perMachine: [{ key: machineKey(scored[0]), ...gridSizeRows(scored) }] };
}

function gridSizeRows(scored) {
  const by = new Map();
  for (const l of scored) {
    const g = l.grid.gridSize;
    if (!by.has(g)) by.set(g, { g, bps: [], cyc: [], sigmas: [], sc: 0, si: 0, cellPx: [], depths: new Set() });
    const b = by.get(g);
    b.bps.push(l.summary.bitsPerSecond);
    b.sc += l.summary.sc;
    b.si += l.summary.si;
    b.cellPx.push(l.grid.cellPx);
    b.depths.add(l.grid.lookahead ?? (l.grid.ghost ? 1 : 0));
    const f = gridFitts(l);
    if (f?.meanMt > 0) b.cyc.push(f.meanMt);
    const s = endpointScatter(l);
    if (s) b.sigmas.push(s.sigma);
  }
  const rows = [...by.values()]
    .sort((a, b) => a.g - b.g)
    .map((b) => {
      const total = b.sc + b.si;
      const sigma = b.sigmas.length ? mean(b.sigmas) : NaN;
      const cellPx = mean(b.cellPx);
      return {
        grid: b.g,
        runs: b.bps.length,
        cellPx,
        bitsPerSelection: Math.log2(b.g * b.g - 1),
        meanBps: mean(b.bps),
        sdBps: b.bps.length > 1 ? Math.sqrt(b.bps.reduce((s, v) => s + (v - mean(b.bps)) ** 2, 0) / (b.bps.length - 1)) : NaN,
        errRate: total > 0 ? b.si / total : NaN,
        meanCycleMs: b.cyc.length ? mean(b.cyc) : NaN,
        sigmaPx: sigma,
        sigmaOverCell: sigma / cellPx,
        depths: [...b.depths].sort(),
      };
    });
  // Is σ proportional to the cell? Regress log σ on log cellPx: slope 1 = strictly proportional
  // (scatter is a fixed FRACTION of the target), slope 0 = a fixed px scatter independent of it.
  // The calibration's model is slope 0; anything near 1 makes its central equation degenerate.
  const fit = rows.filter((r) => Number.isFinite(r.sigmaPx) && r.sigmaPx > 0);
  const law = fit.length >= 3 ? olsFit(fit.map((r) => Math.log(r.cellPx)), fit.map((r) => Math.log(r.sigmaPx))) : null;
  return { rows, law, ratio: fit.length ? mean(fit.map((r) => r.sigmaOverCell)) : NaN };
}

// ---------------------------------------------- [14] calibration, retired ----
// The game no longer calibrates; this section is the post-mortem, kept because the logs it reads
// still exist and because the question it asks is the one that killed the feature.
//
// VALIDITY: did the old knee calibrator's predicted B_est curve pick the grid that actually scores
// best? Measured B by grid comes from the sweep; B_est comes from that machine's own calibration.
// It answered "sometimes", with a spread of 12²–48² for one hand on one display inside an hour.
//
// KNEE VISIBILITY: fit each machine's Fitts line on its COARSEST grids and project it forward. The
// breakdown the whole method is built on shows up as fine-grid points sitting above that line; if
// they sit on it, there is no knee in the measured range and the recommendation is extrapolating.
function analyzeCalibrationV2(logs, gridSizes) {
  const byMachine = new Map();
  for (const l of logs) {
    if (!l.calibrationV2) continue;
    const k = machineKey(l);
    // One calibration per session, repeated on every run of it — dedupe on the block-A fit.
    if (!byMachine.has(k)) byMachine.set(k, new Map());
    const seen = byMachine.get(k);
    const sig = `${l.calibrationV2.blockA.fittsA}|${l.calibrationV2.blockA.fittsB}|${l.calibrationV2.inflationRatio}`;
    if (!seen.has(sig)) seen.set(sig, l.calibrationV2);
  }

  // Knee visibility, from run data alone — available whether or not a v2 calibration exists.
  const knee = (gridSizes?.perMachine ?? []).map((m) => {
    const rows = m.rows.filter((r) => Number.isFinite(r.meanCycleMs) && r.runs > 0);
    if (rows.length < 3) return { key: m.key, rows: [], fit: null };
    // Fit on the coarsest half; project onto the rest.
    const sorted = [...rows].sort((a, b) => a.grid - b.grid);
    const fitOn = sorted.slice(0, Math.max(2, Math.ceil(sorted.length / 2)));
    const fit = olsFit(fitOn.map((r) => Math.log2(r.grid)), fitOn.map((r) => r.meanCycleMs));
    return {
      key: m.key,
      fit,
      fittedTo: fitOn.map((r) => r.grid),
      rows: sorted.map((r) => {
        const predicted = fit.intercept + fit.slope * Math.log2(r.grid);
        return { grid: r.grid, observed: r.meanCycleMs, predicted, excess: predicted > 0 ? r.meanCycleMs / predicted - 1 : NaN, runs: r.runs, measuredBps: r.meanBps };
      }),
    };
  });

  const validity = [];
  for (const [key, cals] of byMachine) {
    const measured = (gridSizes?.perMachine ?? []).find((m) => m.key === key);
    for (const v2 of cals.values()) {
      const est = Object.entries(v2.bEstByCandidate).map(([g, b]) => ({ grid: Number(g), bEst: b })).sort((a, b) => a.grid - b.grid);
      if (!est.length) continue;
      const predictedArgmax = est.reduce((best, c) => (c.bEst > best.bEst ? c : best), est[0]).grid;
      const rows = (measured?.rows ?? []).filter((r) => r.runs > 0);
      const measuredBest = rows.length ? rows.reduce((best, r) => (r.meanBps > best.meanBps ? r : best), rows[0]) : null;
      // "On the plateau" = within one standard deviation of the best measured grid, not exactly it:
      // the plateau is flat and picking its exact argmax from a handful of runs is noise.
      const onPlateau = measuredBest
        ? rows.some((r) => r.grid === predictedArgmax && r.meanBps >= measuredBest.meanBps - (measuredBest.sdBps || 0.6))
        : null;
      validity.push({ key, method: v2.method, inflationRatio: v2.inflationRatio, predictedArgmax, recommended: v2.recommendedGrid, chosen: v2.chosenGrid, est, measuredBest: measuredBest ? measuredBest.grid : null, onPlateau });
    }
  }
  return { validity, knee };
}

function gridArmLine(a) {
  return `    ${a.label.padEnd(10)}  TP ${a.throughput.toFixed(2)} b/s · MT=${Math.round(a.interceptMs)}+${Math.round(a.slopeMsPerBit)}·ID (R²${a.r2.toFixed(2)}) · B ${a.meanBps.toFixed(2)} · acc ${(a.meanAccuracy * 100).toFixed(1)}% · ${a.runs} run(s)`;
}

function printReport(logs, analysis) {
  const L = [];
  L.push('════════════════════════════════════════════════════════════');
  L.push('  Bit-Rate Maximizer — cross-run analysis');
  L.push('════════════════════════════════════════════════════════════');
  const dates = logs.map((l) => l.meta.startedAt).sort();
  L.push(`  runs: ${logs.length}`);
  const byMachine = new Map();
  for (const l of logs) {
    const k = machineKey(l);
    if (!byMachine.has(k)) byMachine.set(k, []);
    byMachine.get(k).push(l);
  }
  L.push('  machines:');
  for (const ls of byMachine.values()) L.push('    ' + machineLine(ls));
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

  L.push('  [9] bits/s by build (commit), oldest first');
  for (const r of analysis.byBuild) {
    L.push(`    ${r.commit.padEnd(12)} v${String(r.version).padEnd(6)} median ${r.medianBps.toFixed(2).padStart(6)}  mean ${r.meanBps.toFixed(2).padStart(6)}  n=${String(r.n).padStart(3)}  ${String(r.first).slice(0, 10)}`);
  }
  L.push('');

  const gr = analysis.grid;
  L.push('  [11] GRID MODE (pointing) — Fitts throughput, dwell, next-target adjacency');
  if (!gr) {
    L.push('    no grid runs yet');
  } else {
    L.push(`    grid runs ${gr.runs}   moves ${gr.overall.moves}`);
    L.push(`    overall  ${gridArmLine(gr.overall).trim()}`);
    L.push('    by pointer type:');
    for (const a of gr.byPointer) L.push(gridArmLine(a));
    L.push('    ghost on/off, pooled and UNPAIRED (descriptive only — the test is [12]):');
    L.push(gridArmLine(gr.ghost.on));
    L.push(gridArmLine(gr.ghost.off));
    // Lookahead depth is a config choice, not a randomised arm, so these groups are whatever runs
    // happened to be played under each setting — different sessions, different warm-up, different
    // hands. Read the spread, not the gap between the means; only [12] licenses a causal claim.
    L.push('    by lookahead depth (config groups, NOT randomised — mean ± sd of bits/s):');
    for (const a of gr.byLookahead) {
      const m = mean(a.bpsList);
      const sd = a.bpsList.length > 1 ? Math.sqrt(a.bpsList.reduce((s2, v) => s2 + (v - m) * (v - m), 0) / (a.bpsList.length - 1)) : NaN;
      const spread = Number.isFinite(sd) ? ` ± ${sd.toFixed(2)}` : '';
      L.push(`      ${a.label.padEnd(18)} ${m.toFixed(3)}${spread} bits/s · cycle ${Math.round(a.meanCycleMs)}ms · acc ${(a.meanAccuracy * 100).toFixed(1)}% · ${a.runs} run(s)`);
    }
    if (gr.dwell.count > 0) {
      L.push(`    verify dwell (hover→click): median ${Math.round(gr.dwell.medianMs)}ms · mean ${Math.round(gr.dwell.meanMs)}ms · n=${gr.dwell.count}`);
    } else {
      L.push('    verify dwell: no pointer-path samples (older logs, or logging was off)');
    }
    L.push(`    misclicks landing on the ghost cell: ${gr.ghostMisclicks.ghostHits}/${gr.ghostMisclicks.errs} errors (${(gr.ghostMisclicks.share * 100).toFixed(1)}%)`);
    L.push(
      `    err rate by next-target distance:  near ${(gr.adjacency.nearErrRate * 100).toFixed(1)}% (n=${gr.adjacency.nearN})  vs  far ${(gr.adjacency.farErrRate * 100).toFixed(1)}% (n=${gr.adjacency.farN})`,
    );
  }
  L.push('');

  const ab = analysis.ghostAb;
  L.push('  [12] GHOST A/B — does the next-target preview raise bit rate? (paired, within-block)');
  if (!ab || ab.runs === 0) {
    L.push('    no A/B-tagged runs. Arm "A/B the lookahead ghost" on the config screen, then play');
    L.push('    scored runs in pairs — the harness assigns one ghost-on and one ghost-off per pair.');
  } else if (ab.pairs.length === 0) {
    L.push(`    ${ab.runs} tagged run(s) but no complete pair yet — play the other half of the pair.`);
  } else {
    const sizes = ab.gridSizes.length === 1 ? `${ab.gridSizes[0]}×${ab.gridSizes[0]}` : ab.gridSizes.map((s) => `${s}²`).join(', ');
    L.push(`    ${ab.pairs.length} complete pair(s) · ${ab.runs} tagged run(s) · grid ${sizes}`);
    for (const d of ab.dropped) L.push(`    ! pair ${d.block + 1} dropped: ${d.why}`);
    L.push('    pair    ghost on              ghost off             Δ (on − off)');
    for (const p of ab.pairs) {
      const d = p.on.bps - p.off.bps;
      L.push(
        `    ${String(p.block + 1).padStart(4)}    ${p.on.bps.toFixed(3).padStart(7)} b/s          ${p.off.bps.toFixed(3).padStart(7)} b/s          ${(d >= 0 ? '+' : '') + d.toFixed(3)}`,
      );
    }
    const line = (label, test, on, off, fmt, unit) => {
      if (!Number.isFinite(test.p)) return `    ${label.padEnd(16)} ${fmt(on)} vs ${fmt(off)} — need ≥2 pairs to test`;
      const sign = test.mean >= 0 ? '+' : '';
      return (
        `    ${label.padEnd(16)} on ${fmt(on)}  off ${fmt(off)}  Δ ${sign}${fmt(test.mean)}${unit}` +
        `  95% CI [${fmt(test.lo)}, ${fmt(test.hi)}]  p=${test.p.toFixed(3)}`
      );
    };
    const b3 = (v) => v.toFixed(3);
    const ms0 = (v) => (Number.isFinite(v) ? Math.round(v).toString() : '—');
    const pct = (v) => (Number.isFinite(v) ? (v * 100).toFixed(2) : '—');
    L.push('');
    L.push(line('bits/s', ab.tests.bps, ab.means.on.bps, ab.means.off.bps, b3, ''));
    L.push(line('cycle time', ab.tests.cycleMs, ab.means.on.cycleMs, ab.means.off.cycleMs, ms0, 'ms'));
    L.push(line('error rate %', ab.tests.errRate, ab.means.on.errRate, ab.means.off.errRate, pct, '%'));
    L.push(`    randomisation check: mean ID on ${ab.means.on.meanId.toFixed(3)} vs off ${ab.means.off.meanId.toFixed(3)} bits (p=${ab.tests.meanId.p.toFixed(3)}) — should be ~equal`);
    if (Number.isFinite(ab.tests.bps.mde)) {
      L.push(`    resolution: ${ab.pairs.length} pairs can detect ≥ ${ab.tests.bps.mde.toFixed(2)} bits/s at 80% power.`);
      L.push('    A null result here means "smaller than that", never "zero".');
    }
    const near = (a) => (a.near.total > 0 ? (100 * a.near.err) / a.near.total : NaN);
    const far = (a) => (a.far.total > 0 ? (100 * a.far.err) / a.far.total : NaN);
    L.push('    mechanism check — error rate when T+1 is near vs far:');
    L.push(`      ghost on   near ${pct(near(ab.adjacency.on) / 100)}%  far ${pct(far(ab.adjacency.on) / 100)}%`);
    L.push(`      ghost off  near ${pct(near(ab.adjacency.off) / 100)}%  far ${pct(far(ab.adjacency.off) / 100)}%   (off should show NO gap — T+1 is invisible)`);
  }
  L.push('');

  const gs = analysis.gridSizes;
  L.push('  [13] GRID SIZE SWEEP — what resolution costs and buys (scored, depth-1 geometry)');
  if (!gs) {
    L.push('    no scored grid runs yet');
  } else {
    for (const m of gs.perMachine) {
    if (gs.perMachine.length > 1) L.push(`    ── ${m.key} ──`);
    L.push('    grid   cellPx  runs   bits/sel   bits/s          err     cycle    sigma  sigma/cell  look');
    for (const r of m.rows) {
      const sd = Number.isFinite(r.sdBps) ? '±' + r.sdBps.toFixed(2) : '     ';
      const sig = Number.isFinite(r.sigmaPx) ? r.sigmaPx.toFixed(1).padStart(6) : '     —';
      const ratio = Number.isFinite(r.sigmaOverCell) ? r.sigmaOverCell.toFixed(3).padStart(10) : '         —';
      L.push(
        `    ${String(r.grid).padStart(4)}²  ${String(Math.round(r.cellPx)).padStart(6)}  ${String(r.runs).padStart(4)}   ` +
          `${r.bitsPerSelection.toFixed(2).padStart(7)}   ${r.meanBps.toFixed(3).padStart(6)} ${sd}  ` +
          `${(100 * r.errRate).toFixed(2).padStart(5)}%  ${String(Math.round(r.meanCycleMs)).padStart(5)}ms  ${sig}  ${ratio}  ${r.depths.join(',')}`,
      );
    }
    if (m.law) {
      // v1's calibration assumed scatter is a fixed px property of the hand (slope 0). The measured
      // slope is ~1: it is a fixed FRACTION of the target instead, which makes that calibration's
      // central equation cellPx = 4.133·σ true at EVERY grid size — no unique solution, which is
      // why it was retired. A slope that FALLS below 1 at the fine end would be the device noise
      // floor appearing, and is the one thing that could make σ a real measurement again.
      L.push('');
      L.push(`    scatter law:  log σ = ${m.law.intercept.toFixed(2)} + ${m.law.slope.toFixed(3)}·log cellPx   (R² ${m.law.r2.toFixed(3)}, ${m.rows.filter((r) => Number.isFinite(r.sigmaPx)).length} grid sizes)`);
      L.push(`    mean σ/cellPx = ${m.ratio.toFixed(3)}   →  We = 4.133σ = ${(4.133 * m.ratio).toFixed(2)}·cellPx`);
      L.push('    slope 0 = fixed scatter (what v1 calibration assumed); slope 1 = scatter scales with the target.');
    }
    L.push('');
    }
  }
  L.push('');

  const cv = analysis.calibrationV2;
  L.push('  [14] CALIBRATION (retired) — the knee the old calibrator looked for, and whether it was there');
  if (!cv || (!cv.validity.length && !cv.knee.some((k) => k.rows.length))) {
    L.push('    no v2 calibrations and too few grid sizes played to look for a knee');
  } else {
    for (const k of cv.knee) {
      if (!k.rows.length) continue;
      L.push(`    ── ${k.key} — cycle time vs the Fitts line fitted on ${k.fittedTo.join('/')}² ──`);
      L.push('    grid   observed   predicted   excess   measured B   runs');
      for (const r of k.rows) {
        const flag = r.excess > 0.15 ? '  ← above the line' : '';
        L.push(
          `    ${String(r.grid).padStart(4)}²  ${String(Math.round(r.observed)).padStart(7)}ms  ${String(Math.round(r.predicted)).padStart(8)}ms  ` +
            `${(100 * r.excess).toFixed(0).padStart(5)}%  ${r.measuredBps.toFixed(2).padStart(10)}  ${String(r.runs).padStart(4)}${flag}`,
        );
      }
      const broke = k.rows.filter((r) => r.excess > 0.15);
      L.push(broke.length ? `    knee visible from ${broke[0].grid}² up.` : '    no departure in the measured range — the knee, if any, is finer than anything played.');
      L.push('');
    }
    if (!cv.validity.length) {
      L.push('    no v2 calibrations logged yet — play a scored run after calibrating to populate this.');
    } else {
      L.push('    validity — predicted best grid vs measured best:');
      for (const v of cv.validity) {
        const curve = v.est.map((e) => `${e.grid}:${e.bEst.toFixed(1)}`).join('  ');
        L.push(`    ${v.key}  method ${v.method}  r=${v.inflationRatio}`);
        L.push(`      B_est  ${curve}`);
        L.push(
          `      predicted argmax ${v.predictedArgmax}² → recommends ${v.recommended}² (played ${v.chosen}²)` +
            (v.measuredBest === null ? '  · no sweep on this machine to check against' : `  · measured best ${v.measuredBest}²  ${v.onPlateau ? '✓ on the plateau' : '✗ off the plateau'}`),
        );
      }
    }
  }
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
    byBuild: analyzeByBuild(logs),
    grid: analyzeGrid(logs),
    ghostAb: analyzeGhostAb(logs),
    gridSizes: analyzeGridSizes(logs),
    calibrationV2: null, // filled below; it reads the grid-size sweep
  };
  analysis.calibrationV2 = analyzeCalibrationV2(logs, analysis.gridSizes);
  printReport(logs, analysis);
  writeFileSync(path.join(args.logsDir, 'analysis.json'), JSON.stringify(analysis, null, 2));
  console.log(`\nWrote ${path.join(args.logsDir, 'analysis.json')}`);
}

// Only run when invoked as a script. The statistics above are exported so scripts/stats.test.mjs
// can check them against published t-table values — a wrong p-value here would not fail loudly,
// it would just quietly produce a confident wrong answer about the ghost.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { tTwoSided, tQuantile, pairedTest, analyzeGhostAb };

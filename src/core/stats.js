// Shared, pure, DOM-free run statistics. Imported by BOTH the in-browser report screen
// (src/ui/reportview.ts, via the sibling stats.d.ts for types) AND the offline analyzer
// (scripts/analyze.mjs). Keeping one implementation means the on-screen numbers and the
// cross-run numbers can never drift. Plain JS ESM (no type annotations) so Node can import
// it directly with no build step, and no runtime dependency is added to the project.
//
// Every function takes already-parsed data and returns a plain object. Nothing here reads
// the DOM, the clock, or the network.

import { cellDistance } from './grid.js';

// -------------------------------------------------------------- finger map ----
// Derive a hand + finger assignment purely from a key's POSITION in the alphabet string.
// Documented assumption (see logs/README.md): the first floor(N/2) keys are the left hand,
// the rest the right; within each hand keys are ordered OUTSIDE-IN, so the outermost key is
// the pinky, then ring, middle, and every remaining inner key collapses onto the index
// finger (min(distance-from-outer-edge, 3)). For the default `asdfjkl;` this is exact — one
// key per finger — and for `asdfghjkl;` it correctly puts f+g on the left index and h+j on
// the right index. It is an approximation for arbitrary alphabets, not anatomy.
const FINGER_NAMES = ['pinky', 'ring', 'middle', 'index'];

export function deriveFingerMap(alphabet) {
  // Tolerates an absent alphabet: a GRID (v2) log has none, and reportStats still runs the shared
  // keyboard stats. Returns an empty map, so transitions/confusion come back empty rather than
  // throwing and blanking the whole report screen.
  const chars = [...(alphabet ?? '')];
  const n = chars.length;
  const mid = Math.floor(n / 2); // first `mid` keys = left hand (odd N gives the extra to the right)
  const map = new Map();
  for (let i = 0; i < n; i++) {
    let info;
    if (chars[i] === ' ') {
      // the spacebar is a thumb — its own hand ('C' = centre), not a finger of either hand
      info = { hand: 'C', finger: 4, fingerName: 'thumb', id: 8, col: i };
    } else {
      const left = i < mid;
      const distFromOuter = left ? i : n - 1 - i;
      const finger = Math.min(distFromOuter, 3); // 0 pinky … 3 index
      info = { hand: left ? 'L' : 'R', finger, fingerName: FINGER_NAMES[finger], id: (left ? 0 : 4) + finger, col: i };
    }
    map.set(chars[i], info);
    map.set(chars[i] + '*', info); // chord variant: same finger/hand as the base key
  }
  return map;
}

// Classify the transition between two pressed keys: 'sameFinger' (same physical finger,
// which for a one-key-per-finger alphabet means the same key repeated), 'sameHand'
// (same hand, different finger), or 'crossHand'.
export function classifyTransition(map, a, b) {
  const fa = map.get(a);
  const fb = map.get(b);
  if (!fa || !fb) return null;
  if (fa.hand !== fb.hand) return 'crossHand';
  if (fa.id === fb.id) return 'sameFinger';
  return 'sameHand';
}

// ------------------------------------------------------------- event parse ----
// Turn a raw log ({sequence, eventColumns, events}) into typed down/up lists. Columns are
// looked up by name so a future column reorder can't silently corrupt the parse.
export function splitEvents(log) {
  const cols = log.eventColumns;
  const ti = cols.indexOf('t');
  const tyi = cols.indexOf('type');
  const ki = cols.indexOf('key');
  const ii = cols.indexOf('idx');
  const vi = cols.indexOf('verdict');
  const downs = [];
  const ups = [];
  for (const e of log.events) {
    const row = { t: e[ti], key: e[ki], idx: e[ii], verdict: e[vi] };
    if (e[tyi] === 'down') downs.push(row);
    else if (e[tyi] === 'up') ups.push(row);
  }
  return { downs, ups };
}

// ---------------------------------------------------------------- selections ----
// A SELECTION is the unit this whole project counts: one scored act, correct or incorrect. It is
// what Sc and Si tally and what B divides by, and until these three helpers it was the one central
// concept with no name — every consumer re-derived it from raw events, sixteen times across this
// file and analyze.mjs, five of them the identical consecutive-correct-pair guard.
//
// Every recorded `down` IS a selection. Input that does not score never becomes an event at all:
// an out-of-alphabet key or a click outside the field increments summary.outOfAlphabet instead. So
// a down's verdict is always 'ok' or 'err', never null — null verdicts belong to `up` events.

/** The run's selections, in order. The domain-named accessor for what the file calls `down`s. */
export function selections(log) {
  return splitEvents(log).downs;
}

/** Just the correct ones — the sequence the player actually completed. */
export function correctSelections(sels) {
  return sels.filter((s) => s.verdict === 'ok');
}

/** Consecutive pairs of selections that were BOTH correct, as [a, b].
 *
 *  This is the unit of every interval statistic — inter-selection interval, transition class,
 *  digraph, Fitts movement time — because the gap between two correct selections is a clean
 *  measurement, while a gap spanning an error is a retry and measures something else. Pairs are
 *  adjacent in the log, so an error between two correct selections breaks the pair rather than
 *  joining across it. */
export function correctPairs(sels) {
  const out = [];
  for (let i = 1; i < sels.length; i++) {
    const a = sels[i - 1];
    const b = sels[i];
    if (a.verdict === 'ok' && b.verdict === 'ok') out.push([a, b]);
  }
  return out;
}

// --------------------------------------------------------- run comparability ----

/** Cells per selection. The stored name for this is `grid.depth`, which is a trap in a codebase
 *  where `lookaheadDepth` means something entirely different — so read it through here, never
 *  directly. It is always 1 on a current log; logs/ holds a batch from the retired stacked-layer
 *  variant where two cells were clicked per selection, making N = (gridSize²)². */
export function cellsPerSelection(log) {
  return log.grid?.depth ?? 1;
}

/** Is this a run of THE game — one whose B may be pooled with another run's B?
 *
 *  Comparability is the whole reason the grid is fixed at 32×32: B is NOT invariant to N in the
 *  measured data (9.07 bits/s at 8², 13.37 at 24²), so averaging across runs that answered
 *  different questions produces a number that looks like a result and is an artifact. Four kinds of
 *  log in logs/ answered a different question, and each is excluded here rather than in each
 *  caller's own copy of the predicate. */
export function isComparableGridRun(log) {
  const g = log.grid;
  if (!g || !g.enabled) return false; // not a pointing run at all
  if (log.scope && log.scope.enabled) return false; // retired SCOPE MODE: pointer lock + magnifier
  if (log.meta.mode !== 'scored') return false; // practice runs are not scores
  if (cellsPerSelection(log) !== 1) return false; // retired stacked variant: a different N entirely
  if ((g.sizing ?? 'fixed') === 'touch') return false; // fingertip-sized: different N AND device
  return true;
}

// --------------------------------------------------------------- iki stats ----
function sortedNumeric(values) {
  return [...values].sort((a, b) => a - b);
}

export function quantile(sortedValues, q) {
  if (sortedValues.length === 0) return 0;
  const pos = (sortedValues.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (pos - lo);
}

export function ikiStats(values) {
  const s = sortedNumeric(values);
  return { median: quantile(s, 0.5), p90: quantile(s, 0.9), count: s.length };
}

// Inter-key intervals between every consecutive pair of DOWN events (gross pace).
export function ikiList(downs) {
  const out = [];
  for (let i = 1; i < downs.length; i++) out.push(downs[i].t - downs[i - 1].t);
  return out;
}

export function medianIki(downs) {
  return ikiStats(ikiList(downs)).median;
}

// ------------------------------------------------------- transition buckets ----
// IKI grouped by finger-transition type, over consecutive CORRECT pairs only (an error's
// timing belongs to the error analysis, not the transition-cost analysis).
export function transitionStats(downs, alphabet) {
  const map = deriveFingerMap(alphabet);
  const buckets = { sameFinger: [], sameHand: [], crossHand: [] };
  for (const [a, b] of correctPairs(downs)) {
    const kind = classifyTransition(map, a.key, b.key);
    if (kind) buckets[kind].push(b.t - a.t);
  }
  return {
    sameFinger: ikiStats(buckets.sameFinger),
    sameHand: ikiStats(buckets.sameHand),
    crossHand: ikiStats(buckets.crossHand),
  };
}

// Mean interval by coarse transition class, over consecutive CORRECT pairs. Distinct from
// transitionStats in two ways the report's pace read-out wants: it keys on the LETTER (a→a is
// "same key", not merely "same finger"), and it reports the MEAN, so a few slow transitions
// still show their drag on the average rather than being hidden by the median.
export function transitionMeans(downs, alphabet) {
  const map = deriveFingerMap(alphabet);
  const buckets = { sameKey: [], sameHand: [], crossHand: [] };
  for (const [a, b] of correctPairs(downs)) {
    const dt = b.t - a.t;
    if (a.key === b.key) {
      buckets.sameKey.push(dt);
      continue;
    }
    const fa = map.get(a.key);
    const fb = map.get(b.key);
    if (!fa || !fb) continue;
    (fa.hand === fb.hand ? buckets.sameHand : buckets.crossHand).push(dt);
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  return {
    sameKey: { mean: mean(buckets.sameKey), count: buckets.sameKey.length },
    sameHand: { mean: mean(buckets.sameHand), count: buckets.sameHand.length },
    crossHand: { mean: mean(buckets.crossHand), count: buckets.crossHand.length },
  };
}

// ------------------------------------------------------- specific digraphs ----
// Median IKI for each specific ordered character transition (a→b), over consecutive correct
// pairs, sorted slowest-first. More diagnostic than the 3-bucket split, since with two hands
// most transitions are cross-hand and that bucket says little. `minCount` guards against
// ranking a single-sample digraph as "slowest".
export function digraphStats(downs, minCount = 1) {
  const groups = new Map();
  for (const [a, b] of correctPairs(downs)) {
    const key = `${a.key}\u0000${b.key}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b.t - a.t);
  }
  const out = [];
  for (const [key, vals] of groups) {
    if (vals.length < minCount) continue;
    const st = ikiStats(vals);
    const i = key.indexOf('\u0000');
    out.push({ a: key.slice(0, i), b: key.slice(i + 1), median: st.median, p90: st.p90, count: st.count });
  }
  out.sort((x, y) => y.median - x.median);
  return out;
}

// ------------------------------------------------------------- grid / Fitts ----
// GRID MODE movement analysis. For each consecutive pair of CORRECT selections, the pointer moved
// from the previous target cell to this one: distance D (in cell widths, since W = 1 cell), index
// of difficulty ID = log2(D/W + 1) = log2(D_cells + 1), and movement time MT = the inter-selection
// interval. An OLS fit MT = a + b·ID gives throughput = 1000/b bits/s (b is ms/bit), the number
// directly comparable to published mouse/trackpad Fitts figures and the 2× ceiling derivation
// (see bitrate-grid-mode-spec.md §5). Returns null for non-grid logs.
export function gridFitts(log) {
  const g = log.grid;
  if (!g || !g.enabled || !g.gridSize) return null;
  const { downs } = splitEvents(log);
  const gridSize = g.gridSize;
  const cellPx = g.cellPx || 1;
  const corr = correctSelections(downs);
  const rows = [];
  for (let k = 1; k < corr.length; k++) {
    const a = Number(corr[k - 1].key);
    const b = Number(corr[k].key);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const distCells = cellDistance(a, b, gridSize);
    if (distCells <= 0) continue; // a repeated target: no movement, undefined ID — skip
    rows.push({ mt: corr[k].t - corr[k - 1].t, id: Math.log2(distCells + 1), distCells, distPx: distCells * cellPx });
  }
  const nrows = rows.length;
  const mean = (sel) => (nrows ? rows.reduce((s, r) => s + sel(r), 0) / nrows : 0);
  const meanId = mean((r) => r.id);
  const meanMt = mean((r) => r.mt);
  const meanDistCells = mean((r) => r.distCells);
  // OLS slope/intercept of MT on ID
  let slope = 0;
  let intercept = meanMt;
  let r2 = 0;
  if (nrows >= 2) {
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (const r of rows) {
      const dx = r.id - meanId;
      const dy = r.mt - meanMt;
      sxx += dx * dx;
      sxy += dx * dy;
      syy += dy * dy;
    }
    if (sxx > 0) {
      slope = sxy / sxx;
      intercept = meanMt - slope * meanId;
      r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
    }
  }
  // Two throughput measures:
  //  - slope-based Fitts TP (1000/slope): the marginal ms-per-bit cost inverted. This is the number
  //    comparable to published figures, but within ONE run at a single grid size the ID range is
  //    narrow, so the slope (hence 1/slope) is noisy — trust it only when pooled across sizes and R²
  //    is decent. Used by the offline analyzer.
  //  - effective TP (mean ID / mean MT): the aggregate difficulty accomplished per second of
  //    movement. Stable and can't blow up, so it's the on-screen headline. Note B ≈ 2× this in a
  //    grid, which is the geometry's whole point (bits ~ log2 N, difficulty ~ ½ log2 N).
  const throughput = slope > 0 ? 1000 / slope : meanMt > 0 ? (meanId / meanMt) * 1000 : 0;
  const effectiveTp = meanMt > 0 ? (meanId / meanMt) * 1000 : 0;
  return { count: nrows, meanId, meanMt, meanDistCells, slopeMsPerBit: slope, interceptMs: intercept, r2, throughput, effectiveTp, rows };
}

// ---------------------------------------------------------------- histogram ----
export function histogram(values, binMs = 25, maxMs = 1000) {
  const nBins = Math.ceil(maxMs / binMs);
  const bins = new Array(nBins).fill(0);
  let overflow = 0;
  for (const v of values) {
    if (v >= maxMs) overflow++;
    else if (v >= 0) bins[Math.floor(v / binMs)]++;
  }
  const s = ikiStats(values);
  return { bins, binMs, maxMs, overflow, median: s.median, p90: s.p90, total: values.length };
}

// ----------------------------------------------------------------- misses ----
// Confusion pairs (target → pressed) for incorrect selections, ranked by count, plus a
// classification of where the errors concentrate. `idx` on an error row is the still-live
// target index (retry-until-correct doesn't advance on a miss), so sequence[idx] is truth.
export function confusion(downs, sequence, alphabet) {
  const map = deriveFingerMap(alphabet);
  const counts = new Map();
  let total = 0;
  let adjacent = 0;
  let sameHandWrongFinger = 0;
  for (const d of downs) {
    if (d.verdict !== 'err') continue;
    const target = sequence[d.idx];
    if (target === undefined) continue;
    const pressed = d.key;
    const key = `${target}\u0000${pressed}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total++;
    const ft = map.get(target);
    const fp = map.get(pressed);
    if (ft && fp) {
      if (Math.abs(ft.col - fp.col) === 1) adjacent++;
      if (ft.hand === fp.hand && ft.id !== fp.id) sameHandWrongFinger++;
    }
  }
  const pairs = [...counts.entries()]
    .map(([k, count]) => {
      const [target, pressed] = k.split('\u0000');
      return { target, pressed, count };
    })
    .sort((a, b) => b.count - a.count);
  return {
    pairs,
    total,
    adjacent,
    sameHandWrongFinger,
    adjacentShare: total > 0 ? adjacent / total : 0,
    sameHandShare: total > 0 ? sameHandWrongFinger / total : 0,
  };
}

// ------------------------------------------------------------- within-run ----
// Median IKI per quarter of the run window, bucketed by the LATER down's timestamp.
export function quartiles(downs, durationMs) {
  const q = durationMs / 4;
  const buckets = [[], [], [], []];
  for (let i = 1; i < downs.length; i++) {
    const t = downs[i].t;
    const bi = Math.min(3, Math.max(0, Math.floor(t / q)));
    buckets[bi].push(downs[i].t - downs[i - 1].t);
  }
  return buckets.map((vals, index) => ({ index, ...ikiStats(vals) }));
}

// Median IKI on the keystroke immediately following an error vs the baseline median (all
// consecutive-down IKIs). The two-loop prediction is that a shake inflates the post-error
// interval while a colour flash does not — this is the measurement that tests it.
export function postErrorSlowing(downs) {
  const baseline = ikiStats(ikiList(downs)).median;
  const post = [];
  for (let i = 1; i < downs.length; i++) {
    if (downs[i - 1].verdict === 'err') post.push(downs[i].t - downs[i - 1].t);
  }
  const p = ikiStats(post);
  return { baseline, postError: p.median, count: p.count };
}

// ------------------------------------------------------------- rollovers ----
// Count downs that land while another key is still physically held (the next key goes down
// before the previous comes up). Keyboard-only: it is defined by down/up PAIRS.
//
// Guard: a log with no 'up' events at all (every GRID MODE run — a click has no meaningful "still
// held" state) would otherwise leave `held` growing monotonically and count every down after the
// first as a rollover, reporting ~100 phantom rollovers per mouse run. Absent pairs = 0, not N-1.
export function countRollovers(log) {
  const cols = log.eventColumns;
  const tyi = cols.indexOf('type');
  const ki = cols.indexOf('key');
  if (!log.events.some((e) => e[tyi] === 'up')) return 0;
  const held = new Set();
  let rollovers = 0;
  for (const e of log.events) {
    const type = e[tyi];
    const key = e[ki];
    // physical key = symbol without its chord "*", so a down 'a*' pairs with an up 'a'
    const base = typeof key === 'string' && key.endsWith('*') ? key.slice(0, -1) : key;
    if (type === 'down') {
      if (held.size > 0) rollovers++;
      held.add(base);
    } else if (type === 'up') {
      held.delete(base);
    }
  }
  return rollovers;
}

// One-call bundle for the report screen: everything §3–§6 of the results-screen spec needs.
export function reportStats(log) {
  const { downs } = splitEvents(log);
  const alphabet = log.meta.config.alphabet ?? ''; // absent on grid runs — see deriveFingerMap
  const ik = ikiList(downs);
  return {
    downs,
    iki: ikiStats(ik),
    histogram: histogram(ik, 25, 1000),
    transitions: transitionStats(downs, alphabet),
    confusion: confusion(downs, log.sequence, alphabet),
  };
}

// ------------------------------------------------------ momentary bit rate ----
// The HUD's live number is CUMULATIVE — log2(N-1)·max(Sc-Si,0) divided by time since the run
// started — so it is recomputed every animation frame but converges and stops moving after the
// first few seconds. It cannot show a slump or a hot streak, because a bad ten seconds at t=50
// barely moves a sixty-second average. This computes the other thing: B over a sliding window,
// which is what actually has peaks and valleys.
//
// Negative values are kept rather than clamped. The run-level formula floors the whole run at
// zero, but within a window a stretch where errors outnumber corrects really did destroy bits, and
// hiding that would flatten exactly the valleys this chart exists to show.
//
// A window holding ~13 selections is a small sample, so some of the wobble in this curve is
// sampling noise rather than anything the player did. The report draws it without a confidence
// envelope and without prose interpreting the bumps — it shows the number and leaves the reading
// to the reader. (An earlier version drew a permutation band to separate the two; see git history
// if that question comes back.)

/** The scored events of a run as (time, delta) pairs: +1 for a correct selection, -1 for a miss. */
function scoredEvents(log) {
  const { downs } = splitEvents(log);
  const out = [];
  for (const d of downs) {
    if (d.verdict === 'ok') out.push({ t: d.t, delta: 1 });
    else if (d.verdict === 'err') out.push({ t: d.t, delta: -1 });
  }
  return out;
}

/** Sweep a centred TRIANGULAR window across the run. A box window counts whole events, so it
 *  steps by ±1 selection as its edge crosses one — a perfectly metronomic player comes out with a
 *  ~1 bit/s sawtooth at the sampling period, which would be the most visible feature on the chart
 *  and is an artifact of the filter rather than anything the player did. Weighting each event by
 *  its distance from the window centre removes that entirely.
 *
 *  Normalised by the AREA of the kernel, analytically, including where it is clipped by the start
 *  and end of the run: the first and last samples then sit at the right height but rest on fewer
 *  events, so they are noisier rather than biased — and the band widens there to say so. */
function sweepWindow(events, durationMs, logBits, windowMs, stepMs) {
  const samples = [];
  const half = windowMs / 2;
  let first = 0;
  for (let t = 0; t <= durationMs; t += stepMs) {
    const from = Math.max(0, t - half);
    const to = Math.min(durationMs, t + half);
    while (first < events.length && events[first].t < from) first++;
    let weighted = 0;
    for (let i = first; i < events.length && events[i].t <= to; i++) {
      weighted += events[i].delta * (1 - Math.abs(events[i].t - t) / half);
    }
    // ∫ of the clipped triangle, in ms: each side contributes L - L²/(2·half)
    const left = t - from;
    const right = to - t;
    const areaMs = left - (left * left) / (2 * half) + right - (right * right) / (2 * half);
    samples.push({ t, bps: areaMs > 0 ? (logBits * weighted) / (areaMs / 1000) : 0 });
  }
  return samples;
}

/** B over a sliding window. `windowMs` trades resolution against noise: at a ~600 ms cycle, 8 s
 *  holds about 13 selections. */
export function momentaryRate(log, windowMs = 8000, stepMs = 250) {
  const n = log.summary?.n ?? log.meta?.config?.n ?? 2;
  const logBits = Math.log2(Math.max(2, n) - 1);
  const durationMs = Math.round((log.summary?.elapsedS ?? 60) * 1000);
  return { windowMs, stepMs, samples: sweepWindow(scoredEvents(log), durationMs, logBits, windowMs, stepMs) };
}

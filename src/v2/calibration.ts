// Grid calibration — the pure half (no DOM). The interactive task that feeds it is in
// calibration-task.ts; between the two files there is no calibration code anywhere else.
//
// ═══ THE ALGORITHM, IN FULL ═══════════════════════════════════════════════════
// Input: ~20 click endpoints on a fixed 24×24 reference grid, each recorded as an offset (dx, dy)
// from the target cell's centre in CSS px, plus the movement time that preceded it.
//
//   1. DISCARD the first WARMUP_DISCARD clicks. The hand is still finding the surface.
//   2. REJECT endpoints further than 2 cells from centre — an attention lapse, not aim.
//   3. REJECT the slowest 10% by movement time. Hesitation inflates scatter.
//        (If fewer than MIN_SURVIVING survive 1–3, return null and ask for a recalibration.)
//   4. σ = RMS of the per-axis standard deviations: σ = sqrt((σx² + σy²) / 2).
//   5. We = 4.133·σ — the ISO 9241 effective target width, i.e. the width a target would need
//      for 96 % of clicks with this scatter to land inside it (±2.066σ of a Gaussian).
//   6. g_raw = (fieldPx / We) · 0.85 — how many cells of width We span the field, then a
//      cold-start factor biasing toward coarser cells.
//   7. Clamp so cells stay at least cellFloor px (a cell too small to see is not a target).
//   8. SNAP DOWN to the nearest entry of SNAP_GRIDS. Below the smallest → the smallest.
//
// Rounding coarse at 6 and 8 was deliberate: B(g) was assumed to be a plateau ending in a cliff,
// so a step too coarse costs a few percent while a step too fine falls off the accuracy cliff at
// double cost per error.
//
// ═══ WHAT THE MEASURED DATA SAYS ABOUT THIS ══════════════════════════════════
// Steps 5–6 assume σ is a FIXED property of hand and device, so that "the grid whose cells contain
// your scatter" names one particular grid. Reconstructing endpoint scatter from the scored-run
// pointer paths (every click, hit and miss, against the cell it aimed at) says otherwise:
//
//     cell 222px → σ 54.5px    cell 74px → σ 17.2px
//     cell 148px → σ 36.9px    cell 55px → σ 11.7px
//     cell 111px → σ 24.9px    cell 27px → σ  5.7px
//
// σ ≈ 0.22·cellPx across a 10× range of cell sizes: scatter is proportional to the target, not
// fixed against it. Substitute that into step 6 and it collapses:
//
//     g_raw = fieldPx / (4.133 · 0.22 · fieldPx/g) · 0.85 = g · 0.935
//
// The procedure is a MIRROR. It hands back the grid it was calibrated on, times a constant — and
// since that is always REFERENCE_GRID, the answer is pinned near 0.935 · 24 ≈ 22.4, which snaps
// down to 16. It is not measuring the player at all; everything that moves the recommendation off
// 16 is noise in the σ estimate. Six calibrations of the same hand on the same machine produced
// g_raw from 14.4 to 27.4 and recommendations of 12, 16, 16, 16, 16 and 24.
//
// It survives as-is because it lands in the right neighbourhood and its output barely matters:
// measured bit rate is flat within noise from 16² to 64² (12.4–13.0 bits/s). See README
// "Calibration: what it actually measures" before changing any constant here.

export const REFERENCE_GRID = 24; // the task's fixed grid, regardless of what's recommended
export const CALIB_CLICKS = 20; // total clicks
export const WARMUP_DISCARD = 4; // first N discarded as warm-up
export const SNAP_GRIDS = [12, 16, 24, 32, 48, 64] as const; // recommendation snaps DOWN to one of these
export const EFFECTIVE_WIDTH_COEF = 4.133; // ISO 9241 effective width We = 4.133·σ
export const COLD_START = 0.85; // scatter widens under scoring pressure; round toward coarser
const MIN_SURVIVING = 12; // fewer surviving samples → prompt to recalibrate
const MAX_ENDPOINT_CELLS = 2; // step 2: reject endpoints beyond this many cells from centre
const SLOWEST_FRACTION_CUT = 0.1; // step 3: reject this fraction, slowest movement times first

export interface CalibClick {
  t: number; // run-relative ms
  targetCell: number; // the highlighted reference-grid cell
  dx: number; // endpoint offset from the cell centre (px)
  dy: number;
  mtMs: number; // movement time (since the previous click)
}

export interface CalibrationResult {
  referenceGrid: number;
  clicks: CalibClick[];
  sigmaX: number;
  sigmaY: number;
  sigmaUsed: number; // pooled RMS of the two axes
  effectiveWidthPx: number;
  fittsA: number; // intercept (s)
  fittsB: number; // slope (s/bit)
  fittsR2: number; // fit quality — typically LOW (~0.05) at 20 clicks; treat the slope with suspicion
  impliedThroughput: number | null; // 1/b (bits/s); null when the slope is non-positive/unmeasurable
  recommendedGrid: number;
  chosenGrid: number; // differs if the player overrides
  overridden: boolean;
  pointerType: string;
  fieldPx: number;
  devicePixelRatio: number;
}

// Seeded PRNG (mulberry32) as a makeRandInt-style source, so every calibration's target script is
// identical and runs stay comparable.
export function seededRandInt(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n: number): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return Math.floor(r * n);
  };
}

// The scripted target cells: alternate long jumps (≥ ⅓ grid, varied directions) with occasional
// short ones. Long-jump endpoints predict scored-run scatter; near targets understate it. Seeded so
// every calibration is the same script.
export function generateCalibrationScript(referenceGrid = REFERENCE_GRID, count = CALIB_CLICKS, seed = 0x9e3779b9): number[] {
  const rnd = seededRandInt(seed);
  const g = referenceGrid;
  const minLong = Math.ceil(g / 3);
  const cells: number[] = [];
  let col = Math.floor(g / 2);
  let row = Math.floor(g / 2);
  cells.push(row * g + col);
  for (let i = 1; i < count; i++) {
    const long = i % 4 !== 0; // mostly long jumps; every 4th is short
    let nc = col;
    let nr = row;
    for (let tries = 0; tries < 48; tries++) {
      nc = rnd(g);
      nr = rnd(g);
      const d = Math.hypot(nc - col, nr - row);
      if (long ? d >= minLong : d >= 2 && d < minLong) break;
    }
    col = nc;
    row = nr;
    cells.push(row * g + col);
  }
  return cells;
}

function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}
function std(v: number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  let s = 0;
  for (const x of v) s += (x - m) ** 2;
  return Math.sqrt(s / (v.length - 1));
}
function ols(xs: number[], ys: number[]): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: ys.length ? mean(ys) : 0, r2: 0 };
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
  return { slope, intercept: my - slope * mx, r2: sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 0 };
}
function snapDown(g: number): number {
  let best: number = SNAP_GRIDS[0];
  for (const s of SNAP_GRIDS) if (s <= g) best = s;
  return best; // below 12 → 12
}

// ---- the algorithm, one exported step at a time ------------------------------
// Each step is its own function so it can be read, tested and argued with in isolation. The
// numbering matches the block comment at the top of this file.

/** Steps 1–3: warm-up discard, then the two rejections. Null when too little survives. */
export function surviveRejection(rawClicks: CalibClick[], cellPx: number): CalibClick[] | null {
  const measured = rawClicks.slice(WARMUP_DISCARD); // 1
  const byDistance = measured.filter((c) => Math.hypot(c.dx, c.dy) <= MAX_ENDPOINT_CELLS * cellPx); // 2
  const byTime = [...byDistance].sort((a, b) => a.mtMs - b.mtMs); // 3
  const keep = Math.max(1, Math.floor(byTime.length * (1 - SLOWEST_FRACTION_CUT)));
  const slowCut = byTime.length ? byTime[keep - 1].mtMs : Infinity;
  const surviving = byDistance.filter((c) => c.mtMs <= slowCut);
  return surviving.length < MIN_SURVIVING ? null : surviving;
}

export interface Scatter {
  sigmaX: number;
  sigmaY: number;
  sigmaUsed: number;
  effectiveWidthPx: number;
}

/** Steps 4–5: per-axis σ, pooled, then the ISO effective width. */
export function estimateScatter(clicks: CalibClick[]): Scatter {
  const sigmaX = std(clicks.map((c) => c.dx));
  const sigmaY = std(clicks.map((c) => c.dy));
  // Pool both axes (RMS) rather than max(σx,σy). With ~14 endpoints per axis, max() is the larger of
  // two noisy estimates and runs ~9% high (measured over 4000 simulated calibrations), which
  // silently biased every recommendation one notch coarser on top of the deliberate COLD_START.
  const sigmaUsed = Math.sqrt((sigmaX * sigmaX + sigmaY * sigmaY) / 2);
  return { sigmaX, sigmaY, sigmaUsed, effectiveWidthPx: EFFECTIVE_WIDTH_COEF * sigmaUsed };
}

export interface GridRecommendation {
  raw: number; // step 6, before any clamping — the unrounded solve
  cellFloorPx: number; // step 7's floor
  clamped: number; // after the floor
  grid: number; // step 8, the value actually recommended
}

/** Steps 6–8: solve for the grid whose cells are one effective width across, bias coarse, floor the
 *  cell size, snap down to the ladder. Every intermediate is returned so a surprising
 *  recommendation can be traced to the step that produced it rather than re-derived by hand. */
export function recommendGrid(effectiveWidthPx: number, fieldPx: number, devicePixelRatio: number): GridRecommendation {
  const raw = effectiveWidthPx > 0 ? (fieldPx / effectiveWidthPx) * COLD_START : SNAP_GRIDS[SNAP_GRIDS.length - 1];
  // A cell must survive being drawn: at least 10 CSS px, and at least 6 device px so gridlines and
  // the 2px outlines do not eat the whole target.
  const cellFloorPx = Math.max(10, 6 * devicePixelRatio);
  const clamped = Math.min(raw, fieldPx / cellFloorPx);
  // SNAP_GRIDS tops out at 64, so "an absurdly good calibration caps at 64" needs no separate clamp.
  return { raw, cellFloorPx, clamped, grid: snapDown(clamped) };
}

export interface CalibComputeOpts {
  fieldPx: number;
  referenceGrid: number;
  devicePixelRatio: number;
  pointerType: string;
}

// Run the σ pipeline + recommendation. Returns null when too few samples survive rejection (the
// caller then prompts to recalibrate).
export function computeCalibration(rawClicks: CalibClick[], opts: CalibComputeOpts): CalibrationResult | null {
  const cellPx = opts.fieldPx / opts.referenceGrid;

  // steps 1–3
  const surviving = surviveRejection(rawClicks, cellPx);
  if (!surviving) return null;
  // steps 4–5
  const { sigmaX, sigmaY, sigmaUsed, effectiveWidthPx } = estimateScatter(surviving);
  // The distance-filtered set is needed again below for the Fitts fit, without the slow-MT cut.
  const byDist = rawClicks.slice(WARMUP_DISCARD).filter((c) => Math.hypot(c.dx, c.dy) <= MAX_ENDPOINT_CELLS * cellPx);

  // Fitts profile: D = previous target centre → this one, W = cellPx. Fitted over the
  // DISTANCE-filtered set only — the slow-MT cut above exists to clean the scatter estimate, but it
  // removes the slowest clicks, which are disproportionately the highest-ID ones; applying it here
  // truncates the dependent variable and routinely flips the slope negative.
  const g = opts.referenceGrid;
  const centre = (cell: number): { x: number; y: number } => ({ x: ((cell % g) + 0.5) * cellPx, y: (Math.floor(cell / g) + 0.5) * cellPx });
  const fitSet = new Set(byDist);
  const ids: number[] = [];
  const mts: number[] = [];
  for (let i = 1; i < rawClicks.length; i++) {
    if (!fitSet.has(rawClicks[i])) continue;
    const a = centre(rawClicks[i - 1].targetCell);
    const b = centre(rawClicks[i].targetCell);
    const D = Math.hypot(b.x - a.x, b.y - a.y);
    if (D <= 0) continue;
    ids.push(Math.log2(D / cellPx + 1));
    mts.push(rawClicks[i].mtMs / 1000);
  }
  const { slope: fittsB, intercept: fittsA, r2: fittsR2 } = ols(ids, mts);
  // null, not 0: ~20 clicks over a narrow ID span often cannot support a slope at all, and a
  // non-positive slope is an absent measurement — reporting it as "0 bits/s" reads like a result.
  const impliedThroughput = fittsB > 0 ? 1 / fittsB : null;

  // steps 6–8
  const { grid: recommendedGrid } = recommendGrid(effectiveWidthPx, opts.fieldPx, opts.devicePixelRatio);

  return {
    referenceGrid: opts.referenceGrid,
    clicks: rawClicks,
    sigmaX: round1(sigmaX),
    sigmaY: round1(sigmaY),
    sigmaUsed: round1(sigmaUsed),
    effectiveWidthPx: round1(effectiveWidthPx),
    fittsA: round3(fittsA),
    fittsB: round3(fittsB),
    fittsR2: round3(fittsR2),
    impliedThroughput: impliedThroughput === null ? null : round1(impliedThroughput),
    recommendedGrid,
    chosenGrid: recommendedGrid,
    overridden: false,
    pointerType: opts.pointerType,
    fieldPx: Math.round(opts.fieldPx),
    devicePixelRatio: opts.devicePixelRatio,
  };
}

// NOTE: there is deliberately no trackpad detector. The previous heuristic compared σ in absolute
// px to a fixed 10px threshold, but σ scales with the field size — on a large window it labelled an
// excellent mouse user (σ = 0.28 cells) a trackpad, and the same hand on a small window passed. And
// PointerEvent.pointerType reports "mouse" for trackpads too, so it cannot separate them either. A
// false "you're on a trackpad" misinforms more than silence does; the coarser recommendation that
// genuinely poor precision produces is already the useful signal.

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

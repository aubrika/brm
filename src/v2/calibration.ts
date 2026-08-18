// Grid calibration — the pure half (no DOM). The interactive task that feeds it is in
// calibration-task.ts; between the two files there is no calibration code anywhere else.
//
// ═══ WHY v2 LOOKS FOR A KNEE ═════════════════════════════════════════════════
// v1 measured endpoint scatter σ, turned it into an ISO effective width We = 4.133·σ, and solved
// fieldPx/We for "the grid whose cells contain your scatter". The sweep data killed the premise
// twice over. Scatter is not a fixed property of the hand — it is ~0.23·cellPx at every cell size,
// which makes that solve degenerate (it hands back the grid it was calibrated on). And the failure
// mode it guards against never happens: players do not miss more on fine grids, they hold accuracy
// roughly constant and pay in TIME.
//
// Under constant accuracy, ideal Fitts behaviour says bit rate keeps rising with grid size toward
// an asymptote — so the measured falloff at fine grids comes from something the law does not
// cover. Below some cell size, particular to a player and a device, click times inflate faster
// than the Fitts trend: tremor floor, click-induced cursor displacement, sub-movement corrections,
// visual confirmation of a tiny cell.
//
// So the optimum is the KNEE: the finest grid where click times still sit on the player's own
// Fitts line. v2 measures the line, tests for the departure, and places the player at the knee.
//
// ═══ THE v2 ALGORITHM, IN FULL ═══════════════════════════════════════════════
// Two blocks on the real game surface: A at 16×16 (4 warm-up + 12 measured), B at 64×64
// (2 warm-up + 12 measured). Each click records movement time, the target it aimed at, and the
// endpoint offset. Distance D is previous target centre → this target centre, so the warm-up
// clicks also serve as the anchor for the first measured one.
//
//   1. REJECT endpoints beyond 2 cells (an attention lapse, not aim) everywhere; additionally drop
//      the slowest 10% FROM THE FIT ONLY. The slow cut exists to keep a hesitation out of the
//      regression — applying it to block B would discard exactly the slow clicks the departure
//      test is trying to detect. Both medians are robust, so B keeps its slow tail.
//      Fewer than MIN_SURVIVING_PER_BLOCK left in either block → return null, prompt to redo.
//   2. FIT the line on BLOCK A ONLY: ID = log2(D/W_A + 1), OLS of MT (seconds) on ID → a, b, R².
//      b ≤ 0 or R² < MIN_FIT_R2 means the fit is noise, not a person → fall back to the v1 σ rule
//      and record method: "sigma-fallback".
//   3. DEPARTURE: predict each block-B click from that line at its own ID (using W_B), and take
//      r = median(observed MT) / median(predicted MT). r ≈ 1 means B is still on the line; r > 1 is
//      the inflation the knee is made of.
//   4. SCORE each candidate grid g:
//        T(g)    = a + b·log2(MEAN_DISTANCE_FRACTION·g + 1)     baseline time, seconds
//        infl(W) = 1 for W ≥ W_A, else 1 + (r−1)·log(W_A/W)/log(W_A/W_B), clamped ≥ 1
//        B_est   = log2(g² − 1) · (2p̂ − 1) / (T(g) · infl(W))
//      Linear-in-log-width is all two measured widths support; no curve shape is extrapolated from
//      two points. p̂ is pooled accuracy across both blocks — expected high and flat, which is the
//      finding v2 rests on. If block B's accuracy falls more than ACCURACY_DIVERGENCE below block
//      A's, the player is NOT holding accuracy constant, and p̂ is interpolated per candidate the
//      same way inflation is rather than pooled flat.
//   5. RECOMMEND argmax(B_est), then step one candidate COARSER (the plateau is flat on the coarse
//      side and a cliff on the fine side, so the cheap error is the coarse one), then apply the
//      pixel floor.
//
// v1's σ pipeline below is kept in full: it is the fallback when the fit is unusable, and σ is
// still computed and logged for every run either way.

export const SNAP_GRIDS = [12, 16, 24, 32, 48, 64] as const; // recommendation snaps DOWN to one of these
export const EFFECTIVE_WIDTH_COEF = 4.133; // ISO 9241 effective width We = 4.133·σ
export const COLD_START = 0.85; // scatter widens under scoring pressure; round toward coarser

// ---- v2 ----
export const BLOCK_A_GRID = 16; // coarse reference — the Fitts line is fitted here
export const BLOCK_B_GRID = 64; // fine reference — the departure is measured here
export const BLOCK_A_WARMUP = 4;
export const WARMUP_DISCARD = BLOCK_A_WARMUP; // the σ fallback reads block A, so it shares its warm-up
export const BLOCK_B_WARMUP = 2;
export const BLOCK_MEASURED = 12; // measured clicks per block
export const MIN_SURVIVING_PER_BLOCK = 9;
// The σ fallback runs on block A, so its floor must match block A's size: 12 measured clicks minus
// the slowest 10% leaves 10. The old value of 12 was sized for v1's 20-click block and made the
// fallback impossible to satisfy under the v2 protocol — every calibration failed outright.
const MIN_SURVIVING = MIN_SURVIVING_PER_BLOCK;
export const MIN_FIT_R2 = 0.15; // below this the block-A regression is noise, not a person
export const MEAN_DISTANCE_FRACTION = 0.52; // mean jump as a fraction of the field, for T(g)
export const ACCURACY_DIVERGENCE = 0.1; // block B this far below block A ⇒ accuracy is NOT flat
export const JUMP_MIN = 0.2; // scripted jump length, as a fraction of the field
export const JUMP_MAX = 0.9;
export const CANDIDATE_GRIDS = SNAP_GRIDS; // the grids B_est is evaluated over
const MAX_ENDPOINT_CELLS = 2; // step 2: reject endpoints beyond this many cells from centre
const SLOWEST_FRACTION_CUT = 0.1; // step 3: reject this fraction, slowest movement times first

export interface CalibClick {
  t: number; // run-relative ms
  targetCell: number; // the highlighted cell, in ITS OWN block's grid
  dx: number; // endpoint offset from the cell centre (px)
  dy: number;
  mtMs: number; // movement time (since the previous click)
  block?: 'A' | 'B'; // which reference block; absent on v1-era logs
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

function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}
function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
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


// ============================================================================
// v2 — knee detection
// ============================================================================

/** One block's scripted targets. Jumps are held between JUMP_MIN and JUMP_MAX of the field so the
 *  block spans a real range of difficulty — a regression needs the spread, and a block of uniform
 *  jumps would fit a slope through nothing. Seeded, so every calibration runs the same script. */
export function generateBlockScript(gridSize: number, count: number, seed: number): number[] {
  const rnd = seededRandInt(seed);
  const minCells = Math.max(1, Math.round(JUMP_MIN * gridSize));
  const maxCells = Math.max(minCells + 1, Math.round(JUMP_MAX * gridSize));
  const cells: number[] = [];
  let col = Math.floor(gridSize / 2);
  let row = Math.floor(gridSize / 2);
  cells.push(row * gridSize + col);
  for (let i = 1; i < count; i++) {
    let nc = col;
    let nr = row;
    for (let tries = 0; tries < 64; tries++) {
      nc = rnd(gridSize);
      nr = rnd(gridSize);
      const d = Math.hypot(nc - col, nr - row);
      if (d >= minCells && d <= maxCells) break;
    }
    col = nc;
    row = nr;
    cells.push(row * gridSize + col);
  }
  return cells;
}

/** One measured click, with the geometry the fit needs already resolved. */
export interface BlockClick {
  mtMs: number;
  distancePx: number; // previous target centre → this target centre
  id: number; // log2(D/W + 1) at this block's width
  hit: boolean; // landed inside the target cell
  offsetPx: number; // radial endpoint error, for the outlier rule
}

export interface BlockSummary {
  gridSize: number;
  w: number; // cell width px
  clicks: BlockClick[]; // measured, endpoint-outlier rejected
  fitClicks: BlockClick[]; // the above, minus the slowest 10% — the regression set
  accuracy: number; // over `clicks`
  medianMtMs: number;
}

function centreOf(cell: number, gridSize: number, w: number): { x: number; y: number } {
  return { x: ((cell % gridSize) + 0.5) * w, y: (Math.floor(cell / gridSize) + 0.5) * w };
}

/** Resolve one block's raw clicks into fit-ready geometry. `raw` must be the whole block in order,
 *  warm-up first: the last warm-up click is what the first measured click's distance is measured
 *  from. Null when too few survive the endpoint-outlier rule. */
export function summariseBlock(raw: CalibClick[], gridSize: number, fieldPx: number, warmup: number): BlockSummary | null {
  const w = fieldPx / gridSize;
  const clicks: BlockClick[] = [];
  for (let i = Math.max(1, warmup); i < raw.length; i++) {
    const from = centreOf(raw[i - 1].targetCell, gridSize, w);
    const to = centreOf(raw[i].targetCell, gridSize, w);
    const distancePx = Math.hypot(to.x - from.x, to.y - from.y);
    if (distancePx <= 0) continue;
    const offsetPx = Math.hypot(raw[i].dx, raw[i].dy);
    // Endpoint outliers are rejected in BOTH blocks: a click two cells off target is an attention
    // lapse, and its movement time describes nothing about aim at this width.
    if (offsetPx > MAX_ENDPOINT_CELLS * w) continue;
    clicks.push({
      mtMs: raw[i].mtMs,
      distancePx,
      id: Math.log2(distancePx / w + 1),
      hit: Math.abs(raw[i].dx) <= w / 2 && Math.abs(raw[i].dy) <= w / 2,
      offsetPx,
    });
  }
  if (clicks.length < MIN_SURVIVING_PER_BLOCK) return null;

  // The slow cut applies to the FIT set only. Block B's slow tail is the signal the departure test
  // is looking for; trimming it there would measure away the thing being measured.
  const byTime = [...clicks].sort((a, b) => a.mtMs - b.mtMs);
  const keep = Math.max(1, Math.floor(byTime.length * (1 - SLOWEST_FRACTION_CUT)));
  const slowCut = byTime[keep - 1].mtMs;
  return {
    gridSize,
    w,
    clicks,
    fitClicks: clicks.filter((c) => c.mtMs <= slowCut),
    accuracy: clicks.filter((c) => c.hit).length / clicks.length,
    medianMtMs: median(clicks.map((c) => c.mtMs)),
  };
}

export interface FittsLine {
  a: number; // intercept, SECONDS
  b: number; // slope, seconds per bit
  r2: number;
  n: number;
}

/** Step 2: the player's own speed-vs-difficulty line, from block A. */
export function fitFittsLine(block: BlockSummary): FittsLine {
  const { slope, intercept, r2 } = ols(block.fitClicks.map((c) => c.id), block.fitClicks.map((c) => c.mtMs / 1000));
  return { a: intercept, b: slope, r2, n: block.fitClicks.length };
}

/** Is this line usable, or is it noise wearing a slope? */
export function lineIsUsable(line: FittsLine): boolean {
  return line.b > 0 && line.r2 >= MIN_FIT_R2;
}

/** Step 3: how much slower block B ran than its own predicted times. Medians, so one wild click
 *  cannot set the recommendation. */
export function inflationRatio(line: FittsLine, blockB: BlockSummary): number {
  const predicted = blockB.clicks.map((c) => (line.a + line.b * c.id) * 1000);
  const medPred = median(predicted);
  return medPred > 0 ? blockB.medianMtMs / medPred : 1;
}

export interface CandidateEstimate {
  grid: number;
  w: number;
  baselineS: number; // T(g)
  inflation: number; // infl(W(g))
  accuracy: number; // p̂ used for this candidate
  bEst: number;
}

/** Step 4: B_est across the candidate grids. */
export function estimateCandidates(
  line: FittsLine,
  r: number,
  blockA: BlockSummary,
  blockB: BlockSummary,
  fieldPx: number,
): CandidateEstimate[] {
  const wA = blockA.w;
  const wB = blockB.w;
  const pooled = (blockA.accuracy * blockA.clicks.length + blockB.accuracy * blockB.clicks.length) / (blockA.clicks.length + blockB.clicks.length);
  // Flat accuracy is the expected case and the finding v2 rests on. Only when block B is clearly
  // worse does accuracy become a per-candidate term rather than one pooled number.
  const diverged = blockA.accuracy - blockB.accuracy > ACCURACY_DIVERGENCE;
  const logSpan = Math.log(wA / wB);

  return (CANDIDATE_GRIDS as readonly number[]).map((grid) => {
    const w = fieldPx / grid;
    const frac = w >= wA || logSpan <= 0 ? 0 : Math.log(wA / w) / logSpan;
    const inflation = Math.max(1, 1 + (r - 1) * frac);
    const accuracy = diverged ? blockA.accuracy + (blockB.accuracy - blockA.accuracy) * frac : pooled;
    const baselineS = line.a + line.b * Math.log2(MEAN_DISTANCE_FRACTION * grid + 1);
    const bits = Math.log2(grid * grid - 1);
    const bEst = baselineS > 0 ? (bits * (2 * accuracy - 1)) / (baselineS * inflation) : 0;
    return { grid, w, baselineS, inflation, accuracy, bEst };
  });
}

/** Step 5: argmax, one step coarser, then the pixel floor. */
export function recommendKnee(candidates: CandidateEstimate[], fieldPx: number, devicePixelRatio: number): { grid: number; argmaxGrid: number; cellFloorPx: number } {
  const ladder = CANDIDATE_GRIDS as readonly number[];
  let best = candidates[0];
  for (const c of candidates) if (c.bEst > best.bEst) best = c;
  const at = ladder.indexOf(best.grid);
  // One candidate coarser: B(g) is a plateau on the coarse side and a cliff on the fine side, so
  // the cheap direction to be wrong in is coarse.
  const stepped = ladder[Math.max(0, at - 1)];
  const cellFloorPx = Math.max(10, 6 * devicePixelRatio);
  let grid = stepped;
  while (grid > ladder[0] && fieldPx / grid < cellFloorPx) grid = ladder[ladder.indexOf(grid) - 1];
  return { grid, argmaxGrid: best.grid, cellFloorPx };
}

export interface CalibrationV2 {
  blockA: { w: number; gridSize: number; n: number; accuracy: number; medianMt: number; fittsA: number; fittsB: number; r2: number };
  blockB: { w: number; gridSize: number; n: number; accuracy: number; medianMt: number; medianPredictedMt: number };
  inflationRatio: number;
  pooledAccuracy: number;
  bEstByCandidate: Record<string, number>;
  method: 'knee' | 'sigma-fallback';
  recommendedGrid: number;
  chosenGrid: number;
  overridden: boolean;
}

/** The whole v2 pipeline. `sigmaFallbackGrid` is v1's recommendation, used when the block-A fit is
 *  unusable. Null when either block lost too many clicks to say anything. */
export function computeKnee(
  rawA: CalibClick[],
  rawB: CalibClick[],
  opts: { fieldPx: number; devicePixelRatio: number; sigmaFallbackGrid: number },
): { v2: CalibrationV2; candidates: CandidateEstimate[] } | null {
  const blockA = summariseBlock(rawA, BLOCK_A_GRID, opts.fieldPx, BLOCK_A_WARMUP);
  const blockB = summariseBlock(rawB, BLOCK_B_GRID, opts.fieldPx, BLOCK_B_WARMUP);
  if (!blockA || !blockB) return null;

  const line = fitFittsLine(blockA);
  const usable = lineIsUsable(line);
  const r = usable ? inflationRatio(line, blockB) : 1;
  const candidates = usable ? estimateCandidates(line, r, blockA, blockB, opts.fieldPx) : [];
  const knee = usable ? recommendKnee(candidates, opts.fieldPx, opts.devicePixelRatio) : null;
  const recommendedGrid = knee ? knee.grid : opts.sigmaFallbackGrid;

  const predicted = blockB.clicks.map((c) => (line.a + line.b * c.id) * 1000);
  const bEstByCandidate: Record<string, number> = {};
  for (const c of candidates) bEstByCandidate[String(c.grid)] = round3(c.bEst);

  return {
    candidates,
    v2: {
      blockA: {
        w: round1(blockA.w), gridSize: blockA.gridSize, n: blockA.clicks.length,
        accuracy: round3(blockA.accuracy), medianMt: Math.round(blockA.medianMtMs),
        fittsA: round3(line.a), fittsB: round3(line.b), r2: round3(line.r2),
      },
      blockB: {
        w: round1(blockB.w), gridSize: blockB.gridSize, n: blockB.clicks.length,
        accuracy: round3(blockB.accuracy), medianMt: Math.round(blockB.medianMtMs),
        medianPredictedMt: Math.round(median(predicted)),
      },
      inflationRatio: round3(r),
      pooledAccuracy: round3(
        (blockA.accuracy * blockA.clicks.length + blockB.accuracy * blockB.clicks.length) / (blockA.clicks.length + blockB.clicks.length),
      ),
      bEstByCandidate,
      method: usable ? 'knee' : 'sigma-fallback',
      recommendedGrid,
      chosenGrid: recommendedGrid,
      overridden: false,
    },
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

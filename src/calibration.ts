// Grid calibration (see bitrate-calibration-spec.md). ~20 clicks on a 24×24 reference grid measure
// the player's endpoint scatter σ (px on this machine/device), from which we size the scored grid
// so its cells contain that scatter. This module is the pure part: the seeded target script and the
// σ → recommended-grid math. Click capture + rendering live in app.ts (on the real game surface).

export const REFERENCE_GRID = 24; // the task's fixed grid, regardless of what's recommended
export const CALIB_CLICKS = 20; // total clicks
export const WARMUP_DISCARD = 4; // first N discarded as warm-up
const SNAP_GRIDS = [12, 16, 24, 32, 48, 64] as const; // recommendation snaps DOWN to one of these
const EFFECTIVE_WIDTH_COEF = 4.133; // ISO 9241 effective width We = 4.133·σ
const COLD_START = 0.85; // scatter widens under scoring pressure; round toward coarser
const MIN_SURVIVING = 12; // fewer surviving samples → prompt to recalibrate

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
  sigmaUsed: number;
  effectiveWidthPx: number;
  fittsA: number; // intercept (s)
  fittsB: number; // slope (s/bit)
  impliedThroughput: number; // 1/b (bits/s)
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
function ols(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: ys.length ? mean(ys) : 0 };
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i] - my);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  return { slope, intercept: my - slope * mx };
}
function snapDown(g: number): number {
  let best: number = SNAP_GRIDS[0];
  for (const s of SNAP_GRIDS) if (s <= g) best = s;
  return best; // below 12 → 12
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
  const measured = rawClicks.slice(WARMUP_DISCARD);

  // outlier rejection: > 2 cells from centre, then the slowest 10% by movement time
  let surviving = measured.filter((c) => Math.hypot(c.dx, c.dy) <= 2 * cellPx);
  const sortedMt = [...surviving].sort((a, b) => a.mtMs - b.mtMs);
  const keep = Math.max(1, Math.floor(sortedMt.length * 0.9));
  const slowCut = sortedMt.length ? sortedMt[keep - 1].mtMs : Infinity;
  surviving = surviving.filter((c) => c.mtMs <= slowCut);
  if (surviving.length < MIN_SURVIVING) return null;

  const sigmaX = std(surviving.map((c) => c.dx));
  const sigmaY = std(surviving.map((c) => c.dy));
  const sigmaUsed = Math.max(sigmaX, sigmaY); // square grid — the worse axis governs
  const effectiveWidthPx = EFFECTIVE_WIDTH_COEF * sigmaUsed;

  // Fitts profile over surviving clicks: D = prev target centre → this, W = cellPx.
  const g = opts.referenceGrid;
  const centre = (cell: number): { x: number; y: number } => ({ x: ((cell % g) + 0.5) * cellPx, y: (Math.floor(cell / g) + 0.5) * cellPx });
  const survivingSet = new Set(surviving);
  const ids: number[] = [];
  const mts: number[] = [];
  for (let i = 1; i < rawClicks.length; i++) {
    if (!survivingSet.has(rawClicks[i])) continue;
    const a = centre(rawClicks[i - 1].targetCell);
    const b = centre(rawClicks[i].targetCell);
    const D = Math.hypot(b.x - a.x, b.y - a.y);
    if (D <= 0) continue;
    ids.push(Math.log2(D / cellPx + 1));
    mts.push(rawClicks[i].mtMs / 1000);
  }
  const { slope: fittsB, intercept: fittsA } = ols(ids, mts);
  const impliedThroughput = fittsB > 0 ? 1 / fittsB : 0;

  // recommendation: fieldPx / We, cold-start factor, cell-size floor, snap down; cap at 64
  let gRaw = effectiveWidthPx > 0 ? (opts.fieldPx / effectiveWidthPx) * COLD_START : 64;
  const cellFloor = Math.max(10, 3 * opts.devicePixelRatio * 2);
  gRaw = Math.min(gRaw, opts.fieldPx / cellFloor);
  let recommendedGrid = snapDown(gRaw);
  if (sigmaUsed < 2) recommendedGrid = Math.min(recommendedGrid, 64); // lucky tiny σ → cap at 64

  return {
    referenceGrid: opts.referenceGrid,
    clicks: rawClicks,
    sigmaX: round1(sigmaX),
    sigmaY: round1(sigmaY),
    sigmaUsed: round1(sigmaUsed),
    effectiveWidthPx: round1(effectiveWidthPx),
    fittsA: round3(fittsA),
    fittsB: round3(fittsB),
    impliedThroughput: round1(impliedThroughput),
    recommendedGrid,
    chosenGrid: recommendedGrid,
    overridden: false,
    pointerType: opts.pointerType,
    fieldPx: Math.round(opts.fieldPx),
    devicePixelRatio: opts.devicePixelRatio,
  };
}

// A trackpad-ish profile (unreliable pointerType → infer from the measurement): high scatter or a
// steep Fitts slope. Used only for an advisory note, never the recommendation.
export function looksLikeTrackpad(c: CalibrationResult): boolean {
  return c.sigmaUsed > 10 || c.fittsB > 0.25;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

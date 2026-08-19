// Cell arithmetic for GRID MODE. Plain JS ESM for the same reason core/stats.js is: it is imported
// by BOTH the browser (the renderer, which uses it on every click and every frame) AND Node (the
// offline analyzer), and one implementation means the two can never disagree.
//
// That is not a hypothetical. This module exists because the same functions had been written three
// times — cellIndexAt in v2/view.ts, an identical cellOfXY in scripts/analyze.mjs, and the col/row
// split inlined again in stats.js and reportview.ts. The game decides correct-vs-error with this
// arithmetic and the analyzer re-derives which cell a pointer sample was in with the same
// arithmetic; if the two ever drifted, every dwell and accuracy number would quietly stop
// describing the game that produced it.
//
// A cell index is row-major: `row * gridSize + col`, matching the engine's sequence and the event
// log's `key` column. Everything here is pure — no DOM, no clock, no state.

/** Column (x) of a cell index. */
export function colOf(cell, gridSize) {
  return cell % gridSize;
}

/** Row (y) of a cell index. */
export function rowOf(cell, gridSize) {
  return Math.floor(cell / gridSize);
}

/** Centre of a cell in field-local pixels — the point a player is aiming at, and the point every
 *  Fitts distance is measured between. */
export function cellCentre(cell, gridSize, cellPx) {
  return { x: (colOf(cell, gridSize) + 0.5) * cellPx, y: (rowOf(cell, gridSize) + 0.5) * cellPx };
}

/** Field-local px → cell index, or -1 outside the grid. THE hit test: this call is what makes a
 *  click correct or an error, so it is the one piece of arithmetic in the project that must mean
 *  exactly the same thing at play time and at analysis time. */
export function cellIndexAt(x, y, cellPx, gridSize) {
  const col = Math.floor(x / cellPx);
  const row = Math.floor(y / cellPx);
  if (col < 0 || col >= gridSize || row < 0 || row >= gridSize) return -1;
  return row * gridSize + col;
}

/** Chebyshev (king-move) distance in cells — "is the next target within a couple of cells", which
 *  is how ghost adjacency is flagged. */
export function cellsApart(a, b, gridSize) {
  return Math.max(Math.abs(colOf(a, gridSize) - colOf(b, gridSize)), Math.abs(rowOf(a, gridSize) - rowOf(b, gridSize)));
}

/** Euclidean distance in cells — the D in Fitts' ID = log2(D/W + 1), where W is one cell. */
export function cellDistance(a, b, gridSize) {
  return Math.hypot(colOf(a, gridSize) - colOf(b, gridSize), rowOf(a, gridSize) - rowOf(b, gridSize));
}

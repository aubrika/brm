// Type surface for the plain-JS grid arithmetic (grid.js). TypeScript callers import from
// './grid.js' and resolve to these declarations; Node imports the .js directly and needs no types.
// The runtime file is grid.js — keep the two in sync by hand (the API is six functions).

/** Column (x) of a cell index, row-major. */
export function colOf(cell: number, gridSize: number): number;

/** Row (y) of a cell index, row-major. */
export function rowOf(cell: number, gridSize: number): number;

/** Centre of a cell in field-local pixels. */
export function cellCentre(cell: number, gridSize: number, cellPx: number): { x: number; y: number };

/** Field-local px → cell index, or -1 outside the grid. The hit test. */
export function cellIndexAt(x: number, y: number, cellPx: number, gridSize: number): number;

/** Chebyshev (king-move) distance in cells. */
export function cellsApart(a: number, b: number, gridSize: number): number;

/** Euclidean distance in cells — the D in Fitts' ID = log2(D/W + 1). */
export function cellDistance(a: number, b: number, gridSize: number): number;

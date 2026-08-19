// Dev-only auto-player for the grid game, reached with ?auto=practice|scored&demo. It exists so a
// full run → report can be driven headlessly, which is how every layout and geometry check in this
// project is made: a screenshot of a real run beats reasoning about a render. (v1's equivalent is
// v1/demo.ts, which lives with the game it drives.)
//
// It drives the SAME input path a human does — real PointerEvents dispatched at the canvas. Nothing
// here calls into an engine directly. A demo that scored by poking engine state would exercise a
// code path that ships to nobody, and would not catch, say, a hit test that is off by a cell.

import type { GridEngine } from '../v2/engine.js';
import type { GridRenderer } from '../v2/view.js';
import { cellCentre } from '../core/grid.js';

/** Keep clicking while this returns a live view; the caller ends the demo by returning null. */
export type GridDemoSource = () => { engine: GridEngine; view: GridRenderer } | null;

const GRID_ERROR_RATE = 0.05; // an adjacent miss now and then, so error handling is exercised too

/** Click the current target's centre, with an occasional deliberate miss. */
export function startGridDemo(source: GridDemoSource): void {
  const tick = (): void => {
    const live = source();
    if (!live) return;
    const { engine, view } = live;
    let cell = engine.target();
    if (Math.random() < GRID_ERROR_RATE) cell = (cell + 1) % engine.cells;
    const r = view.element.getBoundingClientRect();
    const c = cellCentre(cell, engine.gridSize, view.cellPx);
    const opts: PointerEventInit = {
      clientX: r.left + c.x,
      clientY: r.top + c.y,
      bubbles: true,
      pointerType: 'mouse',
    };
    view.element.dispatchEvent(new PointerEvent('pointermove', opts));
    view.element.dispatchEvent(new PointerEvent('pointerdown', opts));
    window.setTimeout(tick, 90 + Math.random() * 60);
  };
  window.setTimeout(tick, 200);
}

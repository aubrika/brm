// Dev-only auto-players, reached with ?auto=practice|scored&demo. They exist so a full
// run → report can be driven headlessly, which is how every layout and geometry check in this
// project is made: a screenshot of a real run beats reasoning about a render.
//
// Both drive the SAME input path a human does — the grid driver dispatches real PointerEvents at
// the canvas, the keyboard driver dispatches real KeyboardEvents at the window. Nothing here calls
// into an engine directly. A demo that scored by poking engine state would exercise a code path
// that ships to nobody and would not catch, say, a hit-test that is off by a cell.

import type { GridEngine } from '../v2/engine.js';
import type { Engine } from '../v1/engine.js';
import type { GridRenderer } from '../v2/view.js';

/** Keep ticking while this returns a live view; the caller ends the demo by returning null. */
export type GridDemoSource = () => { engine: GridEngine; view: GridRenderer } | null;
export type KeyDemoSource = () => Engine | null;

const GRID_ERROR_RATE = 0.05; // an adjacent miss now and then, so error handling is exercised too
const KEY_ERROR_RATE = 0.06;

/** GRID MODE: click the current target's centre, with an occasional deliberate miss. */
export function startGridDemo(source: GridDemoSource): void {
  const tick = (): void => {
    const live = source();
    if (!live) return;
    const { engine, view } = live;
    let cell = engine.target();
    if (Math.random() < GRID_ERROR_RATE) cell = (cell + 1) % engine.cells;
    const r = view.element.getBoundingClientRect();
    const opts: PointerEventInit = {
      clientX: r.left + ((cell % engine.gridSize) + 0.5) * view.cellPx,
      clientY: r.top + (Math.floor(cell / engine.gridSize) + 0.5) * view.cellPx,
      bubbles: true,
      pointerType: 'mouse',
    };
    view.element.dispatchEvent(new PointerEvent('pointermove', opts));
    view.element.dispatchEvent(new PointerEvent('pointerdown', opts));
    window.setTimeout(tick, 90 + Math.random() * 60);
  };
  window.setTimeout(tick, 200);
}

/** v1: type the falling target, with an occasional wrong key from the same alphabet. */
export function startKeyboardDemo(source: KeyDemoSource): void {
  const tick = (): void => {
    const engine = source();
    if (!engine) return;
    let key = engine.target();
    if (Math.random() < KEY_ERROR_RATE) {
      const others = engine.chars.filter((c: string) => c !== key);
      key = others[Math.floor(Math.random() * others.length)] ?? key;
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    window.setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true })), 30);
    window.setTimeout(tick, 70 + Math.random() * 80);
  };
  window.setTimeout(tick, 200);
}

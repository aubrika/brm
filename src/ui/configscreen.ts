// The config screen contract, and the grid game's screen. A config screen is a pure view function:
// it takes what it needs to render plus the callbacks it should fire, builds a subtree, and returns
// it. It touches no App state, no routes and no storage, which is what lets one be rendered into a
// detached node and inspected without starting a run.
//
// There is one screen per variant because they configure different games — v1's lives with v1
// (v1/configscreen.ts) and implements the same two interfaces below.

import { el } from './dom.js';
import { DEFAULT_GRID_CONFIG, type GridConfig } from '../core/config.js';

/** What a config screen does when the player commits: hand back the config that was assembled from
 *  the screen, and say whether the run should be scored. */
export interface ConfigHandlers<C> {
  onStart: (config: C, timed: boolean) => void;
}

/** Is the primary pointer a finger? Passed in rather than probed, so the screen renders identically
 *  under test regardless of the environment's matchMedia. */
export interface ConfigOpts {
  coarsePointer: boolean;
  message?: string; // an error to surface above the controls (e.g. a rejected alphabet)
}

// ------------------------------------------------------------- GRID MODE ----

/** THE GAME IS 32×32. There is no grid-size control, and that is the design, not an omission: one
 *  fixed N is what makes two scores comparable, and B is only a fair comparison across players if
 *  they are all answering the same question. Three successive calibrators tried to personalise it
 *  and all three were retired (see core/stats.d.ts); the reason they could be dropped without cost
 *  is that measured B is nearly flat across the middle of the ladder — 13.37 bits/s at 24², 13.33 at
 *  32², 13.03 at 48² — so a per-player choice was never worth more than a few percent, and no
 *  measurement cheap enough to sit in front of a 60 s run can resolve a few percent. There is no
 *  override left anywhere, not even a URL parameter. */
export function gridConfigScreen(config: GridConfig, opts: ConfigOpts, handlers: ConfigHandlers<GridConfig>): HTMLElement {
  // The screen carries nothing forward but the machine label, which is not editable here and only
  // survives because an earlier build could set it.
  const collect = (): GridConfig => ({ ...DEFAULT_GRID_CONFIG, gridSize: config.gridSize, label: config.label });

  // Practice is offered, never required. Gating the scored run behind anything costs a minute of the
  // exact activity being scored, and the run-order data shows no warm-up deficit to pay that for:
  // across sessions the FIRST run tends to be the best one (+6.0% over the rest of the session in
  // the one clean 13-run session; two others agree in sign but change grid size partway through).
  // So when to warm up is the player's call, not the app's.
  const practice = el('button', { class: 'btn ghost', onclick: () => handlers.onStart(collect(), false), text: 'Practice' });
  const scored = el('button', { class: 'btn primary', onclick: () => handlers.onStart(collect(), true), text: 'Start scored run' });

  const screen = el('div', { class: 'screen config' }, [
    el('h1', { class: 'title', text: 'Bit-Rate Maximizer' }),
    // "orange" is painted in the target's own colour, so the word points at the thing rather than
    // describing it. --target tracks TARGET_COLOR in v2/view.ts; if one moves so must the other, or
    // the instructions name a colour the game does not draw.
    el('p', { class: 'subtitle' }, [
      document.createTextNode('Click the '),
      el('span', { class: 'ink-target', text: 'orange' }),
      document.createTextNode(' squares as quickly and as accurately as you can. Correct clicks add to your score, while errors subtract from your score. The line drawn from the '),
      el('span', { class: 'ink-target', text: 'orange' }),
      document.createTextNode(' target square to the white outlined square indicates where the next '),
      el('span', { class: 'ink-target', text: 'orange' }),
      document.createTextNode(' target square will appear.'),
    ]),
    ...(opts.message ? [el('div', { class: 'field-error', text: opts.message })] : []),
    // Do not promise a key the device does not have: a phone has no Esc, which is why the practice
    // tag is a button rather than a keybinding.
    el('div', {
      class: 'field-note',
      text: opts.coarsePointer
        ? 'Duration is locked to 60 s for scored runs. Practice runs will continue until you tap Exit.'
        : 'Duration is locked to 60 s for scored runs. Practice runs will continue until you press ESC.',
    }),
    el('div', { class: 'buttons' }, [practice, scored]),
    el('p', { class: 'consent', text: 'Runs can be saved locally, but are never transmitted anywhere.' }),
  ]);
  queueMicrotask(() => scored.focus()); // after the caller has attached the screen
  return screen;
}

/** The practice-run exit. It has to be TAPPABLE, not just an Esc binding: touch sizing made the
 *  game playable on a phone, and a phone has no Esc key — a practice run there would have been
 *  inescapable short of reloading. Esc still works where there is a keyboard. */
export function practiceTag(coarsePointer: boolean, onExit: () => void): HTMLElement {
  return el('button', {
    class: 'practice-tag',
    type: 'button',
    onclick: onExit,
    text: coarsePointer ? 'PRACTICE · tap to exit' : 'PRACTICE · Esc to exit',
  });
}

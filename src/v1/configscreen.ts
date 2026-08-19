// v1's config screen — the only screen the keyboard game shows before a run. Same contract as the
// grid screen (ConfigOpts in, ConfigHandlers out, a detached subtree returned), so app.ts routes to
// either without caring which it got.
//
// Unlike the grid screen this one has controls, and can fail. The grid game's N is fixed by its
// geometry; the keyboard game's N *is* its alphabet, and the player supplies it — so the two finger
// fields stay, `onStart` fires only once validateAlphabet accepts them, and the error renders in
// place otherwise.

import { el } from '../ui/dom.js';
import type { ConfigHandlers, ConfigOpts } from '../ui/configscreen.js';
import { validateAlphabet } from './alphabet.js';
import { DEFAULT_KEYBOARD_CONFIG, type KeyboardConfig } from './config.js';

/** The original falling-lanes keyboard game, frozen. Only the two home rows are configurable
 *  (N = 8); there is no grid and none of the retired experiments. It exists to demonstrate the
 *  design lineage that led to the grid alphabet — see the Development Process section of
 *  README.md. */
export function keyboardConfigScreen(config: KeyboardConfig, opts: ConfigOpts, handlers: ConfigHandlers<KeyboardConfig>): HTMLElement {
  const keyInput = (value: string): HTMLInputElement =>
    el('input', { type: 'text', class: 'field-input mono', value, spellcheck: false, autocomplete: 'off', autocapitalize: 'off' });
  const leftFingers = keyInput(config.leftFingers || 'asdf');
  const rightFingers = keyInput(config.rightFingers || 'jkl;');
  const err = el('div', { class: 'field-error' });

  const field = (label: string, control: Node, hint?: string): HTMLElement =>
    el('label', { class: 'field' }, [
      el('span', { class: 'field-label', text: label }),
      control,
      ...(hint ? [el('span', { class: 'field-hint', text: hint })] : []),
    ]);

  const collect = (): KeyboardConfig | null => {
    const parts = { leftFingers: leftFingers.value, rightFingers: rightFingers.value };
    const v = validateAlphabet(parts.leftFingers + parts.rightFingers);
    if (!v.ok) {
      err.textContent = v.error;
      return null;
    }
    err.textContent = '';
    return { ...DEFAULT_KEYBOARD_CONFIG, ...parts, alphabet: v.alphabet, label: config.label };
  };
  const start = (timed: boolean) => (): void => {
    const c = collect();
    if (c) handlers.onStart(c, timed);
  };

  const screen = el('div', { class: 'screen config' }, [
    el('h1', { class: 'title', text: 'Bit-Rate Maximizer — v1' }),
    el('p', { class: 'subtitle', text: 'The original keyboard version: type the highlighted key as it falls down its finger’s lane. Correct keys add bits; errors subtract. Kept as a demo of where the design started — the current version is the grid game.' }),
    ...(opts.message ? [el('div', { class: 'field-error', text: opts.message })] : []),
    el('div', { class: 'config-grid' }, [
      field('Left hand', leftFingers, 'Keys the left hand types, outside-in.'),
      field('Right hand', rightFingers, 'Keys the right hand types, inside-out.'),
    ]),
    err,
    el('div', { class: 'field-note', text: 'N = 8 (one key per finger). Duration is locked to 60 s for scored runs.' }),
    el('div', { class: 'buttons' }, [
      el('button', { class: 'btn ghost', onclick: start(false), text: 'Practice' }),
      el('button', { class: 'btn primary', onclick: start(true), text: 'Start scored run' }),
    ]),
    el('p', { class: 'consent', text: 'Runs can be saved locally, but are never transmitted anywhere.' }),
  ]);
  queueMicrotask(() => leftFingers.focus());
  return screen;
}

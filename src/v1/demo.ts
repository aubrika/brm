// v1's dev-only auto-player, reached with ?auto=practice|scored&demo on the v1 route. The grid's
// equivalent is ui/demo.ts; both follow the same rule, stated there — drive the SAME input path a
// human does, so a demo run exercises shipping code rather than a private back door.

import type { Engine } from './engine.js';

/** Keep typing while this returns a live engine; the caller ends the demo by returning null. */
export type KeyDemoSource = () => Engine | null;

const KEY_ERROR_RATE = 0.06; // a wrong key now and then, so error handling is exercised too

/** Type the falling target, with an occasional wrong key from the same alphabet. */
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

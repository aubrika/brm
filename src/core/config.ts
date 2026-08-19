import { SCORED_DURATION_MS } from './bitrate.js';

// ---- the config, discriminated by which game it configures --------------------
// This used to be one flat interface holding both games' settings, so every grid run carried an
// alphabet and finger layout it never read, and every keyboard run carried a grid size. The log
// schema (RunConfig in core/stats.d.ts) had already been split on `mode` for exactly that reason —
// "stamping those defaults into the log described a keyboard game that never ran" — and this brings
// the runtime config in line with the artifact it produces.
//
// The split also removes a bug structurally rather than by vigilance. v1 and v2 are served from one
// origin and so share localStorage; with a single flat shape and a single key, playing v1 wrote
// `grid: false` where v2 would read it back. Keying storage by mode means neither variant can see
// the other's config at all.
//
// Each game's own shape lives with that game: KeyboardConfig in v1/config.ts, GridConfig here —
// not because the grid is privileged, but because it is the delivered game and core/ is the model
// it is built on. What is left in this file is the part that is true of both.

/** The mode a config configures. Also the localStorage partition — see STORAGE_KEY. */
export type ConfigMode = 'keyboard' | 'grid';

/** What both games need regardless of how a selection is made. Each game's config extends this and
 *  narrows `mode` to its own literal, which is what makes the union discriminable. */
export interface CommonConfig {
  mode: ConfigMode;
  durationMs: number; // locked to 60_000 for scored runs
  sound: boolean;
}

/** GRID MODE: the delivered game. Click the orange square on a large grid, N = cell count, so a
 *  32×32 grid scores log2(1023) ≈ 10 bits/selection. Its own engine + canvas renderer. */
export interface GridConfig extends CommonConfig {
  mode: 'grid';
  gridSize: number; // cells per side; N = gridSize²
  // How many upcoming targets are previewed (0 | 1 | 2). 1 outlines T+1 and draws a connector to
  // it; 2 adds T+2 behind it, dimmer, so the preview reads as an ordered chain rather than two
  // equal targets. Measured worth: depth 1 is +2.46 bits/s over depth 0 (see README.md).
  lookaheadDepth: number;
  crosshair: boolean; // full-field locator hairlines through the target cell
  hoverPulse: boolean; // pulse a white border while the pointer is inside the target cell
}

export const DEFAULT_GRID_CONFIG: GridConfig = {
  mode: 'grid',
  gridSize: 32, // 32×32 = 1024 cells; the geometry whose Fitts ceiling is ~2× device throughput
  lookaheadDepth: 1, // T+1 previewed; measured at +2.46 bits/s over no preview
  crosshair: true,
  hoverPulse: true,
  durationMs: SCORED_DURATION_MS,
  sound: true,
};

// ------------------------------------------------------------ persistence ----

// One key per mode. v1 and v2 share an origin and therefore localStorage, so a single key let each
// variant read back a config the other wrote — the reason app.ts had to normalise `grid` on every
// start. Separate keys make that impossible rather than merely corrected.
const STORAGE_KEY: Record<ConfigMode, string> = {
  keyboard: 'brm.config.keyboard.v1',
  grid: 'brm.config.grid.v1',
};

/** Read back a stored config, falling back to `defaults` for anything absent or unparseable.
 *
 *  Parameterised by the defaults rather than by a mode string so that core/ never has to name the
 *  games it stores for: the caller supplies the shape, and both the storage key and the returned
 *  type follow from it. Callers get their own config type back, not a union to re-narrow. */
export function loadConfig<C extends CommonConfig>(defaults: C): C {
  try {
    const raw = localStorage.getItem(STORAGE_KEY[defaults.mode]);
    if (raw) {
      // `mode` is re-asserted from the defaults, never taken from storage: a stored value cannot be
      // allowed to change which game this is.
      const stored = JSON.parse(raw) as Partial<C>;
      return { ...defaults, ...stored, mode: defaults.mode };
    }
  } catch {
    /* ignore malformed/absent storage */
  }
  return { ...defaults };
}

export function saveConfig(c: CommonConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY[c.mode], JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

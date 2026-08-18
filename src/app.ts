// Screen router + run loop. Three screens (config, run, report); a run waits in a "ready" state
// and its clock starts on the first keypress (no countdown). A single window keydown listener
// (attached once, { passive:false }) drives the whole app; during play it is the latency-critical
// path — classify, count, advance,
// synchronously — while a separate rAF loop reads state and draws. Alongside the scoring
// log, a RunRecorder buffers a richer event log (down+up, verdict, live idx) entirely from
// primitives, written to logs/ once at run end — never during the 60 s.

import { Engine, type KeyInput } from './v1/engine.js';
import { GridEngine } from './v2/engine.js';
import { StripRenderer } from './v1/view.js';
import { GridRenderer } from './v2/view.js';
import { ScopeRenderer } from './v2/scope.js';
import { AudioFeedback } from './ui/audio.js';
import { LatencyOverlay } from './ui/latency.js';
import { buildReport, downloadReport } from './io/report.js';
import { RunRecorder, postLog, probeHealth, fetchIndex, type IndexRow } from './io/logging.js';
import { probeMachine } from './io/machine.js';
import { renderReport, type LogInfo } from './ui/reportview.js';
import { loadConfig, saveConfig, GRID_SIZES, LOOKAHEAD_DEPTHS, DEFAULT_CONFIG, type GameConfig } from './core/config.js';
import { loadAbState, saveAbState, peek as abPeek, advance as abAdvance, completedPairs, type AbState, type AbAssignment } from './core/ab.js';
import { validateAlphabet } from './core/alphabet.js';
import { generateCalibrationScript, computeCalibration, seededRandInt, REFERENCE_GRID, CALIB_CLICKS, type CalibrationResult, type CalibClick } from './v2/calibration.js';
import type { MachineMeta, RunLog, ScopeActivation } from './core/stats.js';

type Props = Record<string, string | number | boolean | EventListener>;
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props,
  children?: Array<Node | string>,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (key.startsWith('on') && typeof val === 'function') {
        e.addEventListener(key.slice(2).toLowerCase(), val as EventListener);
      } else if (key === 'class') {
        e.className = String(val);
      } else if (key === 'text') {
        e.textContent = String(val);
      } else if (typeof val === 'boolean') {
        if (val) e.setAttribute(key, '');
      } else {
        e.setAttribute(key, String(val));
      }
    }
  }
  if (children) for (const c of children) e.append(c);
  return e;
}

const DROPPED_FRAME_MS = 24; // a frame gap this long means at least one 60 fps frame was skipped

// Which app this bundle is (Vite `define`). 'v2' — the delivered game: GRID MODE + calibration.
// 'v1' — the legacy falling-lanes keyboard game, deployed at /brm/v1 purely so the design story
// (why the alphabet became a grid) can be demonstrated. v1 is frozen: home rows only, N = 8, no
// top row / chords / challenge / audio experiments. All ongoing work targets v2.
const VARIANT: 'v1' | 'v2' = (typeof __APP_VARIANT__ !== 'undefined' && __APP_VARIANT__ === 'v1' ? 'v1' : 'v2');

// The in-progress calibration task: a GridEngine on the 24×24 reference grid (driven manually, not
// scored) + the game renderer, plus the captured endpoints.
interface CalibCtx {
  engine: GridEngine;
  view: GridRenderer;
  clicks: CalibClick[];
  script: number[];
  startMs: number;
  lastClickMs: number;
  pointerType: string;
  cleanup: AbortController;
  rafId: number;
  counter: HTMLElement;
}

interface RunCtx {
  engine: Engine | GridEngine; // GridEngine in GRID/SCOPE MODE; all expose the loop-facing surface
  strip: StripRenderer | GridRenderer | ScopeRenderer; // all expose render(now) + resize()
  gridView: GridRenderer | null; // non-null in GRID MODE (also held as `strip`), for pointer wiring
  scopeView: ScopeRenderer | null; // non-null in SCOPE MODE
  grid: boolean; // this run is a plain pointing (grid) run
  scope: boolean; // this run is a SCOPE MODE run (pointer lock + magnify lens)
  // SCOPE MODE lock/scope state
  scopeBindings: Set<'rmb' | 'ctrl'>; // which scope bindings are currently held
  scoped: boolean; // is the lens active (any binding held)
  activations: ScopeActivation[]; // scope hold intervals
  activeActivation: ScopeActivation | null;
  paused: boolean; // pointer lock lost / not yet acquired — clock frozen, overlay shown
  pausedAt: number; // performance.now() when the pause began
  unadjustedMovement: boolean; // raw movement requested
  cleanup: AbortController; // tears down document-level scope listeners
  recorder: RunRecorder;
  timed: boolean;
  phase: 'ready' | 'playing' | 'done'; // ready = waiting for the first selection to start the clock
  startedAt: string; // ISO, stamped when play begins
  droppedFrames: number;
  lastFrameMs: number;
  pendingDownT: number; // run-relative t of a keydown awaiting its paint (latency sample)
  pendingDown: boolean;
  pendingPointer: { t: number; x: number; y: number } | null; // GRID: one path sample per frame
  pointerType: string; // GRID: modal pointer type across the run
  ghostAdjacent: number[]; // GRID: per down-event, was the next target within a couple cells
  pointerTypes: string[]; // GRID: per down-event pointer type
  ab: AbAssignment | null; // GRID: the A/B arm this run was assigned, when the harness is armed
  rafId: number;
  ui: {
    time: HTMLElement;
    rate: HTMLElement;
    stats: HTMLElement;
    countdown: HTMLElement;
    stripRoot: HTMLElement;
    scopeOverlay?: HTMLElement; // SCOPE MODE: "click to enable/resume pointer lock"
  };
}

export class App {
  private mode: 'config' | 'run' | 'report' | 'calibrate' = 'config';
  private config: GameConfig = loadConfig();
  private readonly audio = new AudioFeedback(this.config.sound);
  private readonly latency: LatencyOverlay;
  private run: RunCtx | null = null;
  // grid calibration: session-scoped; gates the scored run and is attached to every run log.
  private calibration: CalibrationResult | null = null;
  private calib: CalibCtx | null = null; // the in-progress calibration task
  // Ghost A/B position. Persisted, so a pair survives a page reload; advanced only when a scored
  // run actually finishes (an abandoned run must not burn an arm and unbalance the pair).
  private abState: AbState = loadAbState();

  // gathered once at startup; awaited (long-settled) when a run finishes
  private machine: MachineMeta | null = null;
  private readonly machinePromise: Promise<MachineMeta>;
  private loggingAvailable = false;

  constructor(private readonly root: HTMLElement) {
    const params = new URLSearchParams(location.search);
    this.latency = new LatencyOverlay(params.has('debug'));
    // v1 and v2 are served from the same origin and so share localStorage; a saved v2 config would
    // otherwise start v1 in grid mode. v1 is the keyboard game, always.
    if (VARIANT === 'v1') this.config = { ...this.config, grid: false, scope: false };

    this.machinePromise = probeMachine().then((m) => (this.machine = m));
    void probeHealth().then((ok) => (this.loggingAvailable = ok));

    // one listener each for the whole app; game input is handled synchronously here.
    window.addEventListener('keydown', this.onKey, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('resize', () => {
      this.run?.strip.resize();
      this.calib?.view.resize();
    });
    this.showConfig();

    // Dev aid: ?auto=practice|scored skips the config screen; add &demo to auto-type
    // (dispatches real keydowns, so it drives the same input path a human would).
    // Dev aid: ?grid[=SIZE] forces GRID MODE on for this session (headless captures / quick trials).
    if (params.has('grid')) {
      const sz = Number(params.get('grid'));
      const dp = Number(params.get('depth'));
      this.config = {
        ...this.config,
        grid: true,
        ...((GRID_SIZES as readonly number[]).includes(sz) ? { gridSize: sz } : {}),
        ...(dp === 1 || dp === 2 ? { gridDepth: dp } : {}),
      };
    }
    // Dev aid: ?ab arms the ghost A/B for this session, so the harness can be driven headlessly
    // (`?grid=32&auto=scored&secs=6&demo&ab` plays one arm and reports it) without clicking through
    // the config screen. It only arms the harness; which arm you get is still the harness's call.
    if (params.has('ab')) this.config = { ...this.config, abGhost: true };
    // Dev aid: ?look=0|1|2 forces the lookahead depth for this session (headless capture).
    if (params.has('look')) {
      const d = Number(params.get('look'));
      if ((LOOKAHEAD_DEPTHS as readonly number[]).includes(d)) this.config = { ...this.config, lookaheadDepth: d };
    }
    // Dev aid: ?scope[=128|256]&mag=8 forces SCOPE MODE; &scoped engages the lens after start (for
    // headless capture, where there is no pointer lock to drive it).
    if (params.has('scope')) {
      const fine = Number(params.get('scope'));
      const mag = Number(params.get('mag'));
      this.config = {
        ...this.config,
        scope: true,
        grid: false,
        ...(fine === 128 || fine === 256 ? { scopeGridSize: fine } : {}),
        ...(mag === 4 || mag === 8 || mag === 12 ? { magnification: mag } : {}),
      };
    }
    const auto = params.get('auto');
    if (auto === 'practice' || auto === 'scored') {
      // Dev-only: ?secs=N shortens JUST this capture run so a full run→report can be driven
      // headlessly. Never affects a real scored run (which is always 60 s).
      const secs = Number(params.get('secs'));
      if (Number.isFinite(secs) && secs >= 1 && secs <= 60) {
        this.config = { ...this.config, durationMs: Math.round(secs * 1000) };
      }
      this.startRun(auto === 'scored', true); // start immediately (skip the ready wait) for headless capture
      if (this.config.scope && params.has('scoped')) this.engageScope('ctrl'); // dev: show the lens
      if (params.has('demo')) {
        if (this.config.grid) this.startGridDemo();
        else if (!this.config.scope) this.startDemoTyper();
      }
    }
    // Dev aid: ?calibrate[&demo] opens the calibration task (demo auto-clicks the targets with scatter).
    if (params.has('calibrate')) {
      this.startCalibration();
      if (params.has('demo')) this.startCalibDemo();
    }
  }

  // Dev-only: auto-click each calibration target (centre + sub-cell scatter), driving the real
  // pointerdown path so the σ pipeline runs end-to-end headlessly.
  private startCalibDemo(): void {
    const tick = (): void => {
      const c = this.calib;
      if (!c) return; // finished
      const target = c.engine.target();
      const cp = c.view.cellPx;
      const r = c.view.element.getBoundingClientRect();
      const col = target % REFERENCE_GRID;
      const row = Math.floor(target / REFERENCE_GRID);
      const noise = (): number => (Math.random() - 0.5) * cp * 0.6;
      const opts = { clientX: r.left + (col + 0.5) * cp + noise(), clientY: r.top + (row + 0.5) * cp + noise(), bubbles: true, pointerType: 'mouse' } as PointerEventInit;
      c.view.element.dispatchEvent(new PointerEvent('pointermove', opts));
      c.view.element.dispatchEvent(new PointerEvent('pointerdown', opts));
      window.setTimeout(tick, 60);
    };
    window.setTimeout(tick, 200);
  }

  // Dev-only demo driver for GRID MODE: dispatches a real pointerdown at the current target's
  // centre (plus a pointermove, so hover/pulse and path sampling exercise the same path a hand
  // would). Drives the identical input code as a human click.
  private startGridDemo(): void {
    const errorRate = 0.05;
    const tick = (): void => {
      const rc = this.run;
      if (!rc || rc.phase === 'done') return;
      if (rc.phase === 'playing' && rc.gridView) {
        const eng = rc.engine as GridEngine;
        const gv = rc.gridView;
        let cell = eng.target();
        if (Math.random() < errorRate) cell = (cell + 1) % eng.cellsPerLayer; // an adjacent miss now and then
        const r = gv.element.getBoundingClientRect();
        const col = cell % eng.gridSize;
        const row = Math.floor(cell / eng.gridSize);
        const cx = r.left + (col + 0.5) * gv.cellPx;
        const cy = r.top + (row + 0.5) * gv.cellPx;
        const opts = { clientX: cx, clientY: cy, bubbles: true, pointerType: 'mouse' } as PointerEventInit;
        gv.element.dispatchEvent(new PointerEvent('pointermove', opts));
        gv.element.dispatchEvent(new PointerEvent('pointerdown', opts));
      }
      window.setTimeout(tick, 90 + Math.random() * 60);
    };
    window.setTimeout(tick, 200);
  }

  private startDemoTyper(): void {
    const errorRate = 0.06;
    const tick = (): void => {
      const rc = this.run;
      if (!rc || rc.phase === 'done') return;
      if (rc.phase === 'playing') {
        const eng = rc.engine as Engine;
        let key = eng.target();
        if (Math.random() < errorRate) {
          const others = eng.chars.filter((c) => c !== key);
          key = others[Math.floor(Math.random() * others.length)] ?? key;
        }
        window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        window.setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true })), 30);
      }
      window.setTimeout(tick, 70 + Math.random() * 80);
    };
    window.setTimeout(tick, 200);
  }

  // ---------------------------------------------------------------- input ----
  private onKey = (e: KeyboardEvent): void => {
    if (this.mode === 'calibrate') {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.abortCalibration();
      }
      return;
    }
    if (this.mode !== 'run' || !this.run) return; // config/report use normal DOM controls
    if (e.key === 'Escape') {
      e.preventDefault();
      // SCOPE MODE: the first Esc exits pointer lock (→ pointerlockchange pauses + overlay); a
      // second Esc while already paused aborts the run.
      if (this.run.scope && !this.run.paused) return;
      this.abortRun();
      return;
    }
    const rc = this.run;
    if (rc.phase === 'done') return;
    if (rc.grid || rc.scope) return; // pointing modes score on pointerdown, not keys
    const eng0 = rc.engine as Engine;
    // No countdown: the run's clock starts when you first type an in-alphabet target. This same
    // keydown then falls through and is scored as the first selection.
    if (rc.phase === 'ready') {
      if (!eng0.alphaSet.has(e.key) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      rc.phase = 'playing';
      eng0.start(performance.now());
      rc.startedAt = new Date().toISOString();
      rc.ui.countdown.classList.add('hidden');
    }
    const eng = eng0;
    const inAlpha = eng.alphaSet.has(e.key);
    const modified = e.ctrlKey || e.metaKey || e.altKey;
    if (inAlpha && !modified) e.preventDefault();
    const now = performance.now();
    this.latency.markKey(now);
    const input: KeyInput = { key: e.key, repeat: e.repeat, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey };
    const idxBefore = eng.index;
    const tRun = now - eng.startMs;
    const outcome = eng.handleKey(input, now);
    if (outcome === 'correct' || outcome === 'incorrect') {
      rc.recorder.recordDown(e.key, idxBefore, outcome === 'correct' ? 'ok' : 'err', tRun);
      rc.pendingDownT = tRun; // measure this keydown → next paint for the latency samples
      rc.pendingDown = true;
    } else if (!inAlpha && !modified && !e.repeat && e.key.length === 1) {
      rc.recorder.outOfAlphabet++; // a genuine out-of-alphabet character (not a modifier/nav key)
    }
  };

  // Key releases are logged (in-alphabet only — never free text) so rollover, the next key
  // going down before the previous comes up, is measurable. Not part of scoring.
  private onKeyUp = (e: KeyboardEvent): void => {
    const rc = this.run;
    if (this.mode !== 'run' || !rc || rc.phase !== 'playing' || rc.grid || rc.scope) return;
    const eng0 = rc.engine as Engine;
    if (!eng0.alphaSet.has(e.key)) return;
    const now = performance.now();
    rc.recorder.recordUp(e.key, eng0.index, now - eng0.startMs);
  };

  // ------------------------------------------------------- GRID MODE input ----
  // Pointing selections: score on pointerdown (the earliest committed moment — the click event
  // fires on pointer-up and would waste the press→release interval). Hit-test is pure arithmetic
  // against the canvas, never per-cell DOM. Runs the same ready→playing start-on-first-selection
  // as the keyboard path, then falls through to score that first pointerdown.
  private onGridPointerDown = (e: PointerEvent): void => {
    const rc = this.run;
    if (this.mode !== 'run' || !rc || !rc.grid || rc.phase === 'done' || !rc.gridView) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // ignore modified clicks (spec §1)
    e.preventDefault();
    const eng = rc.engine as GridEngine;
    if (rc.phase === 'ready') {
      rc.phase = 'playing';
      eng.start(performance.now());
      rc.startedAt = new Date().toISOString();
      rc.ui.countdown.classList.add('hidden');
    }
    const now = performance.now();
    this.latency.markKey(now);
    const cell = rc.gridView.cellAt(e.clientX, e.clientY);
    const idxBefore = eng.index;
    const tRun = now - eng.startMs;
    const ghostAdjacent = rc.gridView.ghostAdjacent();
    const outcome = eng.handleClick(cell, now);
    const pType = e.pointerType || 'mouse';
    if (!rc.pointerType) rc.pointerType = pType; // first observed = modal (mixed input is rare)
    // One 'ok' event per COMPLETED selection (its cells joined, e.g. "78,912" for a depth-2 pair),
    // one 'err' per wrong click. A 'partial' (a correct sub-click that doesn't yet complete the
    // tuple, e.g. orange done, blue to go) advances state but logs no event — so one 'ok' event
    // still equals one scored selection, which the whole report/stats layer assumes.
    if (outcome === 'correct') {
      rc.recorder.recordDown(eng.lastCompleted.join(','), idxBefore, 'ok', tRun);
      rc.ghostAdjacent.push(ghostAdjacent ? 1 : 0);
      rc.pointerTypes.push(pType);
    } else if (outcome === 'incorrect') {
      rc.recorder.recordDown(String(cell), idxBefore, 'err', tRun);
      rc.ghostAdjacent.push(ghostAdjacent ? 1 : 0);
      rc.pointerTypes.push(pType);
    }
    if (outcome !== 'ignored') {
      rc.pendingDownT = tRun; // this click → next paint, for the latency samples
      rc.pendingDown = true;
    }
    // an out-of-field press is counted in the engine (outOfField); no event is recorded
  };

  // Hover for the pulse + one path sample per frame (flushed in the loop). Coordinates are
  // field-local so the log is self-contained for Fitts analysis.
  private onGridPointerMove = (e: PointerEvent): void => {
    const rc = this.run;
    if (this.mode !== 'run' || !rc || !rc.grid || !rc.gridView) return;
    rc.gridView.hoverCell = rc.gridView.cellAt(e.clientX, e.clientY);
    if (rc.phase === 'playing') {
      const p = rc.gridView.localPoint(e.clientX, e.clientY);
      rc.pendingPointer = { t: performance.now() - rc.engine.startMs, x: p.x, y: p.y };
    }
  };

  // ---------------------------------------------------------- calibration ----
  // The required pre-run calibration (grid mode): ~20 clicks on a 24×24 reference grid, on the real
  // game surface, measuring endpoint scatter to size the scored grid. Drives a GridEngine's sequence
  // via the scripted targets (any click advances — the miss is data), not its scoring.
  private startCalibration(): void {
    this.mode = 'calibrate';
    // NOTE: any existing calibration is deliberately kept until a new one succeeds — cancelling a
    // recalibration (Esc) must not strip a valid result and re-lock the scored run.
    this.root.replaceChildren();
    if (this.config.sound) this.audio.unlock();

    const script = generateCalibrationScript(REFERENCE_GRID, CALIB_CLICKS);
    const fallback = seededRandInt(0x1234abcd);
    let k = 0;
    const src = (n: number): number => (k < script.length ? script[k++] : fallback(n));
    const engine = new GridEngine({ ...this.config, gridSize: REFERENCE_GRID, gridDepth: 1, lookaheadDepth: 0 }, false, src);
    engine.start(performance.now());

    const stripRoot = el('div', { class: 'strip-root grid-root' });
    const instruction = el('div', { class: 'calib-instruction', text: 'Click each highlighted cell as quickly as you comfortably can.' });
    const counter = el('div', { class: 'stats', text: `calibrating: 0 / ${CALIB_CLICKS}` });
    this.root.append(
      el('div', { class: 'screen run' }, [
        instruction,
        el('div', { class: 'strip-wrap' }, [stripRoot]),
        el('div', { class: 'readout' }, [counter]),
        el('div', { class: 'practice-tag', text: 'CALIBRATION · Esc to cancel' }),
      ]),
    );

    const view = new GridRenderer(engine, stripRoot);
    view.element.style.cursor = 'crosshair';
    const now = performance.now();
    const c: CalibCtx = { engine, view, clicks: [], script, startMs: now, lastClickMs: now, pointerType: 'mouse', cleanup: new AbortController(), rafId: 0, counter };
    this.calib = c;
    const sig = c.cleanup.signal;
    view.element.addEventListener('pointerdown', this.onCalibDown, { signal: sig });
    view.element.addEventListener('pointermove', this.onCalibMove, { signal: sig });
    const loop = (): void => {
      c.view.render(performance.now());
      c.rafId = requestAnimationFrame(loop);
    };
    c.rafId = requestAnimationFrame(loop);
  }

  private onCalibMove = (e: PointerEvent): void => {
    const c = this.calib;
    if (!c) return;
    c.view.hoverCell = c.view.cellAt(e.clientX, e.clientY);
  };

  private onCalibDown = (e: PointerEvent): void => {
    const c = this.calib;
    if (!c || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const now = performance.now();
    const p = c.view.localPoint(e.clientX, e.clientY);
    const target = c.engine.target();
    const cp = c.view.cellPx;
    const cx = ((target % REFERENCE_GRID) + 0.5) * cp;
    const cy = (Math.floor(target / REFERENCE_GRID) + 0.5) * cp;
    c.clicks.push({
      t: Math.round(now - c.startMs),
      targetCell: target,
      dx: Math.round((p.x - cx) * 10) / 10,
      dy: Math.round((p.y - cy) * 10) / 10,
      mtMs: Math.round(now - c.lastClickMs),
    });
    c.lastClickMs = now;
    c.pointerType = e.pointerType || c.pointerType;
    // feedback: bloop + particle burst at the clicked cell (calibration IS the game — primes the player)
    const clicked = c.view.cellAt(e.clientX, e.clientY);
    c.engine.lastCorrectCell = clicked >= 0 ? clicked : target;
    c.engine.lastCorrectMs = now;
    this.audio.bloop();
    c.engine.index++; // any click advances — the miss is data, not a penalty
    c.counter.textContent = `calibrating: ${c.clicks.length} / ${CALIB_CLICKS}`;
    if (c.clicks.length >= CALIB_CLICKS) this.finishCalibration();
  };

  private finishCalibration(): void {
    const c = this.calib;
    if (!c) return;
    cancelAnimationFrame(c.rafId);
    c.cleanup.abort();
    const result = computeCalibration(c.clicks, { fieldPx: c.view.fieldPx, referenceGrid: REFERENCE_GRID, devicePixelRatio: c.view.dpr, pointerType: c.pointerType });
    this.calib = null;
    if (!result) {
      this.showConfig('Not enough clean clicks to size the grid — please calibrate again.');
      return;
    }
    this.calibration = result;
    this.config = { ...this.config, gridSize: result.recommendedGrid };
    saveConfig(this.config);
    this.showConfig();
  }

  private abortCalibration(): void {
    const c = this.calib;
    if (c) {
      cancelAnimationFrame(c.rafId);
      c.cleanup.abort();
      this.calib = null;
    }
    this.showConfig();
  }

  // ------------------------------------------------------ v1 legacy config ----
  // The original falling-lanes keyboard game, frozen. Only the two home rows are configurable
  // (N = 8); there is no calibration gate, no grid, and none of the retired experiments. This
  // exists to demonstrate the design lineage that led to the grid alphabet — see README.
  private showLegacyConfig(msg?: string): void {
    const keyInput = (value: string): HTMLInputElement =>
      el('input', { type: 'text', class: 'field-input mono', value, spellcheck: false, autocomplete: 'off', autocapitalize: 'off' }) as HTMLInputElement;
    const leftFingers = keyInput(this.config.leftFingers || 'asdf');
    const rightFingers = keyInput(this.config.rightFingers || 'jkl;');
    const err = el('div', { class: 'field-error' });

    const field = (label: string, control: Node, hint?: string): HTMLElement =>
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: label }),
        control,
        ...(hint ? [el('span', { class: 'field-hint', text: hint })] : []),
      ]);

    const collect = (): GameConfig | null => {
      const parts = { leftFingers: leftFingers.value, rightFingers: rightFingers.value };
      const v = validateAlphabet(parts.leftFingers + parts.rightFingers);
      if (!v.ok) {
        err.textContent = v.error;
        return null;
      }
      err.textContent = '';
      return { ...DEFAULT_CONFIG, ...parts, grid: false, scope: false, alphabet: v.alphabet };
    };
    const start = (timed: boolean) => (): void => {
      const c = collect();
      if (!c) return;
      this.commit(c);
      this.startRun(timed);
    };

    this.root.append(
      el('div', { class: 'screen config' }, [
        el('h1', { class: 'title', text: 'Bit-Rate Maximizer — v1' }),
        el('p', { class: 'subtitle', text: 'The original keyboard version: type the highlighted key as it falls down its finger’s lane. Correct keys add bits; errors subtract. Kept as a demo of where the design started — the current version is the grid game.' }),
        ...(msg ? [el('div', { class: 'field-error', text: msg })] : []),
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
        el('p', { class: 'consent', text: 'Runs are saved locally and never transmitted anywhere.' }),
      ]),
    );
    leftFingers.focus();
  }

  // --------------------------------------------------------------- config ----
  private showConfig(msg?: string): void {
    this.mode = 'config';
    this.run = null;
    this.calib = null;
    this.root.replaceChildren();
    if (VARIANT === 'v1') {
      this.showLegacyConfig(msg);
      return;
    }

    const cal = this.calibration;
    // Grid size options: the config sizes plus the calibrator's snap sizes, so both a recommendation
    // (e.g. 12 or 48) and a manual choice are selectable.
    const SIZES = [8, 12, 16, 24, 32, 48, 64, 128];
    const gridSize = el('select', { class: 'field-input mono' },
      SIZES.map((sz) =>
        el('option', { value: String(sz), ...(this.config.gridSize === sz ? { selected: true } : {}), text: `${sz} × ${sz}  ·  N = ${sz * sz}` }),
      ),
    ) as HTMLSelectElement;
    gridSize.addEventListener('change', () => {
      this.config = { ...this.config, gridSize: Number(gridSize.value) || 32 };
      saveConfig(this.config);
      if (this.calibration) {
        this.calibration.chosenGrid = this.config.gridSize; // auto-set, override allowed — both logged
        this.calibration.overridden = this.calibration.chosenGrid !== this.calibration.recommendedGrid;
      }
      this.showConfig(); // re-render: the headline must state the grid you will actually play
    });

    const field = (label: string, control: Node, hint?: string): HTMLElement =>
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: label }),
        control,
        ...(hint ? [el('span', { class: 'field-hint', text: hint })] : []),
      ]);

    // Lookahead depth. Disabled while the A/B is armed, because there the harness — not this
    // control — decides the depth (1 vs 0), and a select that silently does nothing is worse than
    // one that is visibly unavailable.
    const LOOKAHEAD_LABELS = ['0 · no preview', '1 · next target', '2 · next two'];
    const lookahead = el('select', { class: 'field-input mono', ...(this.config.abGhost ? { disabled: true } : {}) },
      (LOOKAHEAD_DEPTHS as readonly number[]).map((d) =>
        el('option', { value: String(d), ...(this.config.lookaheadDepth === d ? { selected: true } : {}), text: LOOKAHEAD_LABELS[d] }),
      ),
    ) as HTMLSelectElement;
    lookahead.addEventListener('change', () => {
      this.config = { ...this.config, lookaheadDepth: Number(lookahead.value) || 0 };
      saveConfig(this.config);
    });

    // The ghost A/B. Off by default so a first-time visitor plays the whole game; while it is on,
    // the harness overrides the lookahead depth on every scored run and the config's value is idle.
    const abGhost = el('input', { type: 'checkbox', class: 'field-check', ...(this.config.abGhost ? { checked: true } : {}) }) as HTMLInputElement;
    abGhost.addEventListener('change', () => {
      this.config = { ...this.config, abGhost: abGhost.checked };
      saveConfig(this.config);
      this.showConfig(); // re-render: the hint must state the arm you are about to play
    });
    const next = abPeek(this.abState);
    const abHint = this.config.abGhost
      ? `Next scored run: ghost ${next.arm.toUpperCase()} (pair ${next.block + 1}, run ${next.position + 1} of 2) · ${completedPairs(this.abState)} pairs complete`
      : 'Alternates the next-target preview on and off in randomised pairs, to measure what it is worth.';

    const collect = (): GameConfig => ({
      ...DEFAULT_CONFIG,
      grid: true,
      scope: false,
      gridSize: Number(gridSize.value) || 32,
      lookaheadDepth: Number(lookahead.value) || 0,
      abGhost: abGhost.checked,
    });

    const calibrate = el('button', { class: 'btn ghost', onclick: () => this.startCalibration(), text: cal ? 'Recalibrate' : 'Calibrate' });
    const practice = el('button', { class: 'btn ghost', onclick: () => { this.commit(collect()); this.startRun(false); }, text: 'Practice' });
    const scored = el('button', {
      class: 'btn primary',
      onclick: () => { if (this.calibration) { this.commit(collect()); this.startRun(true); } },
      text: 'Start scored run',
      ...(cal ? {} : { disabled: true }),
    });

    // The calibration result (or the prompt to run it).
    // Reads chosenGrid (not recommendedGrid) so an override is reflected, and re-renders on change.
    // Only σ is surfaced: the Fitts throughput from 20 clicks has an R² around 0.05, so showing it
    // would dress noise up as a measurement (it stays in the log for offline work).
    const status = cal
      ? el('div', { class: 'calib-status' }, [
          el('p', { class: 'calib-result' }, [
            document.createTextNode(cal.overridden ? 'Grid set to ' : 'Grid set to '),
            el('strong', { text: `${cal.chosenGrid}×${cal.chosenGrid}` }),
            document.createTextNode(
              cal.overridden
                ? ` — your choice (calibration suggested ${cal.recommendedGrid}×${cal.recommendedGrid}).`
                : ' — sized so the cells fit your aim on this device.',
            ),
          ]),
          el('p', { class: 'field-hint', text: `measured scatter σ ≈ ${cal.sigmaUsed}px on a ${cal.referenceGrid}×${cal.referenceGrid} reference grid` }),
        ])
      : el('p', { class: 'subtitle', text: 'Calibrate first (~15 s) to size the grid to your aim on this device — it doubles as warm-up. Practice is available anytime.' });

    this.root.append(
      el('div', { class: 'screen config' }, [
        el('h1', { class: 'title', text: 'Bit-Rate Maximizer' }),
        el('p', { class: 'subtitle', text: 'Click the highlighted cell as fast and as accurately as you can. Correct clicks add bits; errors subtract — so accuracy is worth about twice raw speed.' }),
        ...(msg ? [el('div', { class: 'field-error', text: msg })] : []),
        status,
        el('div', { class: 'config-grid' }, [
          field(cal ? 'Grid size (change)' : 'Grid size', gridSize, 'More cells = more bits per correct click, but smaller targets.'),
          field('Lookahead', lookahead, this.config.abGhost ? 'Set by the A/B while it is armed.' : 'How many upcoming targets are outlined. Previewing one is worth about +2.5 bits/s.'),
          field('A/B the lookahead ghost', abGhost, abHint),
        ]),
        el('div', { class: 'field-note', text: cal ? 'Duration is locked to 60 s for scored runs.' : 'The scored run unlocks after calibration. Duration is locked to 60 s.' }),
        el('div', { class: 'buttons' }, [calibrate, practice, scored]),
        el('p', { class: 'consent', text: 'Runs are saved locally and never transmitted anywhere.' }),
      ]),
    );
    (cal ? scored : calibrate).focus();
  }

  private commit(c: GameConfig): void {
    this.config = c;
    saveConfig(c);
    this.audio.setEnabled(c.sound);
  }

  // ------------------------------------------------------------------ run ----
  private startRun(timed: boolean, immediate = false): void {
    // Grid scored runs require a valid calibration (also enforced by the disabled button, but a
    // report's "Run again" and any other caller route through here). Practice and dev auto-runs
    // (immediate) are never gated.
    if (this.config.grid && !this.config.scope && timed && !immediate && !this.calibration) {
      this.showConfig('Calibrate before starting a scored run.');
      return;
    }
    if (this.config.scope) {
      this.startScopeRun(timed, immediate);
      return;
    }
    if (this.config.grid) {
      this.startGridRun(timed, immediate);
      return;
    }
    this.mode = 'run';
    this.root.replaceChildren();
    if (this.config.sound) this.audio.unlock(); // user gesture (button click) is active

    const engine = new Engine(this.config, timed);
    engine.onError = () => this.audio.error();

    const stripRoot = el('div', { class: 'strip-root' });
    const time = el('div', { class: 'time' });
    const rate = el('div', { class: 'rate' });
    const stats = el('div', { class: 'stats' });
    // shown until the first keypress: the run's clock starts when you type, no 3-2-1 countdown
    const countdown = el('div', { class: 'countdown hint', text: 'type the highlighted key to start' });

    const screen = el('div', { class: 'screen run' }, [
      time,
      el('div', { class: 'strip-wrap' }, [stripRoot, countdown]),
      el('div', { class: 'readout' }, [rate, stats]),
      ...(timed ? [] : [el('div', { class: 'practice-tag', text: 'PRACTICE · Esc to exit' })]),
    ]);
    this.root.append(screen);

    const strip = new StripRenderer(engine, stripRoot);
    const now0 = performance.now();
    this.run = {
      engine,
      strip,
      gridView: null,
      scopeView: null,
      grid: false,
      scope: false,
      scopeBindings: new Set(),
      scoped: false,
      activations: [],
      activeActivation: null,
      paused: false,
      pausedAt: 0,
      unadjustedMovement: false,
      cleanup: new AbortController(),
      recorder: new RunRecorder(),
      timed,
      phase: immediate ? 'playing' : 'ready',
      startedAt: '',
      droppedFrames: 0,
      lastFrameMs: -1,
      pendingDownT: 0,
      pendingDown: false,
      pendingPointer: null,
      pointerType: '',
      ghostAdjacent: [],
      pointerTypes: [],
      ab: null,
      rafId: 0,
      ui: { time, rate, stats, countdown, stripRoot },
    };
    if (immediate) {
      engine.start(now0);
      this.run.startedAt = new Date().toISOString();
      countdown.classList.add('hidden');
    }
    this.run.rafId = requestAnimationFrame(this.loop);
  }

  // GRID MODE run: a pointing game on a canvas grid. Shares the run loop, HUD, latency proxy, and
  // logging with the keyboard path, but builds a GridEngine + canvas renderer and wires pointer
  // handlers instead of the keyboard strip.
  private startGridRun(timed: boolean, immediate = false): void {
    this.mode = 'run';
    this.root.replaceChildren();
    if (this.config.sound) this.audio.unlock(); // the Start-button click is the unlocking gesture

    // A/B: when the harness is armed, IT decides whether this run shows the ghost — not the config.
    // Scored runs only: practice runs would consume arms without contributing a comparable score.
    const ab = timed && this.config.abGhost ? abPeek(this.abState) : null;
    const runConfig = ab ? { ...this.config, lookaheadDepth: ab.arm === 'on' ? 1 : 0 } : this.config;

    const engine = new GridEngine(runConfig, timed);
    engine.onCorrect = () => this.audio.bloop(); // hit: rising bloop (+ particle burst in the renderer)
    // no wrong-cell buzzer — the red flash (drawn by the renderer) is the only miss feedback
    const stripRoot = el('div', { class: 'strip-root grid-root' });
    const time = el('div', { class: 'time' });
    const rate = el('div', { class: 'rate' });
    const stats = el('div', { class: 'stats' });
    const countdown = el('div', { class: 'countdown hint', text: 'click the highlighted cell to start' });

    const screen = el('div', { class: 'screen run' }, [
      time,
      el('div', { class: 'strip-wrap' }, [stripRoot, countdown]),
      el('div', { class: 'readout' }, [rate, stats]),
      ...(timed ? [] : [el('div', { class: 'practice-tag', text: 'PRACTICE · Esc to exit' })]),
      // Name the arm on screen. The ghost's absence is otherwise indistinguishable from a bug, and
      // a player who thinks the game is broken does not play the run you are trying to measure.
      ...(ab ? [el('div', { class: 'ab-tag', text: `A/B · ghost ${ab.arm} · pair ${ab.block + 1}` })] : []),
    ]);
    this.root.append(screen);

    const gridView = new GridRenderer(engine, stripRoot);
    // Calibration is only valid at the geometry it was measured at: if the play field has drifted
    // > 10% since calibrating (window resize / zoom), invalidate it and bounce a scored run back to
    // config with a recalibrate prompt. Checked here against the real field size, not flaky window
    // dims. Practice is never gated.
    if (timed && this.calibration && this.calibration.fieldPx > 0) {
      const drift = Math.abs(gridView.fieldPx - this.calibration.fieldPx) / this.calibration.fieldPx;
      if (drift > 0.1) {
        this.calibration = null;
        this.showConfig('The play area changed size since calibration — please recalibrate.');
        return;
      }
    }
    const canvas = gridView.element;
    canvas.style.cursor = 'crosshair';
    // pointer input lives on the canvas element, so it is torn down automatically when the screen
    // is replaced. pointerdown scores; pointermove drives the pulse + path sampling.
    canvas.addEventListener('pointerdown', this.onGridPointerDown);
    canvas.addEventListener('pointermove', this.onGridPointerMove);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.style.touchAction = 'none'; // no scroll/zoom gestures stealing the pointerdown

    const now0 = performance.now();
    this.run = {
      engine,
      strip: gridView,
      gridView,
      scopeView: null,
      grid: true,
      scope: false,
      scopeBindings: new Set(),
      scoped: false,
      activations: [],
      activeActivation: null,
      paused: false,
      pausedAt: 0,
      unadjustedMovement: false,
      cleanup: new AbortController(),
      recorder: new RunRecorder(),
      timed,
      phase: immediate ? 'playing' : 'ready',
      startedAt: '',
      droppedFrames: 0,
      lastFrameMs: -1,
      pendingDownT: 0,
      pendingDown: false,
      pendingPointer: null,
      pointerType: '',
      ghostAdjacent: [],
      pointerTypes: [],
      ab,
      rafId: 0,
      ui: { time, rate, stats, countdown, stripRoot },
    };
    if (immediate) {
      engine.start(now0);
      this.run.startedAt = new Date().toISOString();
      countdown.classList.add('hidden');
    }
    this.run.rafId = requestAnimationFrame(this.loop);
  }

  // SCOPE MODE run: a very fine grid (256²) played under Pointer Lock. A software virtual cursor
  // (accumulated raw movement, same sensitivity scoped or not) drives arithmetic hit-testing,
  // exactly like grid scoring. The lens is a visual magnifier only. Losing lock pauses the clock
  // behind a "click to resume" overlay. All document-level listeners hang off one AbortController.
  private startScopeRun(timed: boolean, immediate = false): void {
    this.mode = 'run';
    this.root.replaceChildren();

    // GridEngine with the fine grid; depth 1. (SCOPE is a grid variant — scoring is identical.)
    const engine = new GridEngine({ ...this.config, gridSize: this.config.scopeGridSize, gridDepth: 1 }, timed);
    const stripRoot = el('div', { class: 'strip-root grid-root' });
    const time = el('div', { class: 'time' });
    const rate = el('div', { class: 'rate' });
    const stats = el('div', { class: 'stats' });
    const countdown = el('div', { class: 'countdown hint', text: 'left-click the highlighted target to start · hold right-mouse or Ctrl to scope' });
    const scopeOverlay = el('div', { class: 'scope-overlay hidden', text: 'Click to enable pointer lock' });

    const screen = el('div', { class: 'screen run' }, [
      time,
      el('div', { class: 'strip-wrap' }, [stripRoot, countdown, scopeOverlay]),
      el('div', { class: 'readout' }, [rate, stats]),
      ...(timed ? [] : [el('div', { class: 'practice-tag', text: 'PRACTICE · Esc to exit' })]),
    ]);
    this.root.append(screen);

    const scopeView = new ScopeRenderer(engine, stripRoot);
    const canvas = scopeView.element;
    canvas.style.cursor = 'none'; // the virtual reticle is the cursor
    const now0 = performance.now();
    const rc: RunCtx = {
      engine,
      strip: scopeView,
      gridView: null,
      scopeView,
      grid: false,
      scope: true,
      scopeBindings: new Set(),
      scoped: false,
      activations: [],
      activeActivation: null,
      paused: false,
      pausedAt: 0,
      unadjustedMovement: true,
      cleanup: new AbortController(),
      recorder: new RunRecorder(),
      timed,
      phase: immediate ? 'playing' : 'ready',
      startedAt: '',
      droppedFrames: 0,
      lastFrameMs: -1,
      pendingDownT: 0,
      pendingDown: false,
      pendingPointer: null,
      pointerType: 'mouse',
      ghostAdjacent: [],
      pointerTypes: [],
      ab: null,
      rafId: 0,
      ui: { time, rate, stats, countdown, stripRoot, scopeOverlay },
    };
    this.run = rc;

    const sig = rc.cleanup.signal;
    scopeOverlay.addEventListener('click', () => this.requestScopeLock(canvas), { signal: sig });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault(), { signal: sig });
    document.addEventListener('mousemove', this.onScopeMove, { signal: sig });
    document.addEventListener('mousedown', this.onScopeDown, { signal: sig });
    document.addEventListener('mouseup', this.onScopeUp, { signal: sig });
    document.addEventListener('keydown', this.onScopeKey, { signal: sig });
    document.addEventListener('keyup', this.onScopeKey, { signal: sig });
    document.addEventListener('pointerlockchange', this.onLockChange, { signal: sig });
    document.addEventListener('pointerlockerror', () => this.setScopePaused(true, 'Pointer lock failed — click to retry'), { signal: sig });

    if (immediate) {
      engine.start(now0);
      rc.startedAt = new Date().toISOString();
      countdown.classList.add('hidden');
    } else {
      this.requestScopeLock(canvas); // gesture: this runs inside the Start-button click handler
    }
    rc.rafId = requestAnimationFrame(this.loop);
  }

  private requestScopeLock(canvas: HTMLElement): void {
    const el2 = canvas as HTMLElement & { requestPointerLock: (opts?: { unadjustedMovement?: boolean }) => Promise<void> | void };
    try {
      const p = el2.requestPointerLock({ unadjustedMovement: true });
      if (p && typeof (p as Promise<void>).catch === 'function') {
        (p as Promise<void>).catch(() => {
          try {
            (el2.requestPointerLock as () => void)();
          } catch {
            /* unsupported — the overlay stays up */
          }
        });
      }
    } catch {
      /* older signature or blocked — leave the overlay up for a click retry */
    }
  }

  private setScopePaused(paused: boolean, overlayText?: string): void {
    const rc = this.run;
    if (!rc || !rc.scope) return;
    if (paused && !rc.paused) {
      rc.paused = true;
      rc.pausedAt = performance.now();
    } else if (!paused && rc.paused) {
      // resume: shift startMs forward by the paused duration so elapsed excludes it
      rc.engine.startMs += performance.now() - rc.pausedAt;
      rc.paused = false;
    }
    const ov = rc.ui.scopeOverlay;
    if (ov) {
      ov.classList.toggle('hidden', !paused);
      if (paused && overlayText) ov.textContent = overlayText;
    }
  }

  private onLockChange = (): void => {
    const rc = this.run;
    if (!rc || !rc.scope || !rc.scopeView) return;
    const locked = document.pointerLockElement === rc.scopeView.element;
    if (locked) {
      this.setScopePaused(false);
    } else if (rc.phase !== 'done') {
      this.setScopePaused(true, 'Paused — click to resume');
    }
  };

  private onScopeMove = (e: MouseEvent): void => {
    const rc = this.run;
    if (!rc || !rc.scope || !rc.scopeView || rc.paused) return;
    if (document.pointerLockElement !== rc.scopeView.element) return; // only under lock
    const v = rc.scopeView;
    // Sensitivity is the same scoped and unscoped: the lens is a pure visual magnifier (no pointer
    // slowdown — the 1/magnification reduction felt too sluggish). So the scope aids perception, not
    // motor precision.
    v.virtualCursor = {
      x: Math.max(0, Math.min(v.fieldPx, v.virtualCursor.x + e.movementX)),
      y: Math.max(0, Math.min(v.fieldPx, v.virtualCursor.y + e.movementY)),
    };
    if (rc.phase === 'playing') rc.pendingPointer = { t: performance.now() - rc.engine.startMs, x: v.virtualCursor.x, y: v.virtualCursor.y };
  };

  private onScopeDown = (e: MouseEvent): void => {
    const rc = this.run;
    if (!rc || !rc.scope || !rc.scopeView || rc.phase === 'done') return;
    if (e.button === 2) {
      this.engageScope('rmb');
      return;
    }
    if (e.button !== 0) return;
    if (document.pointerLockElement !== rc.scopeView.element || rc.paused) return; // must be locked & running
    const eng = rc.engine as GridEngine;
    if (rc.phase === 'ready') {
      rc.phase = 'playing';
      eng.start(performance.now());
      rc.startedAt = new Date().toISOString();
      rc.ui.countdown.classList.add('hidden');
    }
    const now = performance.now();
    this.latency.markKey(now);
    const cell = rc.scopeView.cellAt(rc.scopeView.virtualCursor.x, rc.scopeView.virtualCursor.y);
    const idxBefore = eng.index;
    const tRun = now - eng.startMs;
    const outcome = eng.handleClick(cell, now);
    if (outcome === 'correct') rc.recorder.recordDown(String(cell), idxBefore, 'ok', tRun);
    else if (outcome === 'incorrect') rc.recorder.recordDown(String(cell), idxBefore, 'err', tRun);
    if (outcome !== 'ignored') {
      rc.pendingDownT = tRun;
      rc.pendingDown = true;
    }
  };

  private onScopeUp = (e: MouseEvent): void => {
    if (e.button === 2) this.releaseScope('rmb');
  };

  private onScopeKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Control') return;
    if (e.type === 'keydown') this.engageScope('ctrl');
    else this.releaseScope('ctrl');
  };

  private engageScope(binding: 'rmb' | 'ctrl'): void {
    const rc = this.run;
    if (!rc || !rc.scope || !rc.scopeView || rc.scopeBindings.has(binding)) return;
    rc.scopeBindings.add(binding);
    if (!rc.scoped) {
      rc.scoped = true;
      rc.scopeView.scoped = true;
      rc.activeActivation = { tDown: Math.round((performance.now() - rc.engine.startMs) * 10) / 10, tUp: null, binding };
      rc.activations.push(rc.activeActivation);
    }
  }

  private releaseScope(binding: 'rmb' | 'ctrl'): void {
    const rc = this.run;
    if (!rc || !rc.scope || !rc.scopeView || !rc.scopeBindings.delete(binding)) return;
    if (rc.scopeBindings.size === 0 && rc.scoped) {
      rc.scoped = false;
      rc.scopeView.scoped = false;
      if (rc.activeActivation) rc.activeActivation.tUp = Math.round((performance.now() - rc.engine.startMs) * 10) / 10;
      rc.activeActivation = null;
    }
  }

  // rAF passes a timestamp, but we read performance.now() directly so the render loop and
  // the keydown handler share exactly one clock domain (they're equal in a real browser;
  // this also keeps headless virtual-time captures self-consistent).
  private loop = (): void => {
    const rc = this.run;
    if (!rc) return;
    const now = performance.now();

    if (rc.phase === 'ready') {
      // waiting for the first keypress (handled in onKey); the clock shows its full value, frozen
      rc.ui.time.textContent = rc.timed ? (this.config.durationMs / 1000).toFixed(1) : 'practice';
    }

    if (rc.phase === 'playing' && !rc.paused) {
      if (rc.lastFrameMs >= 0 && now - rc.lastFrameMs > DROPPED_FRAME_MS) rc.droppedFrames++;
      rc.lastFrameMs = now;
      rc.engine.tick(now);
      if (rc.engine.state === 'ended') {
        rc.phase = 'done';
        this.finishRun();
        return;
      }
      this.updateHud(now, rc);
    }

    rc.strip.render(now);
    // GRID/SCOPE: flush the at-most-one pointer (or virtual-cursor) sample since the last frame
    if ((rc.grid || rc.scope) && rc.pendingPointer) {
      rc.recorder.recordPointer(rc.pendingPointer.t, rc.pendingPointer.x, rc.pendingPointer.y);
      rc.pendingPointer = null;
    }
    // this frame is the paint that follows any pending selection → close down→paint proxy
    if (rc.pendingDown) {
      rc.recorder.recordLatency(rc.pendingDownT, now - rc.engine.startMs - rc.pendingDownT);
      rc.pendingDown = false;
    }
    this.latency.frame(now);
    rc.rafId = requestAnimationFrame(this.loop);
  };

  private updateHud(now: number, rc: RunCtx): void {
    const eng = rc.engine;
    if (rc.timed) {
      rc.ui.time.textContent = (eng.remainingMs(now) / 1000).toFixed(1);
    } else {
      rc.ui.time.textContent = (eng.elapsedMs(now) / 1000).toFixed(1) + 's';
    }
    rc.ui.rate.innerHTML = `${eng.liveBitRate(now).toFixed(2)}<span class="unit"> bits/s</span>`;
    const acc = Math.round(eng.liveAccuracy() * 100);
    rc.ui.stats.textContent = `Sc ${eng.sc} · Si ${eng.si} · N ${eng.n} · acc ${acc}%`;
  }

  private abortRun(): void {
    const rc = this.run;
    if (rc) {
      cancelAnimationFrame(rc.rafId);
      rc.cleanup.abort(); // tear down any scope listeners
      if (rc.scope && document.pointerLockElement) document.exitPointerLock();
    }
    this.run = null;
    this.showConfig();
  }

  private finishRun(): void {
    const rc = this.run;
    if (!rc) return;
    cancelAnimationFrame(rc.rafId);
    rc.cleanup.abort();
    if (rc.scope) {
      if (rc.activeActivation) rc.activeActivation.tUp = Math.round((performance.now() - rc.engine.startMs) * 10) / 10;
      if (document.pointerLockElement) document.exitPointerLock();
    }
    const result = rc.engine.result();
    const pointing = rc.grid || rc.scope;
    const gridLog = pointing ? this.buildGridLog(rc) : undefined;
    const scopeLog = rc.scope ? this.buildScopeLog(rc) : undefined;
    const pointerPath = pointing ? rc.recorder.buildPointerPath() : undefined;
    const calibration = rc.grid && this.calibration ? this.calibration : undefined; // session calibration
    // Consume the arm only now, on a run that actually completed and will be logged. Advancing at
    // run START would let an abandoned run eat one half of a pair and leave the block lopsided.
    if (rc.ab) {
      this.abState = abAdvance(this.abState);
      saveAbState(this.abState);
    }
    void this.completeRun(rc, result, gridLog, pointerPath, scopeLog, calibration, rc.ab ?? undefined);
  }

  // Assemble the GRID MODE section of the log. The Fitts difficulty of every selection depends on
  // cellPx/fieldPx/dpr, so they are recorded from the live renderer; the two per-selection arrays
  // line up with the grid `down` events in order.
  private buildGridLog(rc: RunCtx): RunLog['grid'] {
    const v = rc.gridView ?? rc.scopeView; // scope reuses the grid section (it is a grid variant)
    return {
      enabled: true,
      gridSize: v ? v.gridSize : this.config.gridSize,
      depth: rc.scope ? 1 : this.config.gridDepth,
      fieldPx: v ? v.fieldPx : 0,
      cellPx: v ? v.cellPx : 0,
      devicePixelRatio: v ? v.dpr : 1,
      // Read the ENGINE's config, not the app's: under the A/B harness the run's preview setting
      // is the assigned arm, which may differ from what is saved in the config.
      // `ghost` is kept as the derived boolean the analyzer and every pre-existing log speak.
      ghost: rc.engine.config.lookaheadDepth > 0,
      lookahead: rc.engine.config.lookaheadDepth,
      crosshair: rc.engine.config.crosshair,
      hoverPulse: rc.engine.config.hoverPulse,
      pointerType: rc.pointerType || 'mouse',
      ghostAdjacent: rc.ghostAdjacent,
      pointerTypes: rc.pointerTypes,
    };
  }

  // Assemble the SCOPE MODE section: the lens/gain parameters and the scope hold intervals.
  private buildScopeLog(rc: RunCtx): RunLog['scope'] {
    return {
      enabled: true,
      gridSize: this.config.scopeGridSize,
      magnification: this.config.magnification,
      scopedGainFactor: 1, // sensitivity is not reduced while scoped (the lens is visual only)
      lensDiameter: this.config.lensDiameter,
      unadjustedMovement: rc.unadjustedMovement,
      activations: rc.activations,
    };
  }

  // Off the hot path (the run is over): assemble the log, write it if the endpoint is live,
  // then render the report. Falls back to the download button when logging is unavailable.
  private async completeRun(
    rc: RunCtx,
    result: ReturnType<Engine['result']>,
    grid?: RunLog['grid'],
    pointerPath?: RunLog['pointerPath'],
    scope?: RunLog['scope'],
    calibration?: RunLog['calibration'],
    ab?: RunLog['ab'],
  ): Promise<void> {
    const machine = this.machine ?? (await this.machinePromise);
    const log = buildReport(rc.engine, result, {
      recorder: rc.recorder,
      machine,
      mode: rc.timed ? 'scored' : 'practice',
      startedAt: rc.startedAt || new Date().toISOString(),
      droppedFrames: rc.droppedFrames,
      grid,
      pointerPath,
      scope,
      calibration,
      ab,
    });
    this.run = null;

    let logInfo: LogInfo = { available: this.loggingAvailable };
    if (this.loggingAvailable) {
      const res = await postLog(log);
      logInfo = res.ok ? { available: true, path: res.path } : { available: false, reason: res.reason };
    }
    const indexRows: IndexRow[] = this.loggingAvailable ? await fetchIndex(machine.installId) : [];
    this.showReport(log, logInfo, indexRows);
  }

  // --------------------------------------------------------------- report ----
  private showReport(log: RunLog, logInfo: LogInfo, indexRows: IndexRow[]): void {
    this.mode = 'report';
    this.root.replaceChildren();
    renderReport(this.root, log, indexRows, logInfo, {
      onRunAgain: () => this.startRun(true),
      onConfig: () => this.showConfig(),
      onDownload: () => downloadReport(log),
    });
  }
}

export function mount(root: HTMLElement): App {
  return new App(root);
}

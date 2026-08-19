// Screen router + run loop, and nothing else. Three screens (config, run, report); a run waits in a
// "ready" state and its clock starts on the first selection, with no startPrompt.
//
// What lives here is what has to: the single window keydown listener (attached once,
// { passive: false }) and the canvas pointer handlers, which during play are the latency-critical
// path — classify, count, advance, synchronously — plus the rAF loop that reads that state and
// draws. Alongside the scoring log, a RunRecorder buffers a richer event log (down+up, verdict,
// live idx) entirely from primitives, written to logs/ once at run end, never during the 60 s.
//
// What does NOT live here: the config screens (ui/configscreen.ts, pure view functions), the
// auto-players (ui/demo.ts), the log assembly (io/report.ts), the report screen
// (ui/reportview.ts). Each was moved out because it could be — none of them needs the run loop.

import { Engine, type KeyInput } from './v1/engine.js';
import { GridEngine } from './v2/engine.js';
import { StripRenderer } from './v1/view.js';
import { GridRenderer, availableFieldPx, fitTouchGrid, TOUCH_MIN_CELL_PX } from './v2/view.js';
import { AudioFeedback } from './ui/audio.js';
import { LatencyOverlay } from './ui/latency.js';
import { buildReport, downloadReport } from './io/report.js';
import { RunRecorder, postLog, probeHealth, fetchIndex, type IndexRow } from './io/logging.js';
import { probeMachine } from './io/machine.js';
import { renderReport, type LogInfo } from './ui/reportview.js';
import { el } from './ui/dom.js';
import { gridConfigScreen, keyboardConfigScreen, practiceTag } from './ui/configscreen.js';
import { startGridDemo, startKeyboardDemo } from './ui/demo.js';
import { loadConfig, saveConfig, DEFAULT_GRID_CONFIG, type GameConfig, type GridConfig } from './core/config.js';
import type { MachineMeta, RunLog } from './core/stats.js';

const DROPPED_FRAME_MS = 24; // a frame gap this long means at least one 60 fps frame was skipped

// Which app this bundle is (Vite `define`). 'v2' — the delivered game: GRID MODE.
// 'v1' — the legacy falling-lanes keyboard game, deployed at /brm/v1 purely so the design story
// (why the alphabet became a grid) can be demonstrated. v1 is frozen: home rows only, N = 8, no
// top row / chords / challenge / audio experiments. All ongoing work targets v2.
const VARIANT: 'v1' | 'v2' = (typeof __APP_VARIANT__ !== 'undefined' && __APP_VARIANT__ === 'v1' ? 'v1' : 'v2');

/** What every run has, whichever game it is. `phase` is the only state machine: a run waits in
 *  `ready` until the first selection starts its clock, then `playing`, then `done`. */
interface RunCtxBase {
  recorder: RunRecorder;
  timed: boolean;
  phase: 'ready' | 'playing' | 'done';
  startedAt: string; // ISO, stamped when play begins
  droppedFrames: number;
  lastFrameMs: number;
  pendingDownT: number; // run-relative t of a selection awaiting its paint (latency sample)
  pendingDown: boolean;
  rafId: number;
  ui: {
    time: HTMLElement;
    rate: HTMLElement;
    stats: HTMLElement;
    startPrompt: HTMLElement;
    playRoot: HTMLElement;
  };
}

/** GRID MODE: a pointing run. Everything here is meaningless to the keyboard game, which is why it
 *  is a separate arm rather than a pile of nullable fields — `if (rc.grid)` narrows `engine` to
 *  GridEngine and `gridView` to non-null, so the run loop needs no casts and no null checks. */
interface GridRunCtx extends RunCtxBase {
  grid: true;
  engine: GridEngine;
  view: GridRenderer;
  gridView: GridRenderer; // the same object as `view`, named for the pointer wiring
  pendingPointer: { t: number; x: number; y: number } | null; // one path sample per frame
  pointerType: string; // modal pointer type across the run
  ghostAdjacent: number[]; // per down-event, was the next target within a couple cells
  pointerTypes: string[]; // per down-event pointer type
  touchSized: boolean; // the grid was sized for a fingertip, not fixed at the desktop N
}

/** The v1 keyboard game: falling lanes, scored on keydown. */
interface KeyRunCtx extends RunCtxBase {
  grid: false;
  engine: Engine;
  view: StripRenderer;
}

type RunCtx = GridRunCtx | KeyRunCtx;

export class App {
  private mode: 'config' | 'run' | 'report' = 'config';
  private config: GameConfig = VARIANT === 'v1' ? loadConfig('keyboard') : loadConfig('grid');
  private readonly audio = new AudioFeedback(this.config.sound);
  private readonly latency: LatencyOverlay;
  private run: RunCtx | null = null;

  // gathered once at startup; awaited (long-settled) when a run finishes
  private machine: MachineMeta | null = null;
  private readonly machinePromise: Promise<MachineMeta>;
  private loggingAvailable = false;

  constructor(private readonly root: HTMLElement) {
    const params = new URLSearchParams(location.search);
    this.latency = new LatencyOverlay(params.has('debug'));
    // Every control and URL parameter these fields used to have is gone, but a config saved while
    // they existed still carries their values — lookaheadDepth: 2, or a gridSize a retired
    // calibrator picked (12 and 48 both shipped as recommendations). Left alone they would go on
    // steering every run with nothing on screen to explain it and no way to turn it off: a
    // returning player would be locked to 12×12 forever.
    //
    // `grid` is no longer in this list, and could not be: which game this is now lives in the
    // config's own `mode`, keyed separately in storage, so a v1 config is not something a v2 build
    // can read back. That used to be a normalisation; it is now a type.
    if (this.config.mode === 'grid') {
      this.config = {
        ...this.config,
        lookaheadDepth: DEFAULT_GRID_CONFIG.lookaheadDepth,
        gridSize: DEFAULT_GRID_CONFIG.gridSize,
      };
      saveConfig(this.config); // persist the normalisation, so it survives even if no run is played
    }

    this.machinePromise = probeMachine().then((m) => (this.machine = m));
    void probeHealth().then((ok) => (this.loggingAvailable = ok));

    // one listener each for the whole app; game input is handled synchronously here.
    window.addEventListener('keydown', this.onKey, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('resize', () => this.run?.view.resize());

    // Dev aid: ?auto=practice|scored skips the config screen; add &demo to auto-type
    // (dispatches real keydowns, so it drives the same input path a human would).
    //
    // These two are the only parameters left, and neither can change WHAT is played. There is no
    // grid-size, lookahead or A/B parameter: each of those questions has been answered and the
    // answer IS the game — 32×32, ghost on at lookahead 1 (worth +2.46 bits/s over none; a second
    // preview adds only a sixth of that). A parameter that could still change them is a way to
    // write a log that claims to be this game and is not.
    //
    // Render the config screen only AFTER the dev aids have had their say. It states the N it is
    // about to play, and a dev aid applied to an already-rendered screen would leave it claiming
    // one N while the run scored another — the screen lying about the run it starts.
    this.showConfig();

    const auto = params.get('auto');
    if (auto === 'practice' || auto === 'scored') {
      // Dev-only: ?secs=N shortens JUST this capture run so a full run→report can be driven
      // headlessly. Never affects a real scored run (which is always 60 s).
      const secs = Number(params.get('secs'));
      if (Number.isFinite(secs) && secs >= 1 && secs <= 60) {
        this.config = { ...this.config, durationMs: Math.round(secs * 1000) };
      }
      this.startRun(auto === 'scored', true); // start immediately (skip the ready wait) for headless capture
      if (params.has('demo')) {
        // The source closures let the demo end itself when the run does, without it holding a
        // reference to a RunCtx that finishRun has already replaced with null.
        if (this.config.mode === 'grid') {
          startGridDemo(() => {
            const rc = this.run;
            return rc?.grid && rc.phase !== 'done' ? { engine: rc.engine, view: rc.gridView } : null;
          });
        } else {
          startKeyboardDemo(() => {
            const rc = this.run;
            return rc && !rc.grid && rc.phase === 'playing' ? rc.engine : null;
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------- input ----
  private onKey = (e: KeyboardEvent): void => {
    if (this.mode !== 'run' || !this.run) return; // config/report use normal DOM controls
    if (e.key === 'Escape') {
      e.preventDefault();
      this.abortRun();
      return;
    }
    const rc = this.run;
    if (rc.phase === 'done') return;
    if (rc.grid) return; // GRID MODE scores on pointerdown, not keys
    const eng = rc.engine;
    // No countdown, no 3-2-1: the run's clock starts when you first type an in-alphabet target,
    // and this same
    // keydown falls through and is scored as the first selection.
    if (rc.phase === 'ready') {
      if (!eng.alphaSet.has(e.key) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      this.beginPlay(rc);
    }
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
    if (this.mode !== 'run' || !rc || rc.phase !== 'playing' || rc.grid) return;
    const eng = rc.engine;
    if (!eng.alphaSet.has(e.key)) return;
    const now = performance.now();
    rc.recorder.recordUp(e.key, eng.index, now - eng.startMs);
  };

  // ------------------------------------------------------- GRID MODE input ----
  // Pointing selections: score on pointerdown (the earliest committed moment — the click event
  // fires on pointer-up and would waste the press→release interval). Hit-test is pure arithmetic
  // against the canvas, never per-cell DOM. Runs the same ready→playing start-on-first-selection
  // as the keyboard path, then falls through to score that first pointerdown.
  private onGridPointerDown = (e: PointerEvent): void => {
    const rc = this.run;
    if (this.mode !== 'run' || !rc || !rc.grid || rc.phase === 'done') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // ignore modified clicks (spec §1)
    e.preventDefault();
    const eng = rc.engine;
    if (rc.phase === 'ready') this.beginPlay(rc);
    const now = performance.now();
    this.latency.markKey(now);
    const cell = rc.gridView.cellAt(e.clientX, e.clientY);
    const idxBefore = eng.index;
    const tRun = now - eng.startMs;
    const ghostAdjacent = rc.gridView.ghostAdjacent();
    const outcome = eng.handleClick(cell, now);
    const pType = e.pointerType || 'mouse';
    if (!rc.pointerType) rc.pointerType = pType; // first observed = modal (mixed input is rare)
    // One 'ok' event per completed selection, one 'err' per wrong click — so one 'ok' equals one
    // scored selection, which the whole report/stats layer assumes.
    if (outcome === 'correct') {
      rc.recorder.recordDown(String(eng.lastCorrectCell), idxBefore, 'ok', tRun);
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
    if (this.mode !== 'run' || !rc || !rc.grid) return;
    rc.gridView.hoverCell = rc.gridView.cellAt(e.clientX, e.clientY);
    if (rc.phase === 'playing') {
      const p = rc.gridView.localPoint(e.clientX, e.clientY);
      rc.pendingPointer = { t: performance.now() - rc.engine.startMs, x: p.x, y: p.y };
    }
  };

  // --------------------------------------------------------------- config ----
  // Routing only: pick the screen this variant configures, hand it the current config and the one
  // callback it needs, and mount it. The screens themselves are pure view functions in
  // ui/configscreen.ts and know nothing about App.
  private showConfig(msg?: string): void {
    this.mode = 'config';
    this.run = null;
    this.root.replaceChildren();
    const opts = { coarsePointer: this.coarsePointer(), message: msg };
    this.root.append(
      this.config.mode === 'keyboard'
        ? keyboardConfigScreen(this.config, opts, {
            onStart: (config, timed) => {
              this.commit(config);
              this.startRun(timed);
            },
          })
        : gridConfigScreen(this.config, opts, {
            onStart: (config, timed) => {
              this.commit(config);
              this.startRun(timed);
            },
          }),
    );
  }

  private commit(c: GameConfig): void {
    this.config = c;
    saveConfig(c);
    this.audio.setEnabled(c.sound);
  }

  // ------------------------------------------------------------------ run ----
  private startRun(timed: boolean, immediate = false): void {
    if (this.config.mode === 'grid') {
      this.startGridRun(timed, immediate, this.config);
      return;
    }
    const config = this.config; // narrowed to KeyboardConfig by the branch above
    this.mode = 'run';
    this.root.replaceChildren();
    if (config.sound) this.audio.unlock(); // user gesture (button click) is active

    const engine = new Engine(config, timed);
    engine.onError = () => this.audio.error();

    const playRoot = el('div', { class: 'play-root' });
    // shown until the first keypress: the run's clock starts when you type, no 3-2-1 countdown
    const startPrompt = el('div', { class: 'start-prompt', text: 'type the highlighted key to start' });

    const { screen, ...ui } = this.runScreen(timed, playRoot, startPrompt);
    this.root.append(screen);

    const strip = new StripRenderer(engine, playRoot);
    this.run = { engine, view: strip, grid: false, ...this.baseRunCtx(timed, immediate, ui) };
    if (immediate) this.beginPlay(this.run);
    this.run.rafId = requestAnimationFrame(this.loop);
  }

  // GRID MODE run: a pointing game on a canvas grid. Shares the run loop, HUD, latency proxy, and
  // logging with the keyboard path, but builds a GridEngine + canvas renderer and wires pointer
  // handlers instead of the keyboard strip.
  private startGridRun(timed: boolean, immediate: boolean, config: GridConfig): void {
    this.mode = 'run';
    this.root.replaceChildren();
    if (this.config.sound) this.audio.unlock(); // the Start-button click is the unlocking gesture

    const playRoot = el('div', { class: 'play-root grid-root' });
    // Same vocabulary as the start page, and the same colour on the word: this sits over the field
    // with a real orange square already drawn on it, so naming the thing beats describing it. A
    // playtester read "the highlighted cell" and could not tell which of the two marked cells it
    // meant — the filled one or the outlined preview.
    // Wrapped in one span because .startPrompt is a flex container: as three direct children the
    // text nodes become flex items and the spaces between them are dropped ("click theorangesquare").
    const startPrompt = el('div', { class: 'start-prompt' }, [
      el('span', {}, [
        document.createTextNode('click the '),
        el('span', { class: 'ink-target', text: 'orange' }),
        document.createTextNode(' square to start'),
      ]),
    ]);

    const { screen, ...ui } = this.runScreen(timed, playRoot, startPrompt);
    this.root.append(screen);

    // Size the grid AFTER the screen is in the document, because on a coarse pointer the choice
    // depends on how much room there actually is — and only a laid-out element knows that.
    //
    // WHY THE GRID SHRINKS ON TOUCH. 32×32 on a phone is a 9px cell against a ~40px fingertip: not
    // hard, unplayable. And widening the field cannot fix it — the grid is a square, so the smaller
    // viewport dimension binds, and on a portrait phone that is already the full width. The only
    // lever is fewer, bigger cells, so a coarse pointer gets the finest grid whose cells still clear
    // TOUCH_MIN_CELL_PX (≈ 6² on a phone, ≈ 16² on a tablet).
    //
    // This is chosen ONCE, at run start, and held for the whole run: N is in the score, so a grid
    // that resized mid-run (rotating the phone) would make the run's own bit rate meaningless.
    const avail = availableFieldPx(playRoot.clientWidth || window.innerWidth, playRoot.clientHeight || 360);
    const coarse = this.coarsePointer();
    const gridSize = coarse ? fitTouchGrid(avail) : config.gridSize;
    const runConfig: GridConfig = gridSize === config.gridSize ? config : { ...config, gridSize };

    const engine = new GridEngine(runConfig, timed);
    engine.onCorrect = () => this.audio.bloop(); // hit: rising bloop (+ particle burst in the renderer)
    // no wrong-cell buzzer — the red flash (drawn by the renderer) is the only miss feedback

    const gridView = new GridRenderer(engine, playRoot);
    const canvas = gridView.element;
    canvas.style.cursor = 'crosshair';
    // pointer input lives on the canvas element, so it is torn down automatically when the screen
    // is replaced. pointerdown scores; pointermove drives the pulse + path sampling.
    canvas.addEventListener('pointerdown', this.onGridPointerDown);
    canvas.addEventListener('pointermove', this.onGridPointerMove);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.style.touchAction = 'none'; // no scroll/zoom gestures stealing the pointerdown

    this.run = {
      engine,
      view: gridView,
      gridView,
      grid: true,
      pendingPointer: null,
      pointerType: '',
      ghostAdjacent: [],
      pointerTypes: [],
      touchSized: coarse,
      ...this.baseRunCtx(timed, immediate, ui),
    };
    if (immediate) this.beginPlay(this.run);
    this.run.rafId = requestAnimationFrame(this.loop);
  }

  /** Is the primary pointer a finger? `(pointer: coarse)` asks about INPUT, not screen size, so a
   *  touchscreen laptop and a small desktop window are classified correctly where a width
   *  breakpoint would get both wrong. matchMedia is absent in some headless/test environments. */
  private coarsePointer(): boolean {
    try {
      return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    } catch {
      return false;
    }
  }

  /** Start the clock. There is no countdown: a run sits in `ready` until the first selection, and
   *  that same event is then scored — so this fires from BOTH input paths (keydown for v1, and
   *  pointerdown for the grid) and has to mean exactly the same thing in each. */
  private beginPlay(rc: RunCtx): void {
    rc.phase = 'playing';
    rc.engine.start(performance.now());
    rc.startedAt = new Date().toISOString();
    rc.ui.startPrompt.classList.add('hidden');
  }

  /** The run screen's chrome — clock, play area, readout, and the practice exit. Identical for both
   *  games; only the thing mounted into `playRoot` differs. */
  private runScreen(timed: boolean, playRoot: HTMLElement, startPrompt: HTMLElement): RunCtx['ui'] & { screen: HTMLElement } {
    const time = el('div', { class: 'time' });
    const rate = el('div', { class: 'rate' });
    const stats = el('div', { class: 'stats' });
    const screen = el('div', { class: 'screen run' }, [
      time,
      el('div', { class: 'play-wrap' }, [playRoot, startPrompt]),
      el('div', { class: 'readout' }, [rate, stats]),
      ...(timed ? [] : [practiceTag(this.coarsePointer(), () => this.abortRun())]),
    ]);
    return { time, rate, stats, startPrompt, playRoot, screen };
  }

  /** The fields every run starts with, whichever game it is. */
  private baseRunCtx(timed: boolean, immediate: boolean, ui: RunCtx['ui']): Omit<RunCtxBase, 'recorder'> & { recorder: RunRecorder } {
    return {
      recorder: new RunRecorder(),
      timed,
      phase: immediate ? 'playing' : 'ready',
      startedAt: '',
      droppedFrames: 0,
      lastFrameMs: -1,
      pendingDownT: 0,
      pendingDown: false,
      rafId: 0,
      ui,
    };
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

    if (rc.phase === 'playing') {
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

    rc.view.render(now);
    // GRID: flush the at-most-one pointer sample taken since the last frame
    if (rc.grid && rc.pendingPointer) {
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
    if (this.run) cancelAnimationFrame(this.run.rafId);
    this.run = null;
    this.showConfig();
  }

  private finishRun(): void {
    const rc = this.run;
    if (!rc) return;
    cancelAnimationFrame(rc.rafId);
    const result = rc.engine.result();
    const gridLog = rc.grid ? this.buildGridLog(rc) : undefined;
    const pointerPath = rc.grid ? rc.recorder.buildPointerPath() : undefined;
    void this.completeRun(rc, result, gridLog, pointerPath);
  }

  // Assemble the GRID MODE section of the log. The Fitts difficulty of every selection depends on
  // cellPx/fieldPx/dpr, so they are recorded from the live renderer; the two per-selection arrays
  // line up with the grid `down` events in order.
  private buildGridLog(rc: GridRunCtx): RunLog['grid'] {
    // The renderer is authoritative for what was actually drawn, and on a GridRunCtx it always
    // exists — the union guarantees it, so there is no fallback to write.
    const v = rc.gridView;
    return {
      enabled: true,
      gridSize: v.gridSize,
      depth: 1, // one cell per selection. Kept in the log so the analyzer can still filter the
      // stacked-layer runs in logs/ out of the grid sweep — see GridLog.depth.
      // How N was chosen. 'touch' runs played a coarser grid with a different input device, so they
      // are a separate modality and the analyzer must never pool them with 'fixed' runs.
      sizing: rc.touchSized ? 'touch' : 'fixed',
      minCellPx: rc.touchSized ? TOUCH_MIN_CELL_PX : undefined,
      fieldPx: v.fieldPx,
      cellPx: v.cellPx,
      devicePixelRatio: v.dpr,
      // `ghost` is the derived boolean the analyzer and every pre-existing log speak; `lookahead`
      // is the value itself. Read from the ENGINE, so the log states what was actually rendered.
      ghost: rc.engine.config.lookaheadDepth > 0,
      lookahead: rc.engine.config.lookaheadDepth,
      crosshair: rc.engine.config.crosshair,
      hoverPulse: rc.engine.config.hoverPulse,
      pointerType: rc.pointerType || 'mouse',
      ghostAdjacent: rc.ghostAdjacent,
      pointerTypes: rc.pointerTypes,
    };
  }

  // Off the hot path (the run is over): assemble the log, write it if the endpoint is live,
  // then render the report. Falls back to the download button when logging is unavailable.
  private async completeRun(
    rc: RunCtx,
    result: ReturnType<Engine['result']>,
    grid?: RunLog['grid'],
    pointerPath?: RunLog['pointerPath'],
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

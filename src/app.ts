// Screen router + run loop. Three screens (config, run, report); a run waits in a "ready" state
// and its clock starts on the first keypress (no countdown). A single window keydown listener
// (attached once, { passive:false }) drives the whole app; during play it is the latency-critical
// path — classify, count, advance,
// synchronously — while a separate rAF loop reads state and draws. Alongside the scoring
// log, a RunRecorder buffers a richer event log (down+up, verdict, live idx) entirely from
// primitives, written to logs/ once at run end — never during the 60 s.

import { Engine, type KeyInput } from './engine.js';
import { GridEngine } from './gridengine.js';
import { StripRenderer } from './strip.js';
import { GridRenderer } from './gridview.js';
import { ScopeRenderer } from './gridscope.js';
import { AudioFeedback, laneToneHz } from './audio.js';
import { PacerController } from './pacer.js';
import { LatencyOverlay } from './latency.js';
import { buildReport, downloadReport } from './report.js';
import { RunRecorder, postLog, probeHealth, fetchIndex, type IndexRow } from './logging.js';
import { probeMachine } from './machine.js';
import { renderReport, type LogInfo } from './reportview.js';
import { loadConfig, saveConfig, laneAudio, GRID_SIZES, DEFAULT_CONFIG, CHALLENGE_SEED_HZ, CHALLENGE_LEAD_BEATS, type GameConfig } from './config.js';
import { symbolFor } from './scoring.js';
import type { MachineMeta, RunLog, ScopeActivation } from './stats.js';

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
  pacer: PacerController | null; // the tempo controller (null when the pacer is off for this run)
  pacerStarted: boolean; // whether the click scheduler has been kicked off yet
  challengeBeat: number; // challenge mode: cumulative beat position, integrated from the pacer tempo
  droppedFrames: number;
  lastFrameMs: number;
  pendingDownT: number; // run-relative t of a keydown awaiting its paint (latency sample)
  pendingDown: boolean;
  pendingPointer: { t: number; x: number; y: number } | null; // GRID: one path sample per frame
  pointerType: string; // GRID: modal pointer type across the run
  ghostAdjacent: number[]; // GRID: per down-event, was the next target within a couple cells
  pointerTypes: string[]; // GRID: per down-event pointer type
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
  private mode: 'config' | 'run' | 'report' = 'config';
  private config: GameConfig = loadConfig();
  private readonly audio = new AudioFeedback(this.config.sound);
  private readonly latency: LatencyOverlay;
  private run: RunCtx | null = null;
  private spaceHeld = false; // chord modifier state (thumb on the spacebar)
  private toneTable = new Map<string, { freq: number; hand: 0 | 1 }>(); // base key → tone, rebuilt per run

  // gathered once at startup; awaited (long-settled) when a run finishes
  private machine: MachineMeta | null = null;
  private readonly machinePromise: Promise<MachineMeta>;
  private loggingAvailable = false;

  constructor(private readonly root: HTMLElement) {
    const params = new URLSearchParams(location.search);
    this.latency = new LatencyOverlay(params.has('debug'));

    this.machinePromise = probeMachine().then((m) => (this.machine = m));
    void probeHealth().then((ok) => (this.loggingAvailable = ok));

    // one listener each for the whole app; game input is handled synchronously here.
    window.addEventListener('keydown', this.onKey, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('resize', () => this.run?.strip.resize());
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
        if (this.config.chords) {
          const keys = [...eng.target()];
          if (Math.random() < errorRate && keys.length) {
            const others = eng.chars.filter((c) => !keys.includes(c));
            if (others.length) keys[Math.floor(Math.random() * keys.length)] = others[Math.floor(Math.random() * others.length)];
          }
          for (const k of keys) window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
          window.setTimeout(() => {
            for (const k of keys) window.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }));
          }, 40);
        } else {
          const sym = eng.target();
          const wantStar = sym.endsWith('*');
          let base = wantStar ? sym.slice(0, -1) : sym;
          if (Math.random() < errorRate) {
            const others = eng.chars.filter((c) => c !== base);
            base = others[Math.floor(Math.random() * others.length)] ?? base;
          }
          if (wantStar) window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
          window.dispatchEvent(new KeyboardEvent('keydown', { key: base, bubbles: true }));
          window.setTimeout(() => {
            window.dispatchEvent(new KeyboardEvent('keyup', { key: base, bubbles: true }));
            if (wantStar) window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
          }, 30);
        }
      }
      window.setTimeout(tick, (this.config.chords ? 320 : 70) + Math.random() * 80);
    };
    window.setTimeout(tick, 200);
  }

  // ---------------------------------------------------------------- input ----
  private onKey = (e: KeyboardEvent): void => {
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
    // spacebar is the chord modifier, not a selection — track it and never let it score/scroll
    if (this.config.chord && e.key === ' ') {
      e.preventDefault();
      this.spaceHeld = true;
      return;
    }
    const eng = eng0;
    const inAlpha = eng.alphaSet.has(e.key);
    const modified = e.ctrlKey || e.metaKey || e.altKey;
    if (inAlpha && !modified) e.preventDefault();
    const now = performance.now();
    this.latency.markKey(now);
    const input: KeyInput = {
      key: e.key,
      repeat: e.repeat,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      space: this.spaceHeld,
    };
    const idxBefore = eng.index;
    const tRun = now - eng.startMs;
    const outcome = eng.handleKey(input, now);
    if (this.config.chords) {
      // chords are scored on release; log the keydown with a placeholder verdict
      if (inAlpha && !modified && !e.repeat) {
        rc.recorder.recordDown(e.key, idxBefore, 'ok', tRun);
        rc.pendingDownT = tRun;
        rc.pendingDown = true;
      }
      return;
    }
    if (outcome === 'correct' || outcome === 'incorrect') {
      const produced = symbolFor(e.key, this.spaceHeld, this.config.chord);
      rc.recorder.recordDown(produced, idxBefore, outcome === 'correct' ? 'ok' : 'err', tRun);
      rc.pendingDownT = tRun; // measure this keydown → next paint for the latency samples
      rc.pendingDown = true;
      // feed the pacer's rate estimate (reads only; the pacer cannot affect this outcome)
      if (outcome === 'correct') {
        rc.pacer?.recordCorrect(tRun);
        this.triggerTargetTone(rc); // the resolved target's tone releases, the next one's starts
      } else rc.pacer?.recordError(tRun);
    } else if (!inAlpha && !modified && !e.repeat && e.key.length === 1) {
      rc.recorder.outOfAlphabet++; // a genuine out-of-alphabet character (not a modifier/nav key)
    }
  };

  // Key releases are logged (in-alphabet only — never free text) so rollover, the next key
  // going down before the previous comes up, is measurable. Not part of scoring.
  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === ' ') this.spaceHeld = false;
    const rc = this.run;
    if (this.mode !== 'run' || !rc || rc.phase !== 'playing' || rc.grid || rc.scope) return;
    const eng0 = rc.engine as Engine;
    if (!eng0.alphaSet.has(e.key)) return;
    const now = performance.now();
    if (this.config.chords) {
      const oc = eng0.handleKeyUp(e.key, now); // completes a chord on last release
      const tRun = now - eng0.startMs;
      if (oc === 'correct') rc.pacer?.recordCorrect(tRun);
      else if (oc === 'incorrect') rc.pacer?.recordError(tRun);
    }
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

  // --------------------------------------------------------------- config ----
  private showConfig(): void {
    this.mode = 'config';
    this.run = null;
    this.root.replaceChildren();

    const gridSize = el('select', { class: 'field-input mono' },
      GRID_SIZES.map((sz) =>
        el('option', { value: String(sz), ...(this.config.gridSize === sz ? { selected: true } : {}), text: `${sz} × ${sz}  ·  N = ${sz * sz}` }),
      ),
    ) as HTMLSelectElement;

    const field = (label: string, control: Node, hint?: string): HTMLElement =>
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: label }),
        control,
        ...(hint ? [el('span', { class: 'field-hint', text: hint })] : []),
      ]);

    // Grid is the singular mode now; the config screen picks only the grid size. Everything else
    // (the retired keyboard/chords/challenge/scope machinery) stays fixed at its default.
    const collect = (): GameConfig => ({
      ...DEFAULT_CONFIG,
      grid: true,
      scope: false,
      gridSize: Number(gridSize.value) || 32,
    });

    const startPractice = (): void => {
      this.commit(collect());
      this.startRun(false);
    };
    const startScored = (): void => {
      this.commit(collect());
      this.startRun(true);
    };

    this.root.append(
      el('div', { class: 'screen config' }, [
        el('h1', { class: 'title', text: 'Bit-Rate Maximizer' }),
        el('p', { class: 'subtitle', text: 'Click the highlighted cell as fast and as accurately as you can. Correct clicks add bits; errors subtract — so accuracy is worth about twice raw speed. A bigger grid packs more bits per click, but the targets are smaller.' }),
        el('div', { class: 'config-grid' }, [
          field('Grid size', gridSize, 'More cells = more bits per correct click, but smaller targets.'),
        ]),
        el('div', { class: 'field-note', text: 'Duration is locked to 60 s for scored runs.' }),
        el('div', { class: 'buttons' }, [
          el('button', { class: 'btn ghost', onclick: startPractice, text: 'Practice' }),
          el('button', { class: 'btn primary', onclick: startScored, text: 'Start scored run' }),
        ]),
        el('p', { class: 'consent', text: 'Runs are saved locally and never transmitted anywhere.' }),
      ]),
    );
    gridSize.focus();
  }

  private commit(c: GameConfig): void {
    this.config = c;
    saveConfig(c);
    this.audio.setEnabled(c.sound);
  }

  // ------------------------------------------------------------------ run ----
  private startRun(timed: boolean, immediate = false): void {
    if (this.config.scope) {
      this.startScopeRun(timed, immediate);
      return;
    }
    if (this.config.grid) {
      this.startGridRun(timed, immediate);
      return;
    }
    this.mode = 'run';
    this.spaceHeld = false;
    // A/B mode: override this run's audio condition with a randomly drawn arm (not saved to config,
    // so the assignment is per-run). Challenge mode is its own thing and opts out.
    if (this.config.abTest && !this.config.challenge) {
      const arm = this.drawArm();
      this.config = { ...this.config, tones: arm === 'tones', pacer: arm === 'pacer' ? 'proportional' : 'off' };
    }
    this.root.replaceChildren();
    if (this.config.sound) this.audio.unlock(); // user gesture (button click) is active
    this.audio.voiceStealEvents = 0; // reset the per-run tone stat

    const engine = new Engine(this.config, timed);
    // target tones: pitch ascends left→right (major pentatonic), hand carried by timbre + pan. The
    // tone is gated to each target's lifetime, triggered from the advance point (not the loop).
    this.toneTable = new Map([...laneAudio(this.config)].map(([ch, { lane, hand }]) => [ch, { freq: laneToneHz(lane), hand }]));
    engine.onCorrect = this.config.chords ? () => this.audio.correct() : null;
    engine.onError = () => this.audio.error();

    // The pacer is a training device: on by default only in practice; scored runs measure the
    // player unaided unless they explicitly opt in. It only reads rate/B and emits sound — it can
    // never gate scoring or advancement (spec §1).
    // In challenge mode the pacer beat drives the scroll rate, so it always runs; otherwise it's a
    // practice-by-default click (scored only on opt-in).
    const pacerOn = this.config.pacer !== 'off' && (this.config.challenge || (timed ? this.config.pacerScored : true));
    const pacer = pacerOn
      ? new PacerController({ mode: this.config.pacer, push: this.config.pacerPush, logBits: engine.logBits })
      : null;

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
      pacer,
      pacerStarted: false,
      challengeBeat: 0,
      droppedFrames: 0,
      lastFrameMs: -1,
      pendingDownT: 0,
      pendingDown: false,
      pendingPointer: null,
      pointerType: '',
      ghostAdjacent: [],
      pointerTypes: [],
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
  // handlers instead of the keyboard strip. No pacer/tones/chords/challenge here.
  private startGridRun(timed: boolean, immediate = false): void {
    this.mode = 'run';
    this.root.replaceChildren();

    const engine = new GridEngine(this.config, timed);
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
    ]);
    this.root.append(screen);

    const gridView = new GridRenderer(engine, stripRoot);
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
      pacer: null,
      pacerStarted: false,
      challengeBeat: 0,
      droppedFrames: 0,
      lastFrameMs: -1,
      pendingDownT: 0,
      pendingDown: false,
      pendingPointer: null,
      pointerType: '',
      ghostAdjacent: [],
      pointerTypes: [],
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
      pacer: null,
      pacerStarted: false,
      challengeBeat: 0,
      droppedFrames: 0,
      lastFrameMs: -1,
      pendingDownT: 0,
      pendingDown: false,
      pendingPointer: null,
      pointerType: 'mouse',
      ghostAdjacent: [],
      pointerTypes: [],
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
      const dtMs = rc.lastFrameMs >= 0 ? Math.min(64, now - rc.lastFrameMs) : 16;
      if (rc.lastFrameMs >= 0 && now - rc.lastFrameMs > DROPPED_FRAME_MS) rc.droppedFrames++;
      rc.lastFrameMs = now;
      // CHALLENGE MODE: integrate the scroll rate (the pacer's tempo, or a seed until it establishes)
      // into a beat position; the engine scores misses and the strip scrolls from the same value.
      if (this.config.challenge) {
        const tempo = rc.pacer && rc.pacer.started ? rc.pacer.currentTempo : CHALLENGE_SEED_HZ;
        rc.challengeBeat += tempo * (dtMs / 1000);
        (rc.engine as Engine).challengeProgress = rc.challengeBeat - CHALLENGE_LEAD_BEATS; // keyboard-only
      }
      rc.engine.tick(now);
      if (rc.engine.state === 'ended') {
        rc.phase = 'done';
        this.finishRun();
        return;
      }
      this.updateHud(now, rc);
      // Adaptive pacer: recompute the target tempo from the measured rate and retune the click
      // track. This only reads state and emits sound — it never touches sc/si/index.
      if (rc.pacer) {
        const hz = rc.pacer.update(now - rc.engine.startMs);
        if (hz !== null) {
          if (!rc.pacerStarted) rc.pacerStarted = this.audio.startPacer(hz, this.config.pacerVolume);
          else this.audio.setPacerTempo(hz);
        }
      }
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

  // Fire-and-forget: sound the current target's tone (releasing the previous). Single-key only —
  // chords have no single lane. Called from the advance point, never before state advances.
  private triggerTargetTone(rc: RunCtx): void {
    if (this.config.chords || !this.config.tones) return;
    const tone = this.toneTable.get((rc.engine as Engine).target());
    if (tone) this.audio.toneAdvance(tone.freq, tone.hand);
  }

  // A/B: draw the next condition from a shuffled bag of [none, pacer, tones], refilling when empty,
  // so the three arms stay balanced and their order is randomized (not confounded with the practice
  // curve). The bag persists in localStorage so it survives reloads mid-experiment.
  private drawArm(): 'none' | 'pacer' | 'tones' {
    const KEY = 'brm.ab.bag';
    let bag: string[] = [];
    try {
      bag = JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[];
    } catch {
      bag = [];
    }
    if (!Array.isArray(bag) || bag.length === 0) {
      bag = ['none', 'pacer', 'tones'];
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    const arm = (bag.pop() ?? 'none') as 'none' | 'pacer' | 'tones';
    try {
      localStorage.setItem(KEY, JSON.stringify(bag));
    } catch {
      /* ignore */
    }
    return arm;
  }

  private updateHud(now: number, rc: RunCtx): void {
    const eng = rc.engine;
    if (rc.timed) {
      rc.ui.time.textContent = (eng.remainingMs(now) / 1000).toFixed(1);
    } else {
      rc.ui.time.textContent = (eng.elapsedMs(now) / 1000).toFixed(1) + 's';
    }
    rc.ui.rate.innerHTML = `${eng.liveBitRate(now).toFixed(2)}<span class="unit"> bits/s</span>`;
    const acc = Math.round(eng.liveAccuracy() * 100);
    // ♪N = pacer beats scheduled so far — a visible check that the click track is running
    const paced = rc.pacer ? ` · ♪${this.audio.pacerBeats()}` : '';
    rc.ui.stats.textContent = `Sc ${eng.sc} · Si ${eng.si} · N ${eng.n} · acc ${acc}%${paced}`;
  }

  private abortRun(): void {
    const rc = this.run;
    if (rc) {
      cancelAnimationFrame(rc.rafId);
      rc.cleanup.abort(); // tear down any scope listeners
      if (rc.scope && document.pointerLockElement) document.exitPointerLock();
    }
    this.audio.releaseAllTones();
    this.audio.stopPacer();
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
    this.audio.releaseAllTones();
    const clickAbs = this.audio.stopPacer(); // absolute performance.now() ms
    const pacerLog = this.buildPacerLog(rc, clickAbs);
    const tonesLog: RunLog['tones'] = {
      enabled: this.config.tones && !this.config.chords,
      scale: 'pentatonic',
      baseHz: 523.25,
      handCoding: 'timbre+pan',
      voiceStealEvents: this.audio.voiceStealEvents,
    };
    const result = rc.engine.result();
    const pointing = rc.grid || rc.scope;
    const gridLog = pointing ? this.buildGridLog(rc) : undefined;
    const scopeLog = rc.scope ? this.buildScopeLog(rc) : undefined;
    const pointerPath = pointing ? rc.recorder.buildPointerPath() : undefined;
    void this.completeRun(rc, result, pacerLog, tonesLog, gridLog, pointerPath, scopeLog);
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
      ghost: this.config.ghost,
      crosshair: this.config.crosshair,
      hoverPulse: this.config.hoverPulse,
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

  // Assemble the pacer section of the log. clickTimes are shifted to the run-relative clock the
  // event log uses, so phase analysis can line them up without guessing the offset.
  private buildPacerLog(rc: RunCtx, clickAbs: number[]): RunLog['pacer'] {
    const p = rc.pacer;
    if (!p) return { enabled: false };
    const r3 = (x: number): number | null => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
    return {
      enabled: true,
      mode: this.config.pacer,
      push: this.config.pacerPush,
      startTempoHz: r3(p.startTempoHz),
      endTempoHz: r3(p.endTempoHz),
      clickTimes: clickAbs.map((t) => Math.round((t - rc.engine.startMs) * 1000) / 1000),
      tempoChanges: p.tempoChanges.map((c) => ({ t: Math.round(c.t * 1000) / 1000, hz: Math.round(c.hz * 1000) / 1000 })),
    };
  }

  // Off the hot path (the run is over): assemble the log, write it if the endpoint is live,
  // then render the report. Falls back to the download button when logging is unavailable.
  private async completeRun(
    rc: RunCtx,
    result: ReturnType<Engine['result']>,
    pacer: RunLog['pacer'],
    tones: RunLog['tones'],
    grid?: RunLog['grid'],
    pointerPath?: RunLog['pointerPath'],
    scope?: RunLog['scope'],
  ): Promise<void> {
    const machine = this.machine ?? (await this.machinePromise);
    const log = buildReport(rc.engine, result, {
      recorder: rc.recorder,
      machine,
      mode: rc.timed ? 'scored' : 'practice',
      startedAt: rc.startedAt || new Date().toISOString(),
      droppedFrames: rc.droppedFrames,
      pacer,
      tones,
      grid,
      pointerPath,
      scope,
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

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
import { GridRenderer, availableFieldPx, fitTouchGrid, TOUCH_MIN_CELL_PX } from './v2/view.js';
import { AudioFeedback } from './ui/audio.js';
import { LatencyOverlay } from './ui/latency.js';
import { buildReport, downloadReport } from './io/report.js';
import { RunRecorder, postLog, probeHealth, fetchIndex, type IndexRow } from './io/logging.js';
import { probeMachine } from './io/machine.js';
import { renderReport, type LogInfo } from './ui/reportview.js';
import { loadConfig, saveConfig, DEFAULT_CONFIG, type GameConfig } from './core/config.js';
import { validateAlphabet } from './core/alphabet.js';
import type { MachineMeta, RunLog } from './core/stats.js';

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

// Which app this bundle is (Vite `define`). 'v2' — the delivered game: GRID MODE.
// 'v1' — the legacy falling-lanes keyboard game, deployed at /brm/v1 purely so the design story
// (why the alphabet became a grid) can be demonstrated. v1 is frozen: home rows only, N = 8, no
// top row / chords / challenge / audio experiments. All ongoing work targets v2.
const VARIANT: 'v1' | 'v2' = (typeof __APP_VARIANT__ !== 'undefined' && __APP_VARIANT__ === 'v1' ? 'v1' : 'v2');

interface RunCtx {
  engine: Engine | GridEngine; // GridEngine in GRID MODE; both expose the loop-facing surface
  strip: StripRenderer | GridRenderer; // both expose render(now) + resize()
  gridView: GridRenderer | null; // non-null in GRID MODE (also held as `strip`), for pointer wiring
  grid: boolean; // this run is a pointing (grid) run rather than the v1 keyboard game
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
  touchSized: boolean; // GRID: the grid was sized for a fingertip, not fixed at the desktop N
  rafId: number;
  ui: {
    time: HTMLElement;
    rate: HTMLElement;
    stats: HTMLElement;
    countdown: HTMLElement;
    stripRoot: HTMLElement;
  };
}

export class App {
  private mode: 'config' | 'run' | 'report' = 'config';
  private config: GameConfig = loadConfig();
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
    // v1 and v2 are served from the same origin and so share localStorage; a saved v2 config would
    // otherwise start v1 in grid mode. v1 is the keyboard game, always.
    if (VARIANT === 'v1') this.config = { ...this.config, grid: false };
    // Every control and URL parameter these fields used to have is gone, but a config saved while
    // they existed still carries their values — lookaheadDepth: 2, or a gridSize a retired
    // calibrator picked (12 and 48 both shipped as recommendations). Left
    // alone they would go on steering every run with nothing on screen to explain it and no way to
    // turn it off: a returning player would be locked to 12×12 forever. This list is what makes
    // "the game is 32×32, one layer, ghost on" true of a returning browser and not just a fresh
    // one, so it has to name every field whose control was removed.
    //
    // `grid: true` belongs in the same list now that nothing can turn it back on: v1 and v2 share
    // an origin and therefore localStorage, so playing v1 leaves grid: false behind, and v2 would
    // read it back. Pressing either button re-commits grid: true, but ?auto goes straight to
    // startRun and would silently capture the KEYBOARD game instead.
    if (VARIANT === 'v2') {
      this.config = {
        ...this.config,
        grid: true,
        lookaheadDepth: DEFAULT_CONFIG.lookaheadDepth,
        gridSize: DEFAULT_CONFIG.gridSize,
      };
      saveConfig(this.config); // persist the normalisation, so it survives even if no run is played
    }

    this.machinePromise = probeMachine().then((m) => (this.machine = m));
    void probeHealth().then((ok) => (this.loggingAvailable = ok));

    // one listener each for the whole app; game input is handled synchronously here.
    window.addEventListener('keydown', this.onKey, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('resize', () => this.run?.strip.resize());

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
        if (this.config.grid) this.startGridDemo();
        else this.startDemoTyper();
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
        if (Math.random() < errorRate) cell = (cell + 1) % eng.cells; // an adjacent miss now and then
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
    if (this.mode !== 'run' || !this.run) return; // config/report use normal DOM controls
    if (e.key === 'Escape') {
      e.preventDefault();
      this.abortRun();
      return;
    }
    const rc = this.run;
    if (rc.phase === 'done') return;
    if (rc.grid) return; // GRID MODE scores on pointerdown, not keys
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
    if (this.mode !== 'run' || !rc || rc.phase !== 'playing' || rc.grid) return;
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
    if (this.mode !== 'run' || !rc || !rc.grid || !rc.gridView) return;
    rc.gridView.hoverCell = rc.gridView.cellAt(e.clientX, e.clientY);
    if (rc.phase === 'playing') {
      const p = rc.gridView.localPoint(e.clientX, e.clientY);
      rc.pendingPointer = { t: performance.now() - rc.engine.startMs, x: p.x, y: p.y };
    }
  };

  // ------------------------------------------------------ v1 legacy config ----
  // The original falling-lanes keyboard game, frozen. Only the two home rows are configurable
  // (N = 8); there is no grid and none of the retired experiments. This
  // exists to demonstrate the design lineage that led to the grid alphabet — see README_V2.md.
  private showLegacyConfig(msg?: string): void {
    const keyInput = (value: string): HTMLInputElement =>
      el('input', { type: 'text', class: 'field-input mono', value, spellcheck: false, autocomplete: 'off', autocapitalize: 'off' }) as HTMLInputElement;
    const leftFingers = keyInput(this.config.leftFingers || 'asdf');
    const rightFingers = keyInput(this.config.rightFingers || 'jkl;');
    const err = el('div', { class: 'field-error' });

    // Machine name. Free text, persisted, and stamped into every log's filename and meta. It exists
    // because cell size in px — the unit every Fitts number and the scatter law live in — is set by
    // the window, so runs from a laptop and a desktop are not comparable and pooling them would
    // manufacture results. installId separates browser profiles, but a name is what makes the
    // separation legible in the analyzer without cross-referencing a token.
    const label = el('input', { class: 'field-input', type: 'text', maxlength: '24', placeholder: 'e.g. laptop', value: this.config.label }) as HTMLInputElement;
    label.addEventListener('change', () => {
      this.config = { ...this.config, label: label.value.trim().slice(0, 24) };
      saveConfig(this.config);
    });

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
      return { ...DEFAULT_CONFIG, ...parts, grid: false, alphabet: v.alphabet };
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
    this.root.replaceChildren();
    if (VARIANT === 'v1') {
      this.showLegacyConfig(msg);
      return;
    }

    // THE GAME IS 32×32. There is no grid-size control, and that is the design, not an omission:
    // one fixed N is what makes two scores comparable, and B is only a fair comparison across
    // players if they are all answering the same question. Three successive calibrators tried to
    // personalise it and all three were retired (see core/stats.d.ts); the reason they could be
    // dropped without cost is that measured B is nearly flat across the middle of the ladder —
    // 13.37 at 24², 13.33 at 32², 13.03 at 48² — so a per-player choice was never worth more than
    // a few percent, and no measurement cheap enough to put in front of a 60 s run can resolve a
    // few percent. There is no override left, not even a URL parameter — see the constructor.
    const collect = (): GameConfig => ({
      ...DEFAULT_CONFIG,
      grid: true,
      gridSize: this.config.gridSize, // always DEFAULT_CONFIG.gridSize; nothing can change it
      label: this.config.label, // not editable on screen; kept so an existing name survives
    });

    // Practice is offered, never required. Gating the scored run behind anything costs a minute of
    // the exact activity being scored, and the run-order data does not show a warm-up deficit to
    // pay that for: across sessions the FIRST run tends to be the best one (+6.0% over the rest of
    // the session in the one clean 13-run session; two other sessions agree in sign but change
    // grid size partway through). So when to warm up is the player's call, not the app's.
    const practice = el('button', { class: 'btn ghost', onclick: () => { this.commit(collect()); this.startRun(false); }, text: 'Practice' });
    const scored = el('button', {
      class: 'btn primary',
      onclick: () => { this.commit(collect()); this.startRun(true); },
      text: 'Start scored run',
    });

    this.root.append(
      el('div', { class: 'screen config' }, [
        el('h1', { class: 'title', text: 'Bit-Rate Maximizer' }),
        // "orange" is painted in the target's own colour, so the word points at the thing rather
        // than describing it. --target tracks LAYER_COLORS[0] in v2/view.ts; if one moves so must
        // the other, or the instructions name a colour the game does not draw.
        el('p', { class: 'subtitle' }, [
          document.createTextNode('Click the '),
          el('span', { class: 'ink-target', text: 'orange' }),
          document.createTextNode(' squares as quickly and as accurately as you can. Correct clicks add to your score, while errors subtract from your score. The line drawn from the '),
          el('span', { class: 'ink-target', text: 'orange' }),
          document.createTextNode(' target square to the white outlined square indicates where the next '),
          el('span', { class: 'ink-target', text: 'orange' }),
          document.createTextNode(' target square will appear.'),
        ]),
        ...(msg ? [el('div', { class: 'field-error', text: msg })] : []),
        el('div', {
          class: 'field-note',
          text: this.coarsePointer()
            ? 'Duration is locked to 60 s for scored runs. Practice runs will continue until you tap Exit.'
            : 'Duration is locked to 60 s for scored runs. Practice runs will continue until you press ESC.',
        }),
        el('div', { class: 'buttons' }, [practice, scored]),
        el('p', { class: 'consent', text: 'Runs can be saved locally, but are never transmitted anywhere.' }),
      ]),
    );
    scored.focus();
  }

  private commit(c: GameConfig): void {
    this.config = c;
    saveConfig(c);
    this.audio.setEnabled(c.sound);
  }

  // ------------------------------------------------------------------ run ----
  private startRun(timed: boolean, immediate = false): void {
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
      ...(timed ? [] : [this.practiceTag()]),
    ]);
    this.root.append(screen);

    const strip = new StripRenderer(engine, stripRoot);
    const now0 = performance.now();
    this.run = {
      engine,
      strip,
      gridView: null,
      grid: false,
      touchSized: false,
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

    const stripRoot = el('div', { class: 'strip-root grid-root' });
    const time = el('div', { class: 'time' });
    const rate = el('div', { class: 'rate' });
    const stats = el('div', { class: 'stats' });
    // Same vocabulary as the start page, and the same colour on the word: this sits over the field
    // with a real orange square already drawn on it, so naming the thing beats describing it. A
    // playtester read "the highlighted cell" and could not tell which of the two marked cells it
    // meant — the filled one or the outlined preview.
    // Wrapped in one span because .countdown is a flex container: as three direct children the
    // text nodes become flex items and the spaces between them are dropped ("click theorangesquare").
    const countdown = el('div', { class: 'countdown hint' }, [
      el('span', {}, [
        document.createTextNode('click the '),
        el('span', { class: 'ink-target', text: 'orange' }),
        document.createTextNode(' square to start'),
      ]),
    ]);

    const screen = el('div', { class: 'screen run' }, [
      time,
      el('div', { class: 'strip-wrap' }, [stripRoot, countdown]),
      el('div', { class: 'readout' }, [rate, stats]),
      ...(timed ? [] : [this.practiceTag()]),
    ]);
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
    const avail = availableFieldPx(stripRoot.clientWidth || window.innerWidth, stripRoot.clientHeight || 360);
    const coarse = this.coarsePointer();
    const gridSize = coarse ? fitTouchGrid(avail) : this.config.gridSize;
    const runConfig = gridSize === this.config.gridSize ? this.config : { ...this.config, gridSize };

    const engine = new GridEngine(runConfig, timed);
    engine.onCorrect = () => this.audio.bloop(); // hit: rising bloop (+ particle burst in the renderer)
    // no wrong-cell buzzer — the red flash (drawn by the renderer) is the only miss feedback

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
      grid: true,
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
      touchSized: coarse,
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

  /** The practice-run exit. It has to be TAPPABLE, not just an Esc binding: touch sizing made the
   *  game playable on a phone, and a phone has no Esc key — a practice run there would have been
   *  inescapable short of reloading the page. Esc still works where there is a keyboard. */
  private practiceTag(): HTMLElement {
    const coarse = this.coarsePointer();
    return el('button', {
      class: 'practice-tag',
      type: 'button',
      onclick: () => this.abortRun(),
      text: coarse ? 'PRACTICE · tap to exit' : 'PRACTICE · Esc to exit',
    });
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

    rc.strip.render(now);
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
  private buildGridLog(rc: RunCtx): RunLog['grid'] {
    const v = rc.gridView;
    return {
      enabled: true,
      gridSize: v ? v.gridSize : this.config.gridSize,
      depth: 1, // one cell per selection. Kept in the log so the analyzer can still filter the
      // stacked-layer runs in logs/ out of the grid sweep — see GridLog.depth.
      // How N was chosen. 'touch' runs played a coarser grid with a different input device, so they
      // are a separate modality and the analyzer must never pool them with 'fixed' runs.
      sizing: rc.touchSized ? 'touch' : 'fixed',
      minCellPx: rc.touchSized ? TOUCH_MIN_CELL_PX : undefined,
      fieldPx: v ? v.fieldPx : 0,
      cellPx: v ? v.cellPx : 0,
      devicePixelRatio: v ? v.dpr : 1,
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

// Screen router + run loop. Three screens (config, run, report) plus an in-run 3-2-1
// countdown. A single window keydown listener (attached once, { passive:false }) drives
// the whole app; during play it is the latency-critical path — classify, count, advance,
// synchronously — while a separate rAF loop reads state and draws. Alongside the scoring
// log, a RunRecorder buffers a richer event log (down+up, verdict, live idx) entirely from
// primitives, written to logs/ once at run end — never during the 60 s.

import { Engine, type KeyInput } from './engine.js';
import { StripRenderer } from './strip.js';
import { AudioFeedback } from './audio.js';
import { LatencyOverlay } from './latency.js';
import { buildReport, downloadReport } from './report.js';
import { RunRecorder, postLog, probeHealth, fetchIndex, type IndexRow } from './logging.js';
import { probeMachine } from './machine.js';
import { renderReport, type LogInfo } from './reportview.js';
import { loadConfig, saveConfig, type GameConfig, type ErrorFeedback, type FingerMapping } from './config.js';
import { MIN_LOOKAHEAD, SCORED_DURATION_MS, validateAlphabet } from './scoring.js';
import type { MachineMeta, RunLog } from './stats.js';

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
  engine: Engine;
  strip: StripRenderer;
  recorder: RunRecorder;
  timed: boolean;
  phase: 'countdown' | 'playing' | 'done';
  countdownStart: number;
  startedAt: string; // ISO, stamped when play begins
  droppedFrames: number;
  lastFrameMs: number;
  pendingDownT: number; // run-relative t of a keydown awaiting its paint (latency sample)
  pendingDown: boolean;
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

    this.machinePromise = probeMachine().then((m) => (this.machine = m));
    void probeHealth().then((ok) => (this.loggingAvailable = ok));

    // one listener each for the whole app; game input is handled synchronously here.
    window.addEventListener('keydown', this.onKey, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('resize', () => this.run?.strip.resize());
    this.showConfig();

    // Dev aid: ?auto=practice|scored skips the config screen; add &demo to auto-type
    // (dispatches real keydowns, so it drives the same input path a human would).
    const auto = params.get('auto');
    if (auto === 'practice' || auto === 'scored') {
      // Dev-only: ?secs=N shortens JUST this capture run so a full run→report can be driven
      // headlessly. Never affects a real scored run (which is always 60 s).
      const secs = Number(params.get('secs'));
      if (Number.isFinite(secs) && secs >= 1 && secs <= 60) {
        this.config = { ...this.config, durationMs: Math.round(secs * 1000) };
      }
      this.startRun(auto === 'scored', true); // skip the countdown for headless capture
      if (params.has('demo')) this.startDemoTyper();
    }
  }

  private startDemoTyper(): void {
    const errorRate = 0.06;
    const tick = (): void => {
      const rc = this.run;
      if (!rc || rc.phase === 'done') return;
      if (rc.phase === 'playing') {
        const eng = rc.engine;
        let key = eng.target();
        if (Math.random() < errorRate) {
          const others = eng.chars.filter((c) => c !== key);
          key = others[Math.floor(Math.random() * others.length)] ?? key;
        }
        window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        window.setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true })), 30);
      }
      window.setTimeout(tick, 70 + Math.random() * 60);
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
    if (this.run.phase !== 'playing') return;
    const rc = this.run;
    const eng = rc.engine;
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
    };
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
    if (this.mode !== 'run' || !rc || rc.phase !== 'playing') return;
    if (!rc.engine.alphaSet.has(e.key)) return;
    rc.recorder.recordUp(e.key, rc.engine.index, performance.now() - rc.engine.startMs);
  };

  // --------------------------------------------------------------- config ----
  private showConfig(): void {
    this.mode = 'config';
    this.run = null;
    this.root.replaceChildren();

    const alpha = el('input', {
      type: 'text',
      class: 'field-input mono',
      value: this.config.alphabet,
      spellcheck: false,
      autocomplete: 'off',
      autocapitalize: 'off',
    }) as HTMLInputElement;

    const look = el('input', {
      type: 'number',
      class: 'field-input',
      min: MIN_LOOKAHEAD,
      max: 14,
      step: 1,
      value: this.config.lookahead,
    }) as HTMLInputElement;

    const machineLabel = el('input', {
      type: 'text',
      class: 'field-input',
      value: this.config.label,
      placeholder: 'e.g. calvin',
      spellcheck: false,
      autocomplete: 'off',
    }) as HTMLInputElement;

    const feedback = el('select', { class: 'field-input' }) as HTMLSelectElement;
    for (const [val, text] of [
      ['flash+shake', 'flash + shake'],
      ['flash', 'flash only'],
      ['shake', 'shake only'],
      ['none', 'none'],
    ] as Array<[ErrorFeedback, string]>) {
      const opt = el('option', { value: val, text }) as HTMLOptionElement;
      if (this.config.errorFeedback === val) opt.selected = true;
      feedback.append(opt);
    }

    const mapping = el('select', { class: 'field-input' }) as HTMLSelectElement;
    for (const [val, text] of [
      ['leftmost', 'Leftmost-aligned'],
      ['digit', 'Same-finger'],
    ] as Array<[FingerMapping, string]>) {
      const opt = el('option', { value: val, text }) as HTMLOptionElement;
      if (this.config.mapping === val) opt.selected = true;
      mapping.append(opt);
    }

    const lanes = el('input', { type: 'checkbox', ...(this.config.lanes ? { checked: true } : {}) }) as HTMLInputElement;
    const collapse = el('input', { type: 'checkbox', ...(this.config.collapse ? { checked: true } : {}) }) as HTMLInputElement;
    const sound = el('input', { type: 'checkbox', ...(this.config.sound ? { checked: true } : {}) }) as HTMLInputElement;

    const err = el('div', { class: 'field-error' });

    const collect = (): GameConfig | null => {
      const v = validateAlphabet(alpha.value);
      if (!v.ok) {
        err.textContent = v.error;
        alpha.focus();
        return null;
      }
      err.textContent = '';
      let la = Math.round(Number(look.value));
      if (!Number.isFinite(la) || la < MIN_LOOKAHEAD) la = MIN_LOOKAHEAD;
      if (la > 14) la = 14;
      look.value = String(la);
      return {
        alphabet: v.alphabet,
        durationMs: SCORED_DURATION_MS,
        lookahead: la,
        lanes: lanes.checked,
        collapse: collapse.checked,
        mapping: mapping.value as FingerMapping,
        sound: sound.checked,
        errorFeedback: feedback.value as ErrorFeedback,
        label: machineLabel.value.trim().slice(0, 40),
      };
    };

    const startPractice = (): void => {
      const c = collect();
      if (!c) return;
      this.commit(c);
      this.startRun(false);
    };
    const startScored = (): void => {
      const c = collect();
      if (!c) return;
      this.commit(c);
      this.startRun(true);
    };

    const field = (label: string, control: Node, hint?: string): HTMLElement =>
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: label }),
        control,
        ...(hint ? [el('span', { class: 'field-hint', text: hint })] : []),
      ]);

    this.root.append(
      el('div', { class: 'screen config' }, [
        el('h1', { class: 'title', text: 'Bit-Rate Maximizer' }),
        el('p', { class: 'subtitle', text: 'Type the magnified target. Correct selections add bits; errors subtract. Accuracy is worth about twice raw speed.' }),
        el('div', { class: 'config-grid' }, [
          field('Alphabet', alpha, 'Unique single keys. N is derived from its length.'),
          field('Lookahead', look, 'Glyphs shown ahead of the target. Higher = more pipelining.'),
          field('Machine name', machineLabel, 'Labels this machine’s logs. Optional.'),
          field('Error feedback', feedback, 'How a miss is shown. Recorded, for comparing effects.'),
          field('Column mapping', mapping, 'When finger columns are on: overlay hands (leftmost) or share by finger (same-finger).'),
          el('div', { class: 'field toggles' }, [
            el('label', { class: 'toggle' }, [lanes, el('span', { text: ' Falling lanes' })]),
            el('label', { class: 'toggle' }, [collapse, el('span', { text: ' Finger columns' })]),
            el('label', { class: 'toggle' }, [sound, el('span', { text: ' Sound' })]),
          ]),
        ]),
        err,
        el('div', { class: 'field-note', text: 'Duration is locked to 60 s for scored runs.' }),
        el('div', { class: 'buttons' }, [
          el('button', { class: 'btn ghost', onclick: startPractice, text: 'Practice' }),
          el('button', { class: 'btn primary', onclick: startScored, text: 'Start scored run' }),
        ]),
        el('p', { class: 'strategy', text: 'Making frequent errors? Try a smaller alphabet (dfjk, N=4). Bottlenecked by reading speed? Try a larger one (asdfghjkl;, N=10). Warm up in Practice first.' }),
        el('p', { class: 'consent', text: 'Runs are saved locally to the logs/ folder and never transmitted anywhere. Only in-alphabet keys are recorded — no free text.' }),
      ]),
    );
    alpha.focus();
  }

  private commit(c: GameConfig): void {
    this.config = c;
    saveConfig(c);
    this.audio.setEnabled(c.sound);
  }

  // ------------------------------------------------------------------ run ----
  private startRun(timed: boolean, immediate = false): void {
    this.mode = 'run';
    this.root.replaceChildren();
    if (this.config.sound) this.audio.unlock(); // user gesture (button click) is active

    const engine = new Engine(this.config, timed);
    engine.onCorrect = () => this.audio.correct();
    engine.onError = () => this.audio.error();

    const stripRoot = el('div', { class: 'strip-root' });
    const time = el('div', { class: 'time' });
    const rate = el('div', { class: 'rate' });
    const stats = el('div', { class: 'stats' });
    const countdown = el('div', { class: 'countdown' });

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
      recorder: new RunRecorder(),
      timed,
      phase: immediate ? 'playing' : 'countdown',
      countdownStart: now0,
      startedAt: '',
      droppedFrames: 0,
      lastFrameMs: -1,
      pendingDownT: 0,
      pendingDown: false,
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

  // rAF passes a timestamp, but we read performance.now() directly so the render loop and
  // the keydown handler share exactly one clock domain (they're equal in a real browser;
  // this also keeps headless virtual-time captures self-consistent).
  private loop = (): void => {
    const rc = this.run;
    if (!rc) return;
    const now = performance.now();

    if (rc.phase === 'countdown') {
      const left = 3 - Math.floor((now - rc.countdownStart) / 1000);
      if (left <= 0) {
        rc.phase = 'playing';
        rc.engine.start(now);
        rc.startedAt = new Date().toISOString();
        rc.ui.countdown.classList.add('hidden');
      } else {
        rc.ui.countdown.classList.remove('hidden');
        rc.ui.countdown.textContent = String(left);
        rc.ui.time.textContent = rc.timed ? 'ready' : 'practice';
      }
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
    // this frame is the paint that follows any pending keydown → close keydown→paint proxy
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
    void this.completeRun(rc, result);
  }

  // Off the hot path (the run is over): assemble the log, write it if the endpoint is live,
  // then render the report. Falls back to the download button when logging is unavailable.
  private async completeRun(rc: RunCtx, result: ReturnType<Engine['result']>): Promise<void> {
    const machine = this.machine ?? (await this.machinePromise);
    const log = buildReport(rc.engine, result, {
      recorder: rc.recorder,
      machine,
      mode: rc.timed ? 'scored' : 'practice',
      startedAt: rc.startedAt || new Date().toISOString(),
      droppedFrames: rc.droppedFrames,
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

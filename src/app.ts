// Screen router + run loop. Three screens (config, run, report) plus an in-run 3-2-1
// countdown. A single window keydown listener (attached once, { passive:false }) drives
// the whole app; during play it is the latency-critical path — classify, count, advance,
// synchronously — while a separate rAF loop reads state and draws.

import { Engine, type KeyInput } from './engine.js';
import { StripRenderer } from './strip.js';
import { AudioFeedback } from './audio.js';
import { LatencyOverlay } from './latency.js';
import { buildReport, downloadReport, type RunReport } from './report.js';
import { loadConfig, saveConfig, type GameConfig } from './config.js';
import { MIN_LOOKAHEAD, SCORED_DURATION_MS, validateAlphabet } from './scoring.js';

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

interface RunCtx {
  engine: Engine;
  strip: StripRenderer;
  timed: boolean;
  phase: 'countdown' | 'playing' | 'done';
  countdownStart: number;
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

  constructor(private readonly root: HTMLElement) {
    const params = new URLSearchParams(location.search);
    this.latency = new LatencyOverlay(params.has('debug'));
    // one listener for the whole app; game input is handled synchronously here.
    window.addEventListener('keydown', this.onKey, { passive: false });
    window.addEventListener('resize', () => this.run?.strip.resize());
    this.showConfig();

    // Dev aid: ?auto=practice|scored skips the config screen; add &demo to auto-type
    // (dispatches real keydowns, so it drives the same input path a human would).
    const auto = params.get('auto');
    if (auto === 'practice' || auto === 'scored') {
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
    const eng = this.run.engine;
    const inAlpha = eng.alphaSet.has(e.key);
    if (inAlpha && !e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault();
    const now = performance.now();
    this.latency.markKey(now);
    const input: KeyInput = {
      key: e.key,
      repeat: e.repeat,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
    };
    eng.handleKey(input, now);
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

    const lanes = el('input', { type: 'checkbox', ...(this.config.lanes ? { checked: true } : {}) }) as HTMLInputElement;
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
        sound: sound.checked,
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
          el('div', { class: 'field toggles' }, [
            el('label', { class: 'toggle' }, [lanes, el('span', { text: ' Piano-roll lanes' })]),
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
      timed,
      phase: immediate ? 'playing' : 'countdown',
      countdownStart: now0,
      rafId: 0,
      ui: { time, rate, stats, countdown, stripRoot },
    };
    if (immediate) {
      engine.start(now0);
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
        rc.ui.countdown.classList.add('hidden');
      } else {
        rc.ui.countdown.classList.remove('hidden');
        rc.ui.countdown.textContent = String(left);
        rc.ui.time.textContent = rc.timed ? 'ready' : 'practice';
      }
    }

    if (rc.phase === 'playing') {
      rc.engine.tick(now);
      if (rc.engine.state === 'ended') {
        rc.phase = 'done';
        this.finishRun();
        return;
      }
      this.updateHud(now, rc);
    }

    rc.strip.render(now);
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
    const report = buildReport(rc.engine, result);
    this.run = null;
    this.showReport(report);
  }

  // --------------------------------------------------------------- report ----
  private showReport(report: RunReport): void {
    this.mode = 'report';
    this.root.replaceChildren();

    const errRows = Object.entries(report.errorsByTarget).sort((a, b) => b[1] - a[1]);
    const errList = errRows.length
      ? el('div', { class: 'err-keys' }, errRows.map(([k, n]) =>
          el('span', { class: 'err-key' }, [el('code', { text: k === ' ' ? '␣' : k }), el('span', { text: ` ×${n}` })]),
        ))
      : el('div', { class: 'err-keys muted', text: 'no errors' });

    const stat = (label: string, value: string): HTMLElement =>
      el('div', { class: 'report-stat' }, [
        el('div', { class: 'rs-value', text: value }),
        el('div', { class: 'rs-label', text: label }),
      ]);

    this.root.append(
      el('div', { class: 'screen report' }, [
        el('div', { class: 'headline' }, [
          el('div', { class: 'big-rate', text: report.bitsPerSecond.toFixed(2) }),
          el('div', { class: 'big-unit', text: 'bits / second' }),
        ]),
        el('div', { class: 'report-grid' }, [
          stat('N', String(report.n)),
          stat('correct (Sc)', String(report.sc)),
          stat('incorrect (Si)', String(report.si)),
          stat('time', `${report.tSeconds.toFixed(0)} s`),
          stat('accuracy', `${(report.accuracy * 100).toFixed(1)}%`),
          stat('gross / s', report.grossPerSecond.toFixed(2)),
          stat('net bits', report.netBits.toFixed(1)),
        ]),
        el('div', { class: 'err-block' }, [el('div', { class: 'err-title', text: 'Errors by target key' }), errList]),
        el('div', { class: 'buttons' }, [
          el('button', { class: 'btn ghost', onclick: () => this.showConfig(), text: 'Config' }),
          el('button', { class: 'btn ghost', onclick: () => downloadReport(report), text: 'Download JSON' }),
          el('button', { class: 'btn primary', onclick: () => this.startRun(true), text: 'Run again' }),
        ]),
        el('p', { class: 'verify-note', text: 'The JSON contains the full generated sequence and every keystroke with timestamps, so the score can be recomputed and the sequence checked for uniformity independently.' }),
      ]),
    );
  }
}

export function mount(root: HTMLElement): App {
  return new App(root);
}

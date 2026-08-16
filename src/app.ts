// Screen router + run loop. Three screens (config, run, report); a run waits in a "ready" state
// and its clock starts on the first keypress (no countdown). A single window keydown listener
// (attached once, { passive:false }) drives the whole app; during play it is the latency-critical
// path — classify, count, advance,
// synchronously — while a separate rAF loop reads state and draws. Alongside the scoring
// log, a RunRecorder buffers a richer event log (down+up, verdict, live idx) entirely from
// primitives, written to logs/ once at run end — never during the 60 s.

import { Engine, type KeyInput } from './engine.js';
import { StripRenderer } from './strip.js';
import { AudioFeedback, laneToneHz } from './audio.js';
import { PacerController } from './pacer.js';
import { LatencyOverlay } from './latency.js';
import { buildReport, downloadReport } from './report.js';
import { RunRecorder, postLog, probeHealth, fetchIndex, type IndexRow } from './logging.js';
import { probeMachine } from './machine.js';
import { renderReport, type LogInfo } from './reportview.js';
import { loadConfig, saveConfig, composeAlphabet, laneAudio, CHALLENGE_SEED_HZ, CHALLENGE_LEAD_BEATS, type GameConfig } from './config.js';
import { DEFAULT_LOOKAHEAD, SCORED_DURATION_MS, validateAlphabet, symbolFor } from './scoring.js';
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
  phase: 'ready' | 'playing' | 'done'; // ready = waiting for the first keypress to start the clock
  startedAt: string; // ISO, stamped when play begins
  pacer: PacerController | null; // the tempo controller (null when the pacer is off for this run)
  pacerStarted: boolean; // whether the click scheduler has been kicked off yet
  challengeBeat: number; // challenge mode: cumulative beat position, integrated from the pacer tempo
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
    const auto = params.get('auto');
    if (auto === 'practice' || auto === 'scored') {
      // Dev-only: ?secs=N shortens JUST this capture run so a full run→report can be driven
      // headlessly. Never affects a real scored run (which is always 60 s).
      const secs = Number(params.get('secs'));
      if (Number.isFinite(secs) && secs >= 1 && secs <= 60) {
        this.config = { ...this.config, durationMs: Math.round(secs * 1000) };
      }
      this.startRun(auto === 'scored', true); // start immediately (skip the ready wait) for headless capture
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
      this.abortRun();
      return;
    }
    const rc = this.run;
    if (rc.phase === 'done') return;
    // No countdown: the run's clock starts when you first type an in-alphabet target. This same
    // keydown then falls through and is scored as the first selection.
    if (rc.phase === 'ready') {
      if (!rc.engine.alphaSet.has(e.key) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      rc.phase = 'playing';
      rc.engine.start(performance.now());
      rc.startedAt = new Date().toISOString();
      rc.ui.countdown.classList.add('hidden');
    }
    // spacebar is the chord modifier, not a selection — track it and never let it score/scroll
    if (this.config.chord && e.key === ' ') {
      e.preventDefault();
      this.spaceHeld = true;
      return;
    }
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
    if (this.mode !== 'run' || !rc || rc.phase !== 'playing') return;
    if (!rc.engine.alphaSet.has(e.key)) return;
    const now = performance.now();
    if (this.config.chords) {
      const oc = rc.engine.handleKeyUp(e.key, now); // completes a chord on last release
      const tRun = now - rc.engine.startMs;
      if (oc === 'correct') rc.pacer?.recordCorrect(tRun);
      else if (oc === 'incorrect') rc.pacer?.recordError(tRun);
    }
    rc.recorder.recordUp(e.key, rc.engine.index, now - rc.engine.startMs);
  };

  // --------------------------------------------------------------- config ----
  private showConfig(): void {
    this.mode = 'config';
    this.run = null;
    this.root.replaceChildren();

    const keyInput = (value: string, placeholder = ''): HTMLInputElement =>
      el('input', {
        type: 'text',
        class: 'field-input mono',
        value,
        placeholder,
        spellcheck: false,
        autocomplete: 'off',
        autocapitalize: 'off',
      }) as HTMLInputElement;

    const machineLabel = el('input', {
      type: 'text',
      class: 'field-input',
      value: this.config.label,
      placeholder: 'e.g. calvin',
      spellcheck: false,
      autocomplete: 'off',
    }) as HTMLInputElement;

    const leftFingers = keyInput(this.config.leftFingers);
    const rightFingers = keyInput(this.config.rightFingers);
    const leftTopRow = keyInput(this.config.leftTopRow);
    const rightTopRow = keyInput(this.config.rightTopRow);
    const topRow = el('input', { type: 'checkbox', ...(this.config.topRow ? { checked: true } : {}) }) as HTMLInputElement;
    const chords = el('input', { type: 'checkbox', ...(this.config.chords ? { checked: true } : {}) }) as HTMLInputElement;
    const challenge = el('input', { type: 'checkbox', ...(this.config.challenge ? { checked: true } : {}) }) as HTMLInputElement;

    const err = el('div', { class: 'field-error' });

    const field = (label: string, control: Node, hint?: string): HTMLElement =>
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: label }),
        control,
        ...(hint ? [el('span', { class: 'field-hint', text: hint })] : []),
      ]);

    const collect = (): GameConfig | null => {
      const parts = {
        leftFingers: leftFingers.value,
        rightFingers: rightFingers.value,
        topRow: topRow.checked,
        leftTopRow: leftTopRow.value,
        rightTopRow: rightTopRow.value,
      };
      const v = validateAlphabet(composeAlphabet(parts));
      if (!v.ok) {
        err.textContent = v.error;
        return null;
      }
      err.textContent = '';
      return {
        ...parts,
        chords: chords.checked,
        challenge: challenge.checked,
        tones: false, // pacer + tones retired (A/B showed no bit-rate gain, slight accuracy cost)
        abTest: false,
        alphabet: v.alphabet,
        label: machineLabel.value.trim().slice(0, 40),
        pacer: 'off',
        pacerPush: 0.1,
        pacerVolume: 0.22,
        pacerScored: false,
        durationMs: SCORED_DURATION_MS,
        lookahead: DEFAULT_LOOKAHEAD,
        lanes: true,
        chord: false,
        sound: true,
        errorFeedback: 'flash',
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

    this.root.append(
      el('div', { class: 'screen config' }, [
        el('h1', { class: 'title', text: 'Bit-Rate Maximizer' }),
        el('p', { class: 'subtitle', text: 'Type the magnified target. Correct selections add bits; errors subtract. Accuracy is worth about twice raw speed.' }),
        el('div', { class: 'config-grid' }, [
          field('Your name', machineLabel, 'Labels this machine’s logs.'),
          field('Left hand home row', leftFingers, 'Keys the left hand types (edit for other layouts).'),
          field('Right hand home row', rightFingers, 'Keys the right hand types.'),
          field('Left hand top row', leftTopRow, 'Sits above the home row, same finger columns.'),
          field('Right hand top row', rightTopRow, 'Sits above the home row, same finger columns.'),
          el('div', { class: 'field toggles' }, [
            el('label', { class: 'toggle' }, [topRow, el('span', { text: ' Top row (adds a second row per hand)' })]),
            el('label', { class: 'toggle' }, [chords, el('span', { text: ' Chords (press 1–3 keys together)' })]),
            el('label', { class: 'toggle' }, [challenge, el('span', { text: ' CHALLENGE MODE (fixed-rate scroll — hit before it leaves the band)' })]),
          ]),
        ]),
        err,
        el('div', { class: 'field-note', text: 'Duration is locked to 60 s for scored runs.' }),
        el('div', { class: 'buttons' }, [
          el('button', { class: 'btn ghost', onclick: startPractice, text: 'Practice' }),
          el('button', { class: 'btn primary', onclick: startScored, text: 'Start scored run' }),
        ]),
        el('p', { class: 'consent', text: 'Runs are saved locally to the logs/ folder and never transmitted anywhere. Only in-alphabet keys are recorded — no free text.' }),
      ]),
    );
    machineLabel.focus();
  }

  private commit(c: GameConfig): void {
    this.config = c;
    saveConfig(c);
    this.audio.setEnabled(c.sound);
  }

  // ------------------------------------------------------------------ run ----
  private startRun(timed: boolean, immediate = false): void {
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

    if (rc.phase === 'ready') {
      // waiting for the first keypress (handled in onKey); the clock shows its full value, frozen
      rc.ui.time.textContent = rc.timed ? (this.config.durationMs / 1000).toFixed(1) : 'practice';
    }

    if (rc.phase === 'playing') {
      const dtMs = rc.lastFrameMs >= 0 ? Math.min(64, now - rc.lastFrameMs) : 16;
      if (rc.lastFrameMs >= 0 && now - rc.lastFrameMs > DROPPED_FRAME_MS) rc.droppedFrames++;
      rc.lastFrameMs = now;
      // CHALLENGE MODE: integrate the scroll rate (the pacer's tempo, or a seed until it establishes)
      // into a beat position; the engine scores misses and the strip scrolls from the same value.
      if (this.config.challenge) {
        const tempo = rc.pacer && rc.pacer.started ? rc.pacer.currentTempo : CHALLENGE_SEED_HZ;
        rc.challengeBeat += tempo * (dtMs / 1000);
        rc.engine.challengeProgress = rc.challengeBeat - CHALLENGE_LEAD_BEATS;
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
    // this frame is the paint that follows any pending keydown → close keydown→paint proxy
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
    const tone = this.toneTable.get(rc.engine.target());
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
    if (this.run) cancelAnimationFrame(this.run.rafId);
    this.audio.releaseAllTones();
    this.audio.stopPacer();
    this.run = null;
    this.showConfig();
  }

  private finishRun(): void {
    const rc = this.run;
    if (!rc) return;
    cancelAnimationFrame(rc.rafId);
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
    void this.completeRun(rc, result, pacerLog, tonesLog);
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

// Optional auditory feedback via AudioContext (never <audio> elements — their latency is
// unacceptable). A ~5 ms click on a correct selection, a distinct low tone on error.
// Off by default; unlocked on a user gesture (browsers require it).

import { scheduleClicks } from './pacer.js';

export class AudioFeedback {
  private ctx: AudioContext | null = null;
  private enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  setEnabled(e: boolean): void {
    this.enabled = e;
  }

  // Call from a user gesture (e.g. the Start button) so the context is allowed to run.
  unlock(): void {
    this.ensure();
  }

  private ensure(): AudioContext | null {
    if (!this.enabled) return null;
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return null;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private blip(freq: number, ms: number, gain: number, type: OscillatorType): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + ms / 1000 + 0.02);
  }

  correct(): void {
    this.blip(1650, 6, 0.1, 'square'); // short bright click
  }

  error(): void {
    this.blip(170, 95, 0.16, 'sine'); // low tone
  }

  // 3-2-1 countdown beeps: three equal tones, then a higher "go" on the final transition.
  countdownBeep(go = false): void {
    this.blip(go ? 880 : 587.33, go ? 150 : 110, 0.16, 'triangle');
  }

  // ---- target tones: one pitch per lane, gated to the target's lifetime (see bitrate-tones-spec.md) ----
  // A tone starts when a target becomes current and releases when it resolves, so fast play runs
  // legato and slow play sustains — the tone length is an audible readout of the player's pacing.
  // Pitch ascends left→right (position, not hand); the hand is carried by timbre + pan. Voices
  // overlap on their release tails, capped at 3 (oldest stolen). Never blocks the input path.
  private toneMaster: GainNode | null = null;
  private toneVolume = 0.16; // independent from the pacer; low
  private toneVoices: Array<{ osc: OscillatorNode; gain: GainNode; startedAt: number; stopAt: number | null }> = [];
  private toneCurrent: { osc: OscillatorNode; gain: GainNode; startedAt: number; stopAt: number | null } | null = null;
  private toneWaves: [PeriodicWave, PeriodicWave] | null = null; // [left, right], built once
  voiceStealEvents = 0; // logged: how often the 3-voice cap forced an early stop

  private static readonly TONE_ATTACK = 0.005;
  private static readonly TONE_SUSTAIN = 0.5; // pluck decays to this fraction of the peak, then rings
  private static readonly TONE_DECAY_TC = 0.13; // time constant of the plucked attack→sustain decay
  private static readonly TONE_MIN_S = 0.08; // min sustain before release, so fast play isn't clipped
  private static readonly TONE_RELEASE_TC = 0.045; // release-tail time constant (~5·tc to silence)
  private static readonly TONE_MAX_VOICES = 3;

  // Instrumental timbre per hand: harmonically rich periodic waves (not bare sine/triangle) give the
  // tones body, like a plucked mallet instrument. Left is warm (fundamental-heavy, gentle harmonics);
  // right is brighter/reedier (more upper harmonics) — so timbre still codes hand, and the lowpass
  // (2 k / 4 k) reinforces it. Built once per context.
  private toneWave(ctx: AudioContext, hand: 0 | 1): PeriodicWave {
    if (!this.toneWaves) {
      const wave = (imag: number[]): PeriodicWave =>
        ctx.createPeriodicWave(new Float32Array(imag.length), new Float32Array(imag));
      this.toneWaves = [
        wave([0, 1.0, 0.42, 0.16, 0.07, 0.03]), // left — warm, rounded
        wave([0, 1.0, 0.55, 0.34, 0.2, 0.11, 0.05]), // right — brighter, reedier
      ];
    }
    return this.toneWaves[hand];
  }

  // Advance to the next target's tone: release the one that just resolved and start the new one.
  // `hand`: 0 = left (warm wave, lowpass 2 kHz, pan −0.7), 1 = right (bright wave, 4 kHz, pan +0.7).
  toneAdvance(freq: number, hand: 0 | 1): void {
    const ctx = this.ensure();
    if (!ctx) return;
    if (!this.toneMaster) {
      this.toneMaster = ctx.createGain();
      this.toneMaster.gain.value = this.toneVolume;
      this.toneMaster.connect(ctx.destination);
    }
    this.releaseVoice(this.toneCurrent, ctx);
    this.toneCurrent = null;
    this.pruneVoices(ctx);

    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(this.toneWave(ctx, hand));
    osc.frequency.value = freq;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = hand === 0 ? 2000 : 4000;
    const panner = ctx.createStereoPanner();
    panner.pan.value = hand === 0 ? -0.7 : 0.7;
    const gain = ctx.createGain();
    // plucked attack that settles to a ringing sustain — instrumental body, not a flat held tone
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(1, t + AudioFeedback.TONE_ATTACK); // 5 ms attack, no click
    gain.gain.setTargetAtTime(AudioFeedback.TONE_SUSTAIN, t + AudioFeedback.TONE_ATTACK, AudioFeedback.TONE_DECAY_TC);
    osc.connect(filter).connect(panner).connect(gain).connect(this.toneMaster);
    osc.start(t);

    const voice = { osc, gain, startedAt: t, stopAt: null as number | null };
    this.toneVoices.push(voice);
    this.toneCurrent = voice;
    if (this.toneVoices.length > AudioFeedback.TONE_MAX_VOICES) {
      const oldest = this.toneVoices.shift();
      if (oldest) {
        this.hardStop(oldest, ctx);
        this.voiceStealEvents++;
      }
    }
  }

  // Release the current tone without starting a new one (run end / abort).
  releaseAllTones(): void {
    if (this.ctx) this.releaseVoice(this.toneCurrent, this.ctx);
    this.toneCurrent = null;
  }

  private releaseVoice(v: { gain: GainNode; osc: OscillatorNode; startedAt: number; stopAt: number | null } | null, ctx: AudioContext): void {
    if (!v || v.stopAt !== null) return;
    const relStart = Math.max(ctx.currentTime, v.startedAt + AudioFeedback.TONE_MIN_S); // enforce min sustain
    // release from wherever the pluck decay currently sits (setTargetAtTime starts at the live value)
    v.gain.gain.setTargetAtTime(0.0001, relStart, AudioFeedback.TONE_RELEASE_TC);
    v.stopAt = relStart + AudioFeedback.TONE_RELEASE_TC * 6 + 0.05;
    v.osc.stop(v.stopAt);
  }

  private hardStop(v: { gain: GainNode; osc: OscillatorNode; stopAt: number | null }, ctx: AudioContext): void {
    const t = ctx.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setTargetAtTime(0.0001, t, 0.01); // quick fade to avoid a click
    v.stopAt = t + 0.06;
    v.osc.stop(v.stopAt);
  }

  private pruneVoices(ctx: AudioContext): void {
    const now = ctx.currentTime;
    this.toneVoices = this.toneVoices.filter((v) => v.stopAt === null || now < v.stopAt);
  }

  // ---- pacer: an adaptive click track, scheduled on the audio clock ----
  // A short ~1 kHz click at a tempo the controller (pacer.ts) sets and retunes. Clicks are placed
  // at exact audio-clock times via a lookahead scheduler woken by a 25 ms timer, so their spacing
  // is sample-accurate regardless of frame jitter or load. A tempo change takes effect at the next
  // click, never retroactively. Every scheduled click's time is captured (converted to the
  // performance.now() clock) so the log can align it with the keystroke events. The pacer NEVER
  // sounds on keypress — it is pacing, not feedback — and never gates anything (see spec §1).
  private pacer: {
    intervalId: number;
    nextClick: number; // audio-clock time (s)
    tempo: number; // Hz
    master: GainNode; // reused volume node
    perfOffsetMs: number; // performance.now() − currentTime·1000, captured once at start
    clickTimes: number[]; // absolute performance.now() ms, one per emitted click
  } | null = null;
  private kickShaperCurve: Float32Array<ArrayBuffer> | null = null; // cached soft-clip curve for the kick

  private static readonly PACER_LOOKAHEAD = 0.1; // schedule clicks up to 100 ms ahead

  // Begin the click track at tempoHz. Returns false if audio is unavailable (caller records that
  // and proceeds — the pacer must never block a run).
  startPacer(tempoHz: number, gain: number): boolean {
    const ctx = this.ensure();
    if (!ctx || !(tempoHz > 0)) return false;
    const master = ctx.createGain();
    master.gain.value = gain;
    master.connect(ctx.destination);
    const p = {
      intervalId: 0,
      nextClick: ctx.currentTime + 0.15,
      tempo: tempoHz,
      master,
      perfOffsetMs: performance.now() - ctx.currentTime * 1000,
      clickTimes: [] as number[],
    };
    p.intervalId = window.setInterval(() => this.pumpPacer(), 25);
    this.pacer = p;
    return true;
  }

  setPacerTempo(tempoHz: number): void {
    if (this.pacer && tempoHz > 0) this.pacer.tempo = tempoHz;
  }

  // Stop the click track; return the captured click times (absolute performance.now() ms).
  stopPacer(): number[] {
    const p = this.pacer;
    if (!p) return [];
    clearInterval(p.intervalId);
    try {
      p.master.disconnect();
    } catch {
      /* already gone */
    }
    this.pacer = null;
    return p.clickTimes;
  }

  // Beats actually scheduled so far — surfaced in the HUD so a silent pacer is visibly diagnosable.
  pacerBeats(): number {
    return this.pacer?.clickTimes.length ?? 0;
  }

  private pumpPacer(): void {
    const ctx = this.ctx;
    const p = this.pacer;
    if (!ctx || !p) return;
    try {
      const { clicks, nextClick } = scheduleClicks(ctx.currentTime, p.nextClick, p.tempo, AudioFeedback.PACER_LOOKAHEAD);
      p.nextClick = nextClick;
      for (const at of clicks) {
        this.clickAt(ctx, at, p.master);
        p.clickTimes.push(Math.round((at * 1000 + p.perfOffsetMs) * 1000) / 1000);
      }
    } catch (e) {
      // a throw here would otherwise be swallowed by setInterval and silently kill the pacer
      console.error('[pacer] scheduling error', e);
    }
  }

  // Soft-clip curve (tanh) for the kick body: driving the sine into it adds harmonics, so the bass
  // "reads" on small speakers that can't reproduce the fundamental, and it gets that gritty club
  // character. Built once.
  private kickCurve(): Float32Array<ArrayBuffer> {
    if (!this.kickShaperCurve) {
      const n = 1024;
      const c = new Float32Array(new ArrayBuffer(n * 4));
      const k = 2.2; // drive/warmth
      for (let i = 0; i < n; i++) c[i] = Math.tanh(k * ((i / (n - 1)) * 2 - 1));
      this.kickShaperCurve = c;
    }
    return this.kickShaperCurve;
  }

  // A saturated club kick ("unz"): a pitch-dropping sine body driven through a soft-clipper for a
  // fat, bassy boom, plus a short knock transient for attack. Loud — it sits above the lane tones.
  private clickAt(ctx: AudioContext, at: number, master: GainNode): void {
    const body = ctx.createOscillator();
    const bodyEnv = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    shaper.curve = this.kickCurve();
    shaper.oversample = '2x';
    body.type = 'sine';
    body.frequency.setValueAtTime(210, at); // the "woomp"...
    body.frequency.exponentialRampToValueAtTime(48, at + 0.055); // ...dropping to a fat low boom
    bodyEnv.gain.setValueAtTime(0.0001, at);
    bodyEnv.gain.linearRampToValueAtTime(1.8, at + 0.004); // fast attack, driven hard into the clipper
    bodyEnv.gain.exponentialRampToValueAtTime(0.0001, at + 0.2); // longer boom for the "unz" body
    body.connect(bodyEnv).connect(shaper).connect(master);
    body.start(at);
    body.stop(at + 0.28);

    const knock = ctx.createOscillator();
    const knockEnv = ctx.createGain();
    knock.type = 'triangle';
    knock.frequency.value = 900; // attack transient — presence on small speakers
    knockEnv.gain.setValueAtTime(0.0001, at);
    knockEnv.gain.linearRampToValueAtTime(0.5, at + 0.001);
    knockEnv.gain.exponentialRampToValueAtTime(0.0001, at + 0.02);
    knock.connect(knockEnv).connect(master);
    knock.start(at);
    knock.stop(at + 0.05);
  }
}

// Lane pitch: pitch ascends left→right across all lanes (position, not hand), on the major
// pentatonic — no semitones and no tritone, so sustained tones overlapping at speed stay consonant.
// Walk the degrees [0,2,4,7,9] up from C5, +12 per octave, and take lane N. (Hand is carried by
// timbre + pan, not octave — see bitrate-tones-spec.md §1-2.)
const PENTA = [0, 2, 4, 7, 9]; // major-pentatonic degrees (semitones)
const TONE_BASE = 523.25; // C5 — the ladder sits in 500–1300 Hz, above laptop-speaker roll-off

export function laneToneHz(lane: number): number {
  const octave = Math.floor(lane / PENTA.length);
  const degree = ((lane % PENTA.length) + PENTA.length) % PENTA.length;
  return TONE_BASE * Math.pow(2, (octave * 12 + PENTA[degree]) / 12);
}

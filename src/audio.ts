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

  // A single kalimba-like voice that holds the CURRENT target's lane pitch. Each time the target
  // changes it is re-plucked at the new pitch — a bright, quick attack that decays to a soft
  // sustain and rings on, so the note for the key you must press next keeps sounding until you
  // press it. Fast typing arpeggiates like a real thumb piano. Idempotent per frame: it only
  // re-plucks when the pitch actually changes.
  private hold: { osc: OscillatorNode; gain: GainNode } | null = null;
  private holdFreq = 0;
  private holdToken = -1; // advance token: changes whenever the target advances (see holdTone)
  private kalimbaWave: PeriodicWave | null = null;

  // The kalimba timbre: a strong fundamental with just a gentle 2nd/3rd harmonic and a steep
  // roll-off above — warm and round rather than tinny — voiced as harmonic amplitudes of a
  // periodic wave (built once per ctx).
  private kalimba(ctx: AudioContext): PeriodicWave {
    if (!this.kalimbaWave) {
      const imag = new Float32Array([0, 1.0, 0.38, 0.12, 0.05, 0.02]);
      this.kalimbaWave = ctx.createPeriodicWave(new Float32Array(imag.length), imag);
    }
    return this.kalimbaWave;
  }

  // Re-strike the tine at freq: step the pitch (no portamento — kalimba notes are discrete) and
  // fire a plucked amplitude envelope (fast attack → decay to a soft, ringing sustain).
  private pluck(ctx: AudioContext, freq: number): void {
    if (!this.hold) return;
    const t = ctx.currentTime;
    this.hold.osc.frequency.setValueAtTime(freq, t);
    this.hold.gain.gain.cancelScheduledValues(t);
    this.hold.gain.gain.setTargetAtTime(0.13, t, 0.004); // quick plucked attack
    this.hold.gain.gain.setTargetAtTime(0.045, t + 0.03, 0.18); // decay to a soft sustain (ring)
  }

  // `token` advances (e.g. the target index) every time the player selects correctly. Re-pluck on
  // a pitch change OR a token change, so pressing the same key twice in a row still strikes the
  // tine a second time — an audible bump confirming the press landed, not just a note that lingers.
  holdTone(freq: number, token: number): void {
    const ctx = this.ensure();
    if (!ctx) return;
    if (!this.hold) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.setPeriodicWave(this.kalimba(ctx));
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      osc.connect(g).connect(ctx.destination);
      osc.start();
      this.hold = { osc, gain: g };
      this.pluck(ctx, freq);
    } else if (freq !== this.holdFreq || token !== this.holdToken) {
      this.pluck(ctx, freq);
    }
    this.holdFreq = freq;
    this.holdToken = token;
  }

  stopHold(): void {
    this.holdToken = -1;
    if (!this.hold || !this.ctx) {
      this.hold = null;
      this.holdFreq = 0;
      return;
    }
    const t = this.ctx.currentTime;
    this.hold.gain.gain.setTargetAtTime(0.0001, t, 0.03); // fade out, then stop
    this.hold.osc.stop(t + 0.2);
    this.hold = null;
    this.holdFreq = 0;
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

// Four maximally-distinct yet consonant tones — the degrees of a major-6th chord (root, 3rd, 5th,
// 6th) — one per finger column (0..3, left→right, matching the lane colours). Handedness is the
// octave: the left hand sounds the chord in the base octave, the right hand an octave up. The
// chord spans under an octave, so the two hands' eight notes never collide and, being all chord
// tones, every pair stays consonant no matter the random order they're played in.
const CHORD = [0, 4, 7, 9]; // major-6th chord: root, major third, fifth, sixth (semitone offsets)
const BASE = 392.0; // G4 — the left hand's octave; the right hand is +12 semitones (an octave up)

export function fingerTone(col: number, hand: 0 | 1): number {
  const degree = ((col % CHORD.length) + CHORD.length) % CHORD.length;
  const semitone = CHORD[degree] + 12 * hand;
  return BASE * Math.pow(2, semitone / 12);
}

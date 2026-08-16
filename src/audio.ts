// Optional auditory feedback via AudioContext (never <audio> elements — their latency is
// unacceptable). A ~5 ms click on a correct selection, a distinct low tone on error.
// Off by default; unlocked on a user gesture (browsers require it).

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

  // A single sustained voice that holds the CURRENT target's lane pitch and steps to a new one
  // when the target changes — so the note for the key you must press next rings continuously
  // until you press it, and typing plays a little melody. Idempotent per frame: only the
  // oscillator frequency moves, and only when it actually changes.
  private hold: { osc: OscillatorNode; gain: GainNode } | null = null;
  private holdFreq = 0;

  holdTone(freq: number): void {
    const ctx = this.ensure();
    if (!ctx) return;
    if (!this.hold) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.setTargetAtTime(0.075, ctx.currentTime, 0.02); // gentle fade-in, no click
      osc.connect(g).connect(ctx.destination);
      osc.start();
      this.hold = { osc, gain: g };
    } else if (freq !== this.holdFreq) {
      // step to the next lane's pitch, with a tiny smoothing so the transition doesn't click
      this.hold.osc.frequency.setTargetAtTime(freq, ctx.currentTime, 0.006);
    }
    this.holdFreq = freq;
  }

  stopHold(): void {
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

  // ---- metronome: a steady pacing tick, scheduled on the audio clock ----
  // Ticks are placed at exact audio-clock times (not rAF times), so spacing is sample-accurate
  // despite frame jitter. startMetronome sets the period; pumpMetronome (called each frame)
  // schedules any ticks falling inside a short lookahead window.
  private metro: { period: number; next: number } | null = null;

  startMetronome(periodSec: number): void {
    const ctx = this.ensure();
    if (!ctx || !(periodSec > 0)) return;
    this.metro = { period: periodSec, next: ctx.currentTime + 0.12 };
  }

  stopMetronome(): void {
    this.metro = null;
  }

  pumpMetronome(): void {
    const ctx = this.ctx;
    if (!ctx || !this.metro) return;
    const lookahead = 0.12; // schedule ticks up to 120 ms ahead
    while (this.metro.next < ctx.currentTime + lookahead) {
      this.tickAt(ctx, this.metro.next);
      this.metro.next += this.metro.period;
    }
  }

  private tickAt(ctx: AudioContext, t: number): void {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 2000; // a short, dry click that sits above the sustained lane tone
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.06, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.028);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.05);
  }
}

// Lane index (0 = leftmost) → frequency, climbing left→right through the MAJOR PENTATONIC scale
// (do-re-mi-so-la = C D E G A), wrapping up an octave every 5 lanes. Pentatonic is the key: it
// omits the half-steps (fa, ti) and the tritone, so it has no dissonant intervals at all — every
// pair of these tones is consonant. Since the target is a random walk between the 8 lanes, that
// guarantees any two notes (in sequence or held together across a step) sound good together, while
// the wider average spacing (no cramped semitones) keeps adjacent lanes easy to tell apart.
// All offsets are whole semitones, so every note is in tune (equal temperament).
const PENTA = [0, 2, 4, 7, 9]; // semitone offsets of the major-pentatonic degrees within an octave
const DO = 523.25; // C5 — an octave above middle C, so even the leftmost lane clears the range where small speakers roll off

export function laneScale(index: number): number {
  const octave = Math.floor(index / PENTA.length);
  const degree = ((index % PENTA.length) + PENTA.length) % PENTA.length;
  const semitone = octave * 12 + PENTA[degree];
  return DO * Math.pow(2, semitone / 12);
}

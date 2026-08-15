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

  // A clean musical note for a correct selection, pitched by the target's lane (see laneScale).
  // Triangle wave: warm, clear fundamental, so adjacent scale steps are easy to tell apart.
  tone(freq: number): void {
    this.blip(freq, 130, 0.16, 'triangle');
  }
}

// Lane index (0 = leftmost) → frequency along a C-major scale: do-re-mi-fa-so-la-ti-do climbing
// left→right, so a s d f j k l ; ring out as one octave. Degrees past 7 keep climbing by octave.
const MAJOR = [0, 2, 4, 5, 7, 9, 11]; // semitone offsets of the major scale degrees
const DO = 261.63; // C4
export function laneScale(index: number): number {
  const octave = Math.floor(index / MAJOR.length);
  const semitone = octave * 12 + MAJOR[((index % MAJOR.length) + MAJOR.length) % MAJOR.length];
  return DO * Math.pow(2, semitone / 12);
}

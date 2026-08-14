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
}

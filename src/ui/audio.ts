// Auditory feedback via AudioContext (never <audio> elements — their latency is unacceptable).
// Off until unlocked on a user gesture, which browsers require.
//
// Two sounds survive: a rising "bloop" when a grid target is hit (v2), and a low tone on a wrong
// keypress (v1). Several other layers were built, A/B-tested and removed — an adaptive pacer, a
// per-lane target-tone bed, and a wrong-cell buzzer. None improved bit rate, so none of them ship.

export class AudioFeedback {
  private ctx: AudioContext | null = null;
  private enabled: boolean;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  setEnabled(e: boolean): void {
    this.enabled = e;
  }

  /** Call from a user gesture (e.g. the Start button) so the context is allowed to run. */
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

  /** v1: a short low tone on a wrong key. */
  error(): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 170;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(0.16, t0 + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.095);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.115);
  }

  /** v2: a quick rising sine on a correct grid click, paired with the particle burst. */
  bloop(): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, t0);
    osc.frequency.exponentialRampToValueAtTime(960, t0 + 0.06); // the "bloop" rise
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(0.25, t0 + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.18);
  }
}

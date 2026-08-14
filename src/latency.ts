// Dev-only overlay (enabled with ?debug in the URL) that measures keydown→paint latency
// and counts long frames, so the latency claims in §6 can be verified rather than assumed.
// markKey() is called synchronously in the keydown handler; frame() runs at the top of the
// rAF callback (immediately before paint), so their difference is a close keydown→paint proxy.

export class LatencyOverlay {
  private readonly enabled: boolean;
  private el: HTMLElement | null = null;
  private pendingKeyMs = -1;
  private lastLatency = 0;
  private maxLatency = 0;
  private frames = 0;
  private longFrames = 0;
  private lastFrameMs = -1;

  constructor(enabled: boolean) {
    this.enabled = enabled;
    if (enabled) {
      this.el = document.createElement('div');
      this.el.className = 'latency-overlay';
      document.body.appendChild(this.el);
    }
  }

  markKey(nowMs: number): void {
    if (this.enabled && this.pendingKeyMs < 0) this.pendingKeyMs = nowMs;
  }

  frame(nowMs: number): void {
    if (!this.enabled || !this.el) return;
    if (this.pendingKeyMs >= 0) {
      const lat = nowMs - this.pendingKeyMs;
      this.lastLatency = lat;
      if (lat >= 0 && lat < 250 && lat > this.maxLatency) this.maxLatency = lat;
      this.pendingKeyMs = -1;
    }
    if (this.lastFrameMs >= 0) {
      const dt = nowMs - this.lastFrameMs;
      this.frames++;
      if (dt > 20) this.longFrames++;
    }
    this.lastFrameMs = nowMs;
    if (this.frames % 6 === 0) {
      this.el.textContent =
        `keydown→paint ${this.lastLatency.toFixed(1)}ms (max ${this.maxLatency.toFixed(1)}ms) · ` +
        `long frames ${this.longFrames}/${this.frames}`;
    }
  }
}

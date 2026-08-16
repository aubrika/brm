import { describe, it, expect, beforeEach } from 'vitest';

// Minimal Web Audio mock so the pacer's scheduler can be exercised deterministically in Node.
class MockParam {
  value = 0;
  setValueAtTime(): void {}
  linearRampToValueAtTime(): void {}
  exponentialRampToValueAtTime(): void {}
  setTargetAtTime(): void {}
  cancelScheduledValues(): void {}
}
class MockNode {
  gain = new MockParam();
  frequency = new MockParam();
  type = '';
  curve: Float32Array | null = null;
  oversample = 'none';
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  setPeriodicWave(): void {}
  connect(dest: unknown): unknown {
    return dest;
  }
  disconnect(): void {}
  start(t = 0): void {
    this.startedAt = t;
  }
  stop(t = 0): void {
    this.stoppedAt = t;
  }
}
class MockCtx {
  static created: MockNode[] = [];
  currentTime = 0;
  state = 'running';
  destination = {};
  createGain(): MockNode {
    const n = new MockNode();
    MockCtx.created.push(n);
    return n;
  }
  createOscillator(): MockNode {
    const n = new MockNode();
    MockCtx.created.push(n);
    return n;
  }
  createWaveShaper(): MockNode {
    return new MockNode();
  }
  createPeriodicWave(): object {
    return {};
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
}

describe('pacer audio scheduling', () => {
  beforeEach(() => {
    MockCtx.created = [];
    (globalThis as { AudioContext?: unknown }).AudioContext = MockCtx;
    (globalThis as { window?: unknown }).window = { setInterval: () => 1, clearInterval: () => {} };
  });

  it('startPacer then pumping schedules kick oscillators as the audio clock advances', async () => {
    const { AudioFeedback } = await import('./audio.js');
    const audio = new AudioFeedback(true);
    audio.unlock(); // creates the (mock) context on the "user gesture"
    expect(audio.startPacer(4, 0.16)).toBe(true); // 4 Hz

    const ctx = (audio as unknown as { ctx: MockCtx }).ctx;
    const pump = (audio as unknown as { pumpPacer: () => void }).pumpPacer.bind(audio);
    for (let i = 0; i < 8; i++) {
      ctx.currentTime += 0.1; // advance ~0.8 s total
      pump();
    }

    const started = MockCtx.created.filter((n) => n.startedAt !== null);
    // ~4 Hz over ~0.8 s ≈ 3 kicks, each a body + beater oscillator → several started nodes
    expect(started.length).toBeGreaterThanOrEqual(4);
  });

  it('records a click time on the performance.now() clock for each scheduled click', async () => {
    const { AudioFeedback } = await import('./audio.js');
    const audio = new AudioFeedback(true);
    audio.unlock();
    audio.startPacer(4, 0.16);
    const ctx = (audio as unknown as { ctx: MockCtx }).ctx;
    const pump = (audio as unknown as { pumpPacer: () => void }).pumpPacer.bind(audio);
    for (let i = 0; i < 8; i++) {
      ctx.currentTime += 0.1;
      pump();
    }
    const clicks = audio.stopPacer();
    expect(clicks.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < clicks.length; i++) expect(clicks[i]).toBeGreaterThan(clicks[i - 1]);
  });
});

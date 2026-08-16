import { describe, it, expect, beforeEach } from 'vitest';
import { laneToneHz } from './audio.js';

describe('laneToneHz (major-pentatonic lane ladder)', () => {
  it('matches the spec table for the 8 default lanes (C5 up to E6)', () => {
    const hz = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.51];
    for (let i = 0; i < hz.length; i++) expect(laneToneHz(i)).toBeCloseTo(hz[i], 1);
  });
  it('ascends monotonically and repeats the pentatonic pattern an octave up', () => {
    for (let i = 1; i < 12; i++) expect(laneToneHz(i)).toBeGreaterThan(laneToneHz(i - 1));
    expect(laneToneHz(5)).toBeCloseTo(laneToneHz(0) * 2, 2); // lane 5 = C6 = C5 × 2
  });
});

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
  pan = new MockParam();
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
  createBiquadFilter(): MockNode {
    return new MockNode();
  }
  createStereoPanner(): MockNode {
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

describe('target tones', () => {
  beforeEach(() => {
    MockCtx.created = [];
    (globalThis as { AudioContext?: unknown }).AudioContext = MockCtx;
    (globalThis as { window?: unknown }).window = { setInterval: () => 1, clearInterval: () => {} };
  });

  it('each toneAdvance starts a voice and the pool is capped at 3 (oldest stolen)', async () => {
    const { AudioFeedback } = await import('./audio.js');
    const audio = new AudioFeedback(true);
    audio.unlock();
    // hold the clock at 0 so release tails never expire — forces the cap rather than pruning
    for (let i = 0; i < 6; i++) audio.toneAdvance(500 + i * 60, (i % 2) as 0 | 1);
    const voices = (audio as unknown as { toneVoices: unknown[] }).toneVoices;
    expect(voices.length).toBeLessThanOrEqual(3);
    expect(audio.voiceStealEvents).toBeGreaterThan(0);
    const startedOscs = MockCtx.created.filter((n) => n.startedAt !== null);
    expect(startedOscs.length).toBe(6); // one oscillator started per advance
  });
});

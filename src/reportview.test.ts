// Smoke test for the results screen. renderReport builds a lot of DOM/SVG from a log, and a
// single thrown error there would blank the whole post-run screen in the browser (where it
// can't be unit-tested against the real scoring core). This drives the exact code path and
// asserts the panels appear — and that suppression fires when a sample is too thin.
//
// It runs in the plain node environment against a tiny hand-rolled DOM shim (below) rather
// than jsdom: the subset renderReport touches is small, and a full DOM library dragged in a
// broken transitive dependency in this repo's hoisted node_modules. Zero deps, deterministic.

import { describe, it, expect, beforeAll } from 'vitest';
import { renderReport, type LogInfo } from './reportview.js';
import type { RunLog, RawEvent } from './stats.js';

// --------------------------------------------------------------- DOM shim ----
class TextNode {
  constructor(public readonly _t: string) {}
  get textContent(): string {
    return this._t;
  }
}
class MockEl {
  className = '';
  private _text = '';
  attrs: Record<string, string> = {};
  childNodes: Array<MockEl | TextNode> = [];
  style: Record<string, unknown> = { setProperty: (): void => {} };
  constructor(public readonly tag: string, public readonly ns?: string) {}
  set textContent(v: string) {
    this._text = String(v);
    this.childNodes = [];
  }
  get textContent(): string {
    if (this.childNodes.length) return this.childNodes.map((c) => c.textContent ?? '').join('');
    return this._text;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = String(v);
    if (k === 'class') this.className = String(v); // real DOM mirrors class ↔ className
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  append(...nodes: Array<MockEl | TextNode | string>): void {
    for (const n of nodes) this.childNodes.push(typeof n === 'string' ? new TextNode(n) : n);
  }
  appendChild(n: MockEl | TextNode): MockEl | TextNode {
    this.append(n);
    return n;
  }
  addEventListener(): void {}
  focus(): void {}
  private get classes(): string[] {
    return this.className.split(/\s+/).filter(Boolean);
  }
  matches(sel: string): boolean {
    return sel.startsWith('.') ? this.classes.includes(sel.slice(1)) : this.tag === sel;
  }
  querySelectorAll(sel: string): MockEl[] {
    const out: MockEl[] = [];
    const walk = (node: MockEl): void => {
      for (const c of node.childNodes) {
        if (c instanceof MockEl) {
          if (c.matches(sel)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): MockEl | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

beforeAll(() => {
  const doc = {
    createElement: (t: string): MockEl => new MockEl(t),
    createElementNS: (ns: string, t: string): MockEl => new MockEl(t, ns),
    createTextNode: (t: string): TextNode => new TextNode(t),
  };
  Object.assign(globalThis, {
    document: doc,
    window: { matchMedia: () => ({ matches: false }) },
    requestAnimationFrame: () => 0,
  });
});

// ---------------------------------------------------------------- fixture ----
function synthLog(selections: number, errEvery: number): RunLog {
  const CH = [...'asdfjkl;'];
  const seq: string[] = [];
  for (let i = 0; i < selections + 5; i++) seq.push(CH[(i * 3 + 1) % 8]);
  const events: RawEvent[] = [];
  let t = 300;
  let idx = 0;
  let sc = 0;
  let si = 0;
  let made = 0;
  while (made < selections && idx < seq.length) {
    const target = seq[idx];
    const isErr = errEvery > 0 && made > 0 && made % errEvery === 0;
    const col = CH.indexOf(target);
    const key = isErr ? CH[(col + 1) % 8] : target; // adjacent-lane miss
    events.push([t, 'down', key, idx, isErr ? 'err' : 'ok']);
    events.push([t + 70, 'up', key, idx, null]);
    if (isErr) si++;
    else {
      sc++;
      idx++;
    }
    made++;
    t += 240 + (made % 5) * 30 + (isErr ? 150 : 0);
  }
  const bps = (Math.log2(7) * Math.max(sc - si, 0)) / 60;
  return {
    schemaVersion: 2,
    meta: {
      runId: 'test-run-0001',
      startedAt: '2026-08-14T10:00:00.000Z',
      mode: 'scored',
      machine: { installId: 'u_test', label: 'test', ua: 'x', platform: 'x', hardwareConcurrency: 8, estimatedRefreshHz: 120, timeOriginPrecisionMs: 0.1 },
      config: { alphabet: 'asdfjkl;', n: 8, lookahead: 7, lanes: true, sound: true, errorFeedback: 'flash+shake', durationMs: 60000 },
    },
    sequence: seq.slice(0, idx + 1),
    eventColumns: ['t', 'type', 'key', 'idx', 'verdict'],
    events,
    latencySamples: [],
    summary: {
      bitsPerSecond: bps, n: 8, sc, si, elapsedS: 60,
      accuracy: sc / (sc + si), grossKeysPerSec: (sc + si) / 60, netSelectionsPerSec: Math.max(sc - si, 0) / 60,
      medianIkiMs: 260, rollovers: 0, droppedFrames: 0, outOfAlphabet: 0,
    },
  };
}

const noop = (): void => {};
const cb = { onRunAgain: noop, onConfig: noop, onDownload: noop };
const info: LogInfo = { available: true, path: 'logs/test.json' };
const root = (): MockEl => new MockEl('div');

// The shim's element is structurally what renderReport needs; the cast keeps the call typed.
const render = (r: MockEl, ...rest: [RunLog, Parameters<typeof renderReport>[2], LogInfo, typeof cb]): void =>
  renderReport(r as unknown as HTMLElement, ...rest);

describe('renderReport', () => {
  it('renders the full dashboard without throwing on a healthy run', () => {
    const r = root();
    expect(() => render(r, synthLog(150, 10), [], info, cb)).not.toThrow();
    expect(r.querySelector('.r-hero-num')?.textContent).toBeTruthy();
    expect(r.querySelectorAll('.r-sec-title').length).toBeGreaterThanOrEqual(4); // hero+tape+pace+transitions(+misses)
    expect(r.querySelectorAll('.r-tick').length).toBeGreaterThan(20); // one tick per keystroke
    expect(r.querySelector('.r-hist-bar')).not.toBeNull();
    expect(r.querySelectorAll('.r-di-row').length).toBeGreaterThan(0); // ranked digraph transitions
    expect(r.querySelector('.r-saved')?.textContent).toContain('logs/test.json');
  });

  it('suppresses the misses panel when Si < 5', () => {
    const r = root();
    render(r, synthLog(120, 0), [], info, cb); // errEvery 0 → no misses
    const titles = r.querySelectorAll('.r-sec-title').map((e) => e.textContent);
    expect(titles.some((t) => t.startsWith('Misses'))).toBe(false);
  });

  it('shows the machine sparkline only when there is prior history', () => {
    const withHistory = root();
    const history = [
      { runId: 'p1', startedAt: '2026-08-14T09:00:00Z', mode: 'scored' as const, label: 'test', summary: { bitsPerSecond: 3.1, n: 8 }, file: 'a.json' },
      { runId: 'p2', startedAt: '2026-08-14T09:30:00Z', mode: 'practice' as const, label: 'test', summary: { bitsPerSecond: 4.2, n: 8 }, file: 'b.json' },
    ];
    render(withHistory, synthLog(150, 10), history, info, cb);
    expect(withHistory.querySelector('.r-spark-svg')).not.toBeNull();

    const firstRun = root();
    render(firstRun, synthLog(150, 10), [], info, cb);
    expect(firstRun.querySelector('.r-spark-svg')).toBeNull();
  });

  it('falls back to the download message when logging is unavailable', () => {
    const r = root();
    render(r, synthLog(150, 10), [], { available: false }, cb);
    expect(r.querySelector('.r-saved')?.textContent).toContain('Local logging unavailable');
  });
});

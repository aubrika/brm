// buildReport assembles the run log — the single artifact the report screen renders, the analyzer
// reads, and every published number is derived from. Its central promise is VERIFIABILITY: the log
// carries the generated sequence AND every event, so B can be recomputed from the file alone and
// the sequence checked for uniformity. These tests pin that promise rather than the field list.

import { describe, it, expect } from 'vitest';
import { buildReport } from './report.js';
import { RunRecorder } from './logging.js';
import { GridEngine } from '../v2/engine.js';
import { KeyboardEngine } from '../v1/engine.js';
import { DEFAULT_GRID_CONFIG } from '../core/config.js';
import { DEFAULT_KEYBOARD_CONFIG } from '../v1/config.js';
import { bitRate } from '../core/bitrate.js';
import type { MachineMeta, RunLog } from '../core/stats.js';

const machine: MachineMeta = {
  installId: 'test-install',
  label: 'ignored — buildReport takes the label off the engine config',
  ua: 'test',
  platform: 'test',
  hardwareConcurrency: 8,
  estimatedRefreshHz: 60,
  timeOriginPrecisionMs: 0.1,
};

/** Play `hits` correct selections and `misses` wrong ones through the real engine + recorder, then
 *  build the log the app would have written. Nothing is stubbed: the events come from the engine's
 *  own verdicts, so a change to scoring shows up here. */
function playGrid(hits: number, misses: number, gridSize = 32) {
  const engine = new GridEngine({ ...DEFAULT_GRID_CONFIG, gridSize }, true);
  const recorder = new RunRecorder();
  engine.start(0);
  let t = 0;
  for (let i = 0; i < hits; i++) {
    if (i < misses) {
      const wrong = (engine.target() + 1) % engine.cells;
      t += 120;
      const idxBefore = engine.index;
      engine.handleClick(wrong, t);
      recorder.recordDown(String(wrong), idxBefore, 'err', t);
    }
    t += 400;
    const idxBefore = engine.index;
    engine.handleClick(engine.target(), t);
    recorder.recordDown(String(engine.lastCorrectCell), idxBefore, 'ok', t);
  }
  const log = buildReport(engine, engine.result(), {
    recorder,
    machine,
    mode: 'scored',
    startedAt: '2026-08-19T00:00:00.000Z',
    droppedFrames: 3,
    grid: { enabled: true, gridSize, depth: 1, fieldPx: 672, cellPx: 21, devicePixelRatio: 1, ghost: true, lookahead: 1, crosshair: true, hoverPulse: true, pointerType: 'mouse', sizing: 'fixed' },
  });
  return { engine, log };
}

/** Recompute B from the log alone, the way an outside reader would. */
function recomputeBitRate(log: RunLog): number {
  const downs = log.events.filter((e) => e[1] === 'down');
  const sc = downs.filter((e) => e[4] === 'ok').length;
  const si = downs.filter((e) => e[4] === 'err').length;
  return bitRate(log.summary.n, sc, si, log.summary.elapsedS);
}

describe('buildReport — the verifiability guarantee', () => {
  it('carries enough to recompute B without trusting the summary', () => {
    const { log } = playGrid(20, 4);
    expect(recomputeBitRate(log)).toBeCloseTo(log.summary.bitsPerSecond, 10);
  });

  it('agrees with the engine on the counts it reports', () => {
    const { engine, log } = playGrid(20, 4);
    expect(log.summary.sc).toBe(engine.sc);
    expect(log.summary.si).toBe(engine.si);
    expect(log.summary.n).toBe(engine.n);
  });

  it('logs one `ok` event per scored selection and one `err` per miss', () => {
    const { log } = playGrid(12, 5);
    const downs = log.events.filter((e) => e[1] === 'down');
    expect(downs.filter((e) => e[4] === 'ok')).toHaveLength(12);
    expect(downs.filter((e) => e[4] === 'err')).toHaveLength(5);
  });

  // The analyzer joins the event `key` column back onto `sequence` by index to reconstruct what was
  // shown. If the two ever disagree the log stops being self-describing.
  it('emits a sequence whose entries match the keys of the events that answered them', () => {
    const { log } = playGrid(10, 0);
    const oks = log.events.filter((e) => e[1] === 'down' && e[4] === 'ok');
    for (const e of oks) expect(log.sequence[e[3]]).toBe(e[2]);
  });

  it('includes the unfinished target, so the sequence is one longer than the completed count', () => {
    const { log } = playGrid(10, 0);
    expect(log.sequence).toHaveLength(11);
  });
});

describe('buildReport — the config discriminator', () => {
  // A grid run has no alphabet, no fingers and no falling lanes. Stamping those defaults in would
  // describe a keyboard game that never ran, which is why RunConfig is discriminated on `mode`.
  it('states only grid fields on a grid run', () => {
    const { log } = playGrid(3, 0);
    expect(log.meta.config.mode).toBe('grid');
    expect(log.meta.config.alphabet).toBeUndefined();
    expect(log.meta.config.leftFingers).toBeUndefined();
    expect(log.meta.config.lookahead).toBeUndefined();
  });

  it('states the alphabet and fingers on a keyboard run', () => {
    const engine = new KeyboardEngine({ ...DEFAULT_KEYBOARD_CONFIG }, true);
    engine.start(0);
    const log = buildReport(engine, engine.result(), {
      recorder: new RunRecorder(),
      machine,
      mode: 'practice',
      startedAt: '2026-08-19T00:00:00.000Z',
      droppedFrames: 0,
    });
    expect(log.meta.config.mode).toBe('keyboard');
    expect(log.meta.config.alphabet).toBe(DEFAULT_KEYBOARD_CONFIG.alphabet);
    expect(log.meta.config.leftFingers).toBe(DEFAULT_KEYBOARD_CONFIG.leftFingers);
    expect(log.grid).toBeUndefined();
  });
});

describe('buildReport — optional sections', () => {
  it('omits a section entirely rather than writing an empty one', () => {
    const engine = new KeyboardEngine({ ...DEFAULT_KEYBOARD_CONFIG }, true);
    engine.start(0);
    const log = buildReport(engine, engine.result(), {
      recorder: new RunRecorder(), machine, mode: 'practice', startedAt: 'x', droppedFrames: 0,
    });
    expect('grid' in log).toBe(false);
    expect('pointerPath' in log).toBe(false);
  });

  it('carries the grid geometry a Fitts analysis needs', () => {
    const { log } = playGrid(3, 0);
    expect(log.grid).toMatchObject({ enabled: true, gridSize: 32, cellPx: 21, fieldPx: 672, sizing: 'fixed' });
  });

  it('stamps the schema version and the run identity the analyzer filters on', () => {
    const { log } = playGrid(3, 0);
    expect(log.schemaVersion).toBe(3);
    expect(log.meta.mode).toBe('scored');
    expect(log.meta.startedAt).toBe('2026-08-19T00:00:00.000Z');
    expect(log.meta.machine.installId).toBe('test-install');
    expect(log.summary.droppedFrames).toBe(3);
  });

  // The machine meta is passed through from the probe, unaltered. It used to be rewritten here —
  // buildReport overwrote `label` with the config's copy, back when the config screen had a machine
  // name box. That box is gone, so the config no longer carries a label and there is nothing to
  // overwrite with; the probe is now the only source. `label` itself stays in MachineMeta because
  // logs/ holds runs that set it, and the analyzer groups by it.
  it('passes the probed machine meta through unaltered', () => {
    const engine = new GridEngine({ ...DEFAULT_GRID_CONFIG }, true);
    engine.start(0);
    const log = buildReport(engine, engine.result(), {
      recorder: new RunRecorder(), machine, mode: 'scored', startedAt: 'x', droppedFrames: 0,
    });
    expect(log.meta.machine).toEqual(machine);
  });
});

// Assembles the schema-v2 run log — the single artifact that is (a) POSTed to logs/, (b)
// offered as a JSON download, and (c) the exact input the on-screen report renders from and
// that scripts/analyze.mjs reads offline. One object, three consumers, so what you see, what
// you save, and what the analyzer computes can never disagree. The verifiability guarantee
// holds: the log carries the full generated sequence AND every keystroke, so B is
// independently recomputable and the sequence independently checkable for uniformity.

import type { Engine } from '../v1/engine.js';
import type { GridEngine } from '../v2/engine.js';
import type { RunResult } from '../core/bitrate.js';
import type { RunLog, MachineMeta, RunConfig } from '../core/stats.js';
import { splitEvents, medianIki, countRollovers } from '../core/stats.js';
import type { RunRecorder } from './logging.js';

const EVENT_COLUMNS: RunLog['eventColumns'] = ['t', 'type', 'key', 'idx', 'verdict'];

export interface BuildOpts {
  recorder: RunRecorder;
  machine: MachineMeta;
  mode: 'scored' | 'practice';
  startedAt: string; // ISO
  droppedFrames: number;
  grid?: RunLog['grid']; // GRID / SCOPE MODE
  pointerPath?: RunLog['pointerPath']; // GRID / SCOPE MODE
}

// A grid run has no keyboard alphabet/finger structure, so buildReport accepts either engine and
// takes only the loop-facing surface both share (config, n, sequence, index).
type ReportEngine = Engine | GridEngine;

export function buildReport(engine: ReportEngine, result: RunResult, opts: BuildOpts): RunLog {
  const events = opts.recorder.buildEvents();
  const shell = { eventColumns: EVENT_COLUMNS, events } as unknown as RunLog;
  const { downs } = splitEvents(shell);

  const elapsedS = result.tSeconds;
  const net = Math.max(result.sc - result.si, 0);

  // State only what was actually played. A grid run has no alphabet, no fingers, no falling lanes —
  // stamping those defaults into the log described a keyboard game that never ran.
  const isGrid = !!opts.grid;
  const config: RunConfig = isGrid
    ? {
        mode: 'grid',
        n: engine.n,
        durationMs: engine.config.durationMs,
        sound: engine.config.sound,
      }
    : {
        mode: 'keyboard',
        n: engine.n,
        durationMs: engine.config.durationMs,
        sound: engine.config.sound,
        alphabet: engine.config.alphabet,
        leftFingers: engine.config.leftFingers,
        rightFingers: engine.config.rightFingers,
        lookahead: engine.config.lookahead,
      };

  // build stamp (Vite `define`); `typeof` guard keeps it safe if ever run outside the bundle
  const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
  const commit = typeof __APP_COMMIT__ !== 'undefined' ? __APP_COMMIT__ : 'dev';

  return {
    schemaVersion: 3,
    meta: {
      appVersion,
      commit,
      runId: crypto.randomUUID(),
      startedAt: opts.startedAt,
      mode: opts.mode,
      machine: { ...opts.machine, label: engine.config.label },
      config,
    },
    // targets shown, incl. the unfinished one. Keyboard targets are glyph strings; grid targets are
    // cell indices — either way String(x) matches the event `key` column of that selection.
    sequence: (engine.sequence as unknown[]).slice(0, engine.index + 1).map((x) => String(x)),
    eventColumns: EVENT_COLUMNS,
    events,
    latencySamples: opts.recorder.buildLatency(),
    summary: {
      bitsPerSecond: result.bitsPerSecond,
      n: result.n,
      sc: result.sc,
      si: result.si,
      elapsedS,
      accuracy: result.accuracy,
      grossKeysPerSec: result.grossPerSecond,
      netSelectionsPerSec: elapsedS > 0 ? net / elapsedS : 0,
      medianIkiMs: Math.round(medianIki(downs) * 10) / 10,
      rollovers: countRollovers(shell),
      droppedFrames: opts.droppedFrames,
      outOfAlphabet: opts.recorder.outOfAlphabet,
    },
    ...(opts.grid ? { grid: opts.grid } : {}),
    ...(opts.pointerPath ? { pointerPath: opts.pointerPath } : {}),
  };
}

export function downloadReport(log: RunLog): void {
  const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bitrate-run-${log.summary.bitsPerSecond.toFixed(2)}bps.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

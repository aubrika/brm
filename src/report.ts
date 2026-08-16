// Assembles the schema-v2 run log — the single artifact that is (a) POSTed to logs/, (b)
// offered as a JSON download, and (c) the exact input the on-screen report renders from and
// that scripts/analyze.mjs reads offline. One object, three consumers, so what you see, what
// you save, and what the analyzer computes can never disagree. The verifiability guarantee
// holds: the log carries the full generated sequence AND every keystroke, so B is
// independently recomputable and the sequence independently checkable for uniformity.

import type { Engine } from './engine.js';
import type { GridEngine } from './gridengine.js';
import type { RunResult } from './scoring.js';
import type { RunLog, MachineMeta, RunConfig } from './stats.js';
import { splitEvents, medianIki, countRollovers } from './stats.js';
import type { RunRecorder } from './logging.js';

const EVENT_COLUMNS: RunLog['eventColumns'] = ['t', 'type', 'key', 'idx', 'verdict'];

export interface BuildOpts {
  recorder: RunRecorder;
  machine: MachineMeta;
  mode: 'scored' | 'practice';
  startedAt: string; // ISO
  droppedFrames: number;
  pacer: RunLog['pacer'];
  tones: RunLog['tones'];
  grid?: RunLog['grid']; // GRID MODE only
  pointerPath?: RunLog['pointerPath']; // GRID MODE only
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

  const config: RunConfig = {
    alphabet: engine.config.alphabet,
    n: engine.n,
    leftFingers: engine.config.leftFingers,
    rightFingers: engine.config.rightFingers,
    topRow: engine.config.topRow, // recorded so the report can colour top-row keys by their lane
    leftTopRow: engine.config.leftTopRow,
    rightTopRow: engine.config.rightTopRow,
    chords: engine.config.chords,
    lookahead: engine.config.lookahead,
    lanes: engine.config.lanes,
    chord: engine.config.chord,
    sound: engine.config.sound,
    errorFeedback: engine.config.errorFeedback,
    durationMs: engine.config.durationMs,
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
    // targets shown, incl. the unfinished one. Grid targets are cell indices — stringified to match
    // the event `key` column and the string[] schema.
    sequence: (engine.sequence as Array<string | number>).slice(0, engine.index + 1).map(String),
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
    pacer: opts.pacer,
    tones: opts.tones,
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

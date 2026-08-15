// Assembles the schema-v2 run log — the single artifact that is (a) POSTed to logs/, (b)
// offered as a JSON download, and (c) the exact input the on-screen report renders from and
// that scripts/analyze.mjs reads offline. One object, three consumers, so what you see, what
// you save, and what the analyzer computes can never disagree. The verifiability guarantee
// holds: the log carries the full generated sequence AND every keystroke, so B is
// independently recomputable and the sequence independently checkable for uniformity.

import type { Engine } from './engine.js';
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
}

export function buildReport(engine: Engine, result: RunResult, opts: BuildOpts): RunLog {
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
    thumbs: engine.config.thumbs,
    leftThumb: engine.config.leftThumb,
    rightThumb: engine.config.rightThumb,
    lookahead: engine.config.lookahead,
    lanes: engine.config.lanes,
    chord: engine.config.chord,
    sound: engine.config.sound,
    errorFeedback: engine.config.errorFeedback,
    durationMs: engine.config.durationMs,
  };

  return {
    schemaVersion: 2,
    meta: {
      runId: crypto.randomUUID(),
      startedAt: opts.startedAt,
      mode: opts.mode,
      machine: { ...opts.machine, label: engine.config.label },
      config,
    },
    sequence: engine.sequence.slice(0, engine.index + 1), // targets shown, incl. the unfinished one
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

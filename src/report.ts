// End-of-run report object: the on-screen numbers plus everything the panel needs to
// verify the run independently — the full generated sequence (check it's i.i.d.) and the
// full keystroke log with timestamps (recompute the score without trusting the app).

import type { Engine } from './engine.js';
import type { RunResult } from './scoring.js';
import type { GameConfig } from './config.js';

export interface RunReport {
  version: 1;
  bitsPerSecond: number;
  n: number;
  sc: number;
  si: number;
  tSeconds: number;
  accuracy: number;
  grossPerSecond: number;
  netBits: number;
  errorsByTarget: Record<string, number>;
  config: GameConfig;
  sequence: string; // the full generated target sequence
  keystrokes: Array<{ key: string; tMs: number; ctrl: boolean; meta: boolean; alt: boolean }>;
}

export function buildReport(engine: Engine, result: RunResult): RunReport {
  return {
    version: 1,
    bitsPerSecond: result.bitsPerSecond,
    n: result.n,
    sc: result.sc,
    si: result.si,
    tSeconds: result.tSeconds,
    accuracy: result.accuracy,
    grossPerSecond: result.grossPerSecond,
    netBits: result.netBits,
    errorsByTarget: result.errorsByTarget,
    config: engine.config,
    sequence: engine.sequence.join(''),
    keystrokes: engine.log.map((k) => ({
      key: k.key,
      tMs: Math.round(k.tMs * 1000) / 1000,
      ctrl: k.ctrlKey,
      meta: k.metaKey,
      alt: k.altKey,
    })),
  };
}

export function downloadReport(report: RunReport): void {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bitrate-run-${report.bitsPerSecond.toFixed(2)}bps.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Client side of run logging. The recorder is on the hot path, so it allocates nothing per
// keystroke — it pushes primitives into pre-sized typed arrays during the run and assembles
// the JSON object once, after the timer expires. The network write (postLog) happens on the
// report screen, never during play. If the log endpoint is absent (prebuilt dist/ served by
// a plain static server), probeHealth() reports false and the app falls back to the manual
// JSON download — never blocking, never retrying, never surfacing a stack trace.

import type { RawEvent, RunLog, Verdict } from '../core/stats.js';

const CAP = 2048; // generous ceiling for a 60 s run (~120–250 keystrokes); no mid-run realloc
const PCAP = 4608; // grid pointer-path ceiling: > 60 fps × 60 s samples, no mid-run realloc

const VERDICT_OK = 0;
const VERDICT_ERR = 1;

export class RunRecorder {
  // event columns, stored column-wise as primitives
  private readonly et = new Float64Array(CAP); // t (ms, run-relative)
  private readonly etype = new Uint8Array(CAP); // 0 = down, 1 = up
  private readonly ekey: string[] = new Array(CAP);
  private readonly eidx = new Int32Array(CAP);
  private readonly ev = new Int8Array(CAP); // verdict: 0 ok, 1 err, -1 none (up)
  private ec = 0;

  private readonly lt = new Float64Array(CAP); // latency sample t
  private readonly lms = new Float64Array(CAP); // latency downToPaintMs
  private lc = 0;

  // GRID MODE pointer path: field-local (t, x, y), at most one sample per frame. ~60/s × 60 s is
  // ~3600 samples; PCAP gives headroom without a mid-run realloc. This is what makes Fitts
  // analysis possible (movement time, path length vs straight-line, verify pauses near the target).
  private readonly pt = new Float64Array(PCAP);
  private readonly px = new Float32Array(PCAP);
  private readonly py = new Float32Array(PCAP);
  private pc = 0;

  outOfAlphabet = 0;

  recordDown(key: string, idx: number, verdict: Verdict, t: number): void {
    if (this.ec >= CAP) return; // hard cap; a real run never approaches it
    const i = this.ec++;
    this.et[i] = t;
    this.etype[i] = 0;
    this.ekey[i] = key;
    this.eidx[i] = idx;
    this.ev[i] = verdict === 'ok' ? VERDICT_OK : VERDICT_ERR;
  }

  recordUp(key: string, idx: number, t: number): void {
    if (this.ec >= CAP) return;
    const i = this.ec++;
    this.et[i] = t;
    this.etype[i] = 1;
    this.ekey[i] = key;
    this.eidx[i] = idx;
    this.ev[i] = -1;
  }

  recordLatency(t: number, downToPaintMs: number): void {
    if (this.lc >= CAP) return;
    const i = this.lc++;
    this.lt[i] = t;
    this.lms[i] = downToPaintMs;
  }

  // GRID MODE: one pointer sample (run-relative t, field-local x/y). Caller throttles to once per
  // frame. Silently drops past the cap (a full 60 s at max frame rate stays under it).
  recordPointer(t: number, x: number, y: number): void {
    if (this.pc >= PCAP) return;
    const i = this.pc++;
    this.pt[i] = t;
    this.px[i] = x;
    this.py[i] = y;
  }

  // Assemble the array-of-arrays event log. Called once, at run end.
  buildEvents(): RawEvent[] {
    const out: RawEvent[] = new Array(this.ec);
    for (let i = 0; i < this.ec; i++) {
      const t = Math.round(this.et[i] * 1000) / 1000;
      const type = this.etype[i] === 0 ? 'down' : 'up';
      const verdict = this.etype[i] === 1 ? null : this.ev[i] === VERDICT_OK ? 'ok' : 'err';
      out[i] = [t, type, this.ekey[i], this.eidx[i], verdict];
    }
    return out;
  }

  buildLatency(): Array<{ t: number; downToPaintMs: number }> {
    const out = new Array(this.lc);
    for (let i = 0; i < this.lc; i++) {
      out[i] = { t: Math.round(this.lt[i] * 1000) / 1000, downToPaintMs: Math.round(this.lms[i] * 100) / 100 };
    }
    return out;
  }

  // GRID MODE pointer path as [t, x, y] triples (t to 0.1 ms, coords to 0.1 px). Empty for
  // keyboard runs. Called once, at run end.
  buildPointerPath(): Array<[number, number, number]> {
    const out: Array<[number, number, number]> = new Array(this.pc);
    for (let i = 0; i < this.pc; i++) {
      out[i] = [Math.round(this.pt[i] * 10) / 10, Math.round(this.px[i] * 10) / 10, Math.round(this.py[i] * 10) / 10];
    }
    return out;
  }
}

export interface PostResult {
  ok: boolean;
  path?: string;
  reason?: string;
}

// Is the log endpoint present? Probed once at startup; a plain static server (no Vite
// plugin) fails this and the app offers only the download button.
export async function probeHealth(): Promise<boolean> {
  try {
    const res = await fetch('api/log/health', { method: 'GET' });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

export async function postLog(log: RunLog): Promise<PostResult> {
  try {
    const res = await fetch('api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(log),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = (await res.json()) as { ok?: boolean; path?: string };
    return body.ok ? { ok: true, path: body.path } : { ok: false, reason: 'server declined' };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'network error' };
  }
}

export interface IndexRow {
  runId: string;
  startedAt: string;
  mode: 'scored' | 'practice';
  label: string;
  summary: { bitsPerSecond: number; n: number };
  file: string;
}

// Last runs for this install, for the report screen's "this machine" sparkline. Returns []
// when logging is unavailable or the fetch fails — the sparkline panel simply hides.
export async function fetchIndex(installId: string): Promise<IndexRow[]> {
  try {
    const res = await fetch(`api/log/index?installId=${encodeURIComponent(installId)}`, { method: 'GET' });
    if (!res.ok) return [];
    const body = (await res.json()) as IndexRow[];
    return Array.isArray(body) ? body : [];
  } catch {
    return [];
  }
}

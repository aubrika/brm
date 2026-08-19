// RunRecorder is the only piece of the app that runs on the hot path during a scored run, and it
// is a column store of typed arrays rather than an array of objects — chosen so a keystroke
// allocates nothing. That buys speed at the cost of two things worth pinning: the columns must stay
// aligned when they are reassembled, and the fixed caps must drop silently rather than throw or
// corrupt. Everything downstream — the report, the analyzer, every published number — reads what
// comes out of here.

import { describe, it, expect } from 'vitest';
import { RunRecorder } from './logging.js';

const CAP = 2048; // mirrors the private cap in logging.ts
const PCAP = 4608;

describe('RunRecorder — column alignment', () => {
  it('reassembles interleaved downs and ups in order, with each row intact', () => {
    const r = new RunRecorder();
    r.recordDown('a', 0, 'ok', 100);
    r.recordUp('a', 0, 140);
    r.recordDown('b', 1, 'err', 220);
    r.recordUp('b', 1, 260);

    expect(r.buildEvents()).toEqual([
      [100, 'down', 'a', 0, 'ok'],
      [140, 'up', 'a', 0, null],
      [220, 'down', 'b', 1, 'err'],
      [260, 'up', 'b', 1, null],
    ]);
  });

  // An `up` carries no verdict. Encoding it as -1 in an Int8Array and decoding it back to null is
  // exactly the kind of round-trip a column store can get subtly wrong.
  it('gives ups a null verdict and never mistakes one for an ok', () => {
    const r = new RunRecorder();
    r.recordUp('x', 7, 10);
    const [row] = r.buildEvents();
    expect(row[1]).toBe('up');
    expect(row[4]).toBeNull();
  });

  it('keeps long keys and large indices, which the grid path uses', () => {
    const r = new RunRecorder();
    r.recordDown('1023', 511, 'ok', 1);
    expect(r.buildEvents()[0]).toEqual([1, 'down', '1023', 511, 'ok']);
  });

  it('starts empty and stays empty until something is recorded', () => {
    const r = new RunRecorder();
    expect(r.buildEvents()).toEqual([]);
    expect(r.buildLatency()).toEqual([]);
    expect(r.buildPointerPath()).toEqual([]);
    expect(r.outOfAlphabet).toBe(0);
  });

  it('can be rebuilt twice without consuming its contents', () => {
    const r = new RunRecorder();
    r.recordDown('a', 0, 'ok', 5);
    expect(r.buildEvents()).toEqual(r.buildEvents());
  });
});

describe('RunRecorder — rounding', () => {
  // Times are rounded on the way OUT, not on the way in, so the run itself keeps full precision and
  // only the written log is trimmed. These factors set how much resolution the analyzer ever sees.
  it('rounds event times to the microsecond', () => {
    const r = new RunRecorder();
    r.recordDown('a', 0, 'ok', 123.456789);
    expect(r.buildEvents()[0][0]).toBe(123.457);
  });

  it('rounds latency samples: t to the microsecond, the paint delay to 0.01 ms', () => {
    const r = new RunRecorder();
    r.recordLatency(10.987654, 8.123456);
    expect(r.buildLatency()).toEqual([{ t: 10.988, downToPaintMs: 8.12 }]);
  });

  it('rounds pointer samples to 0.1, which is finer than a pixel', () => {
    const r = new RunRecorder();
    r.recordPointer(16.666, 100.44, 250.55);
    expect(r.buildPointerPath()).toEqual([[16.7, 100.4, 250.6]]);
  });

  it('does not round a whole number into a different one', () => {
    const r = new RunRecorder();
    r.recordDown('a', 0, 'ok', 400);
    r.recordPointer(0, 0, 0);
    expect(r.buildEvents()[0][0]).toBe(400);
    expect(r.buildPointerPath()[0]).toEqual([0, 0, 0]);
  });
});

describe('RunRecorder — caps', () => {
  // The caps exist so no allocation happens mid-run. A real 60 s run records ~250 events and ~3600
  // pointer samples, so these ceilings are never approached — but if one ever is, dropping the tail
  // is the only acceptable failure. Throwing would end a run the player is in the middle of, and
  // growing the array would allocate on the hot path, which is the thing the design forbids.
  it('drops events past the cap instead of throwing or reallocating', () => {
    const r = new RunRecorder();
    for (let i = 0; i < CAP + 50; i++) r.recordDown('a', i, 'ok', i);
    const out = r.buildEvents();
    expect(out).toHaveLength(CAP);
    expect(out[0][3]).toBe(0); // the head is kept...
    expect(out[CAP - 1][3]).toBe(CAP - 1); // ...and the tail is what is lost
  });

  it('drops latency samples past the cap', () => {
    const r = new RunRecorder();
    for (let i = 0; i < CAP + 10; i++) r.recordLatency(i, 1);
    expect(r.buildLatency()).toHaveLength(CAP);
  });

  it('drops pointer samples past their own, larger cap', () => {
    const r = new RunRecorder();
    for (let i = 0; i < PCAP + 10; i++) r.recordPointer(i, 0, 0);
    expect(r.buildPointerPath()).toHaveLength(PCAP);
  });

  it('holds more than a full 60 s run needs, in both columns', () => {
    // ~250 selections and 60 fps × 60 s of pointer samples, with headroom.
    expect(CAP).toBeGreaterThan(250 * 2);
    expect(PCAP).toBeGreaterThan(60 * 60);
  });
});

describe('RunRecorder — out-of-alphabet counter', () => {
  it('is a plain tally the caller owns, not derived from the event stream', () => {
    const r = new RunRecorder();
    r.outOfAlphabet++;
    r.outOfAlphabet++;
    expect(r.outOfAlphabet).toBe(2);
    expect(r.buildEvents()).toEqual([]); // and it records no events
  });
});

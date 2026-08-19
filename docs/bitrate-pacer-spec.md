# Spec: Adaptive auditory pacer

An optional click track that runs slightly ahead of the player's measured keystroke rate, to break
the plateau that self-paced tasks produce. A self-paced strip lets a player settle into a
comfortable rhythm well below their capacity; an external pacer gives them something to push
against.

**Rationale for audition rather than a visual pacer:** auditory temporal resolution is far finer
than visual, and sensorimotor synchronization to an auditory beat is substantially more accurate
than to a visual one (Repp's tapping review is the standard survey). This is the one job audition
does better than vision in this application — it is not being asked to carry symbol identity, only
timing.

---

## 1. The non-negotiable: the pacer never gates

The strip stays advance-on-correct. The click is a suggestion. The player may fall behind it, run
ahead of it, or ignore it entirely, with zero consequence for scoring or for target advancement.

The moment the metronome can withhold or delay a target, the task stops being self-paced and
throughput is capped at the tempo. If any code path makes target advancement conditional on beat
timing, the feature is wrong and should be reverted.

Corollary: the pacer produces no per-keystroke sound. A click on keypress is *feedback*, not pacing,
and walks back into the monitoring-disruption problem the error-feedback work was addressing.

---

## 2. Tempo control

Two modes. Ship both; default to (a).

### (a) Proportional — the default

Target tempo = measured keystroke rate over a rolling window × `(1 + push)`, with `push` default
`0.10`.

- Window: trailing 10 seconds of *correct* keystrokes. Ignore errors in the rate estimate — you're
  pacing selections, not presses.
- Recompute every 2 s; move the tempo toward the target by no more than 5% per update so it glides
  rather than jumps.
- Floor at 0.5 Hz, ceiling at 12 Hz. Below the floor the click is not a rhythm; above the ceiling it
  is not achievable.
- Expose `push` in config as a percentage (5%, 10%, 15%, 20%).

Percentage, not "+1 bit/s". A metronome ticks in Hz, and converting bits to Hz requires
`r = B / (log2(N−1)·(2p−1))`, which assumes accuracy holds at the new tempo — the exact thing that
breaks when you speed someone up. A fixed absolute bit increment is also a variable tempo increment:
+1 bit/s is +20% at B=5 and +8% at B=12, and smaller again at larger N. Percentage-of-measured-rate
is scale-free and needs no assumptions.

### (b) Hill-climbing — behind a config toggle

Gradient ascent on the thing actually being scored.

- Every 10 s, compute B over that window; compare against the previous window.
- Improved → continue moving tempo the same direction by `step`.
- Worsened on **two consecutive** windows → reverse direction and halve `step` (floor at 1%).
- `step` starts at 4%. Clamp cumulative tempo movement to ±15% per minute.

The two-window requirement and the movement clamp exist because a 10 s window is roughly 25
keystrokes — noisy enough that a single-window rule will chase sampling noise and oscillate.

This mode is for *finding* the speed-accuracy optimum, which is a different job from breaking a
plateau. Most sessions want (a).

---

## 3. Audio implementation

**Schedule against `AudioContext.currentTime`, never `setInterval` alone.** JS timers drift by tens
of milliseconds under load, which is disqualifying for something whose entire value is temporal
precision.

Standard lookahead scheduler:

- A `setInterval` at ~25 ms wakes the scheduler.
- On each wake, schedule every click falling in the next ~100 ms window with
  `osc.start(preciseTime)` / `osc.stop(preciseTime + duration)`.
- Maintain `nextClickTime` as a float in AudioContext time; advance it by `1/tempo` after scheduling
  each click. Tempo changes take effect at the next scheduled click, never retroactively.

Click design: a short sine or triangle burst, ~1 kHz, 8–12 ms, with a 2 ms attack and ~6 ms
exponential decay to avoid a click-on-the-click artifact. Gain configurable, default low — the pacer
should sit under the player's attention, not in it.

`AudioContext` must be created on a user gesture (the Start button) or browsers will suspend it.
If `state === 'suspended'` at run start, call `resume()` and proceed; if it fails, disable the pacer
silently and note it in the run log rather than blocking the run.

Prefer a single reused `GainNode` with per-click `OscillatorNode`s (oscillators are single-use).
Do not allocate any audio nodes inside the keydown handler.

---

## 4. Logging — the part that makes this measurable

Extend the run log (`schemaVersion: 3`):

```jsonc
"pacer": {
  "enabled": true,
  "mode": "proportional",              // "proportional" | "hillclimb" | "fixed"
  "push": 0.10,
  "startTempoHz": 2.1,
  "endTempoHz": 2.6,
  "clickTimes": [412.0, 888.2, 1364.4, ...],   // performance.now(), same clock as events
  "tempoChanges": [ {"t": 10004.1, "hz": 2.24}, ... ]
}
```

`clickTimes` must be on the **same clock as `events`**. Capture the `performance.now()` /
`AudioContext.currentTime` offset once at run start and convert, so phase analysis is possible
without guessing.

### Analyses to add to `analyze.mjs`

1. **Phase distribution.** For each correct keystroke, compute phase relative to the enclosing beat
   interval, normalized to [0,1). Plot the histogram. Tight clustering means the player is
   entraining; a flat distribution means the click is wallpaper and the feature is doing nothing.
2. **Negative mean asynchrony.** Mean signed offset from the nearest beat. The classic
   synchronization signature is tapping slightly *ahead* of the beat, on the order of 20–50 ms. If
   it shows up, entrainment is real rather than assumed.
3. **Carryover.** Median IKI on unpaced runs that follow a paced session, versus unpaced runs that
   don't. This is the question that decides whether the pacer is a training tool or a toy, and it is
   answerable entirely from logs already being collected.

---

## 5. Configuration and defaults

- Config screen: `Pacer` — Off (default) / Proportional / Hill-climbing; `Push` percentage; `Volume`.
- **Practice mode only by default.** The pacer is a training device; the scored run should measure
  what the player does unaided.
- Allow it in scored runs as an explicit opt-in, since a grader who drifts slow may genuinely
  benefit from being pulled — but never silently, and record `pacer.enabled` in the log so paced and
  unpaced runs are never compared as though they were the same condition.
- Off is the default everywhere. This is an experiment, not a shipped mechanic, until the carryover
  analysis says otherwise.

---

## 6. Tests

- Scheduler correctness: with a mocked AudioContext clock, assert clicks are scheduled at
  `1/tempo` intervals and that a mid-run tempo change affects only subsequent clicks.
- Tempo controller: feed synthetic rate series to the proportional controller and assert the output
  tracks `rate × (1+push)` within the per-update movement clamp.
- Hill-climber: feed a synthetic B series with a known maximum and assert the tempo converges toward
  it rather than oscillating.
- **Isolation test: assert that no pacer code path can affect `Sc`, `Si`, or target advancement.**
  Run the scoring reducer over a fixed keystroke log twice, pacer on and off, and assert identical
  output. This is the test that keeps §1 true as the code changes.

---

## 7. Build order

1. Fixed-tempo click with the lookahead scheduler and a manual Hz slider. Verify timing stability
   under load before anything adaptive exists.
2. Proportional controller.
3. Logging: `clickTimes`, `tempoChanges`, clock alignment.
4. Phase and asynchrony analyses in `analyze.mjs`.
5. Hill-climbing mode.
6. Carryover analysis.

Steps 1–4 answer the question. Step 5 is optional and should not be built until the phase histogram
shows the player is entraining at all.

---

## Implementation notes (as built)

- `src/pacer.ts` — the pure tempo controller (`PacerController`, proportional + hill-climb) and the
  pure `scheduleClicks` lookahead helper. No audio, no DOM, so §1 is structural: this module can
  only read rate/B and emit a tempo. The controller never sees `Sc`/`Si`/advancement.
- `src/audio.ts` — `startPacer`/`setPacerTempo`/`stopPacer` wrap `scheduleClicks` in a 25 ms
  `setInterval`, schedule ~1 kHz triangle clicks against `AudioContext.currentTime`, and capture
  each click's time (converted to the `performance.now()` clock via a once-captured offset).
- `src/app.ts` — creates the controller only when the pacer is active for the run (practice always;
  scored only with the opt-in), feeds it correct/incorrect selection times, retunes the click track
  from the render loop, and shifts click times to the run-relative clock for the log.
- Hill-climb note: a window where the ±15%/min movement clamp holds the tempo flat carries no
  gradient, so it is not counted toward the two-consecutive-worse reversal — otherwise the clamp
  itself would trigger a spurious reversal.

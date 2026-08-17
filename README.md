# Bit-Rate Maximizer

A browser game that measures how many **bits per second** you can push through a pointing device.
One cell of a grid is highlighted; you click it; the next one highlights immediately.

**Play: [aubrika.github.io/brm](https://aubrika.github.io/brm/)**

```
B = log2(N - 1) · max(Sc - Si, 0) / t      bits per second
```

`N` = number of cells · `Sc` = correct clicks · `Si` = wrong clicks · `t` = 60 s.

Errors subtract, so accuracy is worth about twice raw speed. A 32×32 grid pays ~10 bits per
correct click; a 128×128 grid pays 14, but the targets are four times smaller.

## Why a grid

In a 2-D grid, target width shrinks as `1/√N`, so the Fitts index of difficulty grows as only
`½·log2(N)` while the bits earned grow as `log2(N)`. The asymptotic ceiling is therefore about
**2× the pointing device's Fitts throughput** — where a one-dimensional or center-out layout caps
at 1×. That factor of two is the whole reason this design exists, and it shows up in practice:
measured runs land around 12–13 bits/s against a measured pointing throughput of ~6.

For contrast, the original keyboard version tops out near 6 bits/s — see [v1](#v1-legacy) below.

## Calibrate, then run

The scored run is gated behind a ~15 second calibration, which doubles as warm-up:

1. **Calibrate** — 20 clicks on a fixed 24×24 grid.
2. It measures your **endpoint scatter σ** (how far your clicks land from the cell centre) and
   sizes the grid so its cells contain that scatter: `g = fieldPx / (4.133·σ)`, with a 0.85
   cold-start factor, snapped **down** to one of {12, 16, 24, 32, 48, 64}.
3. You can override the suggested size; both the recommendation and your choice are logged.

Rounding down everywhere is deliberate: `B(g)` is a plateau ending in a cliff. One step too coarse
costs a few percent; one step too fine falls off the accuracy cliff at double cost per error.

**Known limits of the calibration.** σ from ~14 surviving endpoints has roughly 20 % standard
error, and the snap ladder steps by ~1.33×, so repeat calibrations of the same hand land one step
apart about a third of the time. Treat the recommendation as a neighbourhood, not a precise fit.
The per-player Fitts profile (slope, intercept, throughput) is logged but **not shown** — at 20
clicks across a narrow difficulty range its R² is ~0.05, which is noise, not a measurement.

## Run it locally

```
npm install
npm run dev          # v2, the grid game
npm run dev:v1       # v1, the legacy keyboard game
npm test
npm run build        # builds v2 to dist/ and v1 to dist/v1/
```

No Node? A prebuilt `dist/` is committed — serve it with anything static.

Runs played under `npm run dev` / `preview` save automatically to `logs/`. On the deployed static
site there is no backend, so the report screen offers a **Download run log** button instead.

## Runs and analysis

Every run writes one JSON file that is the complete record: the generated sequence, every click
with its verdict and timestamp, the pointer path, the calibration, and the build that produced it.
`B` is independently recomputable from it — nothing on screen is unverifiable.

```
node scripts/analyze.mjs [--scored-only] [--machine NAME] [--logs DIR]
```

Section `[11]` covers grid mode: Fitts throughput, verify-dwell, and a mouse-vs-trackpad split.
Section `[12]` is the ghost A/B (below). See `logs/README.md` for the log format.

## Experiment: is the lookahead ghost worth anything?

Grid mode has always outlined the **next** target in grey and drawn a connector to it, on the
assumption that letting you plan the next movement while finishing this one would pay. That was
never measured, so there is a harness for it: tick **A/B the lookahead ghost** on the config
screen and the game assigns each scored run an arm — half with the ghost, half without.

Arms come in **randomised pairs**: every pair holds one ghost-on run and one ghost-off run, in a
random order. A player's bit rate drifts across a session by more than the ghost could plausibly
be worth, so the comparison is made *within* a pair, where that drift cancels. Free coin-flipping
would not do — across the handful of pairs anyone will actually sit through, a streak long enough
to swamp the effect is common. The arm, its pair index and its position are written into each log,
so pairing at analysis time is exact rather than inferred from timestamps.

The analyzer reports the paired difference with a 95 % CI and an exact t p-value, plus two guards
against reading too much into it:

- **Its own resolution.** With the scatter the pairs actually showed, the smallest difference
  those pairs could detect at 80 % power. A null result means "smaller than that", never "zero".
- **A mechanism check.** Error rate is split by whether the *next* target happened to fall near
  or far. In the ghost-off arm, where the next target is invisible, that gap must vanish — if it
  does not, something other than the ghost is driving the numbers.

Roughly 8–12 pairs (16–24 minutes of play) puts the resolution near a few percent of the ~13 bits/s
baseline.

## Structure

```
src/
  app.ts            screen flow (config → calibrate → run → report)
  main.ts           entry point
  core/             the maths — no DOM, no I/O, no game
    bitrate.ts        THE score: B = log2(N-1)·max(Sc-Si,0)/t, and nothing else
    sequence.ts       the uniform RNG and the i.i.d. target samplers
    alphabet.ts       keyboard alphabet / symbol helpers (v1-facing)
    stats.js|.d.ts    shared run statistics — used by the report screen AND the analyzer
    config.ts         GameConfig + persistence
    ab.ts             the A/B harness: randomised blocks of two, persisted across runs
  io/               everything that crosses a boundary
    logging.ts        the hot-path run recorder, and POSTing a finished log
    report.ts         assembles the one JSON artifact a run produces
    machine.ts        one-time machine/display probe
  ui/               presentation shared by both versions
    reportview.ts     the post-run report screen
    audio.ts          Web Audio feedback
    latency.ts        the debug latency overlay
  v2/               THE GAME — grid pointing
    engine.ts         run state and the click handler. No DOM
    view.ts           canvas renderer + the hit-test geometry
    calibration.ts    the σ pipeline and grid-size recommendation. Pure
    scope.ts          pointer-lock magnifier experiment
  v1/               legacy keyboard game (frozen)
    engine.ts         run state and the keydown handler
    view.ts           the falling-lanes renderer
    reduce.ts         authoritative fold of a keydown log back into a score
scripts/analyze.mjs offline cross-run analysis
```

Tests sit beside the code they cover (`src/v2/view.test.ts`, `src/core/core.test.ts`, …).

TypeScript strict. No runtime dependencies.

## v1 (legacy)

**[aubrika.github.io/brm/v1](https://aubrika.github.io/brm/v1/)**

The original version: a falling-lanes typing game on the two home rows (`asdfjkl;`, N = 8), one
lane per finger. It is kept, frozen, only to show where the design started and why it moved to a
grid — the keyboard's alphabet is small and its cross-hand transitions are expensive, which caps
throughput around 6 bits/s no matter how fast you type.

It is not maintained. Everything else in this repo — tests, comments, analysis, documentation —
targets v2. `README_V1.md` describes the keyboard game and its experiments as they stood, including
several that were measured and retired (an auditory pacer, redundant target tones, a fixed-rate
"challenge" scroll).

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
node scripts/analyze.mjs
```

Section `[11]` covers grid mode: Fitts throughput, verify-dwell, the ghost A/B and a
mouse-vs-trackpad split. See `logs/README.md` for the log format.

## Structure

- `src/gridengine.ts` — grid run state and the click handler. No DOM.
- `src/gridview.ts` — the canvas renderer and the hit-test geometry.
- `src/calibration.ts` — the σ pipeline and grid-size recommendation. Pure.
- `src/scoring.ts` — the scoring math and sequence generation. No DOM.
- `src/stats.js` — shared run statistics, used by the report screen *and* the analyzer.
- `src/reportview.ts` — the post-run report screen.
- `src/app.ts` — screen flow (config → calibrate → run → report).
- `scripts/analyze.mjs` — offline cross-run analysis.

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

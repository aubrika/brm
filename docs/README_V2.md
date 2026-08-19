# Bit-Rate Maximizer

A browser game that measures how many **bits per second** you can push through a pointing device.
One cell of a grid is highlighted; you click it; the next one highlights immediately.

**Play: [aubrika.github.io/brm](https://aubrika.github.io/brm/)**

```math
B \;=\; \frac{\log_2\!\left(\textcolor{#5a8ad0}{N} - 1\right)\,\cdot\,\max\!\left(\textcolor{#b77e00}{S_c} - \textcolor{#eb5460}{S_i},\; 0\right)}{\textcolor{#838899}{t}}
```

| | term | meaning | in the game |
|---|---|---|---|
| `#6ea8fe` | $\textcolor{#5a8ad0}{N}$ | number of cells | the grid you are aiming at |
| `#E69F00` | $\textcolor{#b77e00}{S_c}$ | correct clicks | the orange target, and the burst when you hit it |
| `#ff5b68` | $\textcolor{#eb5460}{S_i}$ | wrong clicks | the red flash on a miss |
| `#8b91a3` | $\textcolor{#838899}{t}$ | 60 s | the clock |

<sub>The chips are the game's actual colours; the symbols are darkened versions of them, because
MathJax takes one fixed colour and GitHub renders this file on both a white and a near-black page.
Each symbol colour clears 3.5:1 contrast on both. Colours are reused for these four quantities
everywhere below.</sub>

Errors subtract, so accuracy is worth about twice raw speed. A 32×32 grid pays ~10 bits per
correct click; a 128×128 grid pays 14, but the targets are four times smaller.

## Why a grid

In a 2-D grid, target width shrinks as $1/\sqrt{\textcolor{#5a8ad0}{N}}$, so the Fitts index of difficulty grows as only
$\tfrac{1}{2}\log_2 \textcolor{#5a8ad0}{N}$ while the bits earned grow as $\log_2 \textcolor{#5a8ad0}{N}$. The asymptotic ceiling is therefore about
**2× the pointing device's Fitts throughput** — where a one-dimensional or center-out layout caps
at 1×. That factor of two is the whole reason this design exists, and it shows up in practice:
measured runs land around 12–13 bits/s against a measured pointing throughput of ~6.

For contrast, the original keyboard version tops out near 6 bits/s — see [v1](#v1-legacy) below.

## Calibrate, then run

The scored run is gated behind a ~15 second calibration, which doubles as warm-up:

1. **Calibrate** — 20 clicks on a fixed 24×24 grid.
2. It measures your **endpoint scatter σ** (how far your clicks land from the cell centre) and
   sizes the grid so its cells contain that scatter: $g = \mathit{field}_{px} / (4.133\,\sigma)$, with a 0.85
   cold-start factor, snapped **down** to one of {12, 16, 24, 32, 48, 64}.
3. You can override the suggested size; both the recommendation and your choice are logged.

Rounding down everywhere was deliberate, on the assumption that `B(g)` is a plateau ending in an
accuracy cliff: one step too coarse costs a few percent, one step too fine falls off the cliff at
double cost per error. The plateau is real. The accuracy cliff is not — error rate turns out to be
almost independent of grid size, and what a finer grid costs is time. See
[what a finer grid actually costs](#what-a-finer-grid-actually-costs).

**Known limits of the calibration.** σ from ~14 surviving endpoints has roughly 20 % standard
error, and the snap ladder steps by ~1.33×, so repeat calibrations of the same hand land one step
apart about a third of the time. Treat the recommendation as a neighbourhood, not a precise fit —
and see [what it actually measures](#calibration-what-it-actually-measures), which is a stronger
caveat than this one.
The per-player Fitts profile (slope, intercept, throughput) is logged but **not shown** — at 20
clicks across a narrow difficulty range its R² is ~0.05, which is noise, not a measurement.

## Calibration: what it actually measures

The scored run is gated behind a ~15 second calibration whose job is to pick a grid size. The
algorithm is written out step by step at the top of `src/v2/calibration.ts`; the short version is
that it measures endpoint scatter $\sigma$, converts it to an ISO 9241 effective width
$W_e = 4.133\,\sigma$, and solves $g = \mathit{field}_{px} / W_e$ for the grid whose cells are one
effective width across.

**That solve is degenerate, and the run logs show why.** Reconstructing endpoint scatter from the
scored-run pointer paths — every click, hit and miss, measured against the cell it aimed at
(`node scripts/analyze.mjs`, section `[13]`):

| grid | cell | runs | bits/s | err | cycle | σ | σ/cell |
|---|---|---|---|---|---|---|---|
| 8² | 222 px | 1 | 9.066 | 6.67 % | 601 ms | 54.5 px | 0.245 |
| 12² | 148 px | 1 | 11.217 | 6.48 % | 591 ms | 36.9 px | 0.249 |
| 16² | 110 px | 38 | 11.795 | 4.74 % | 655 ms | 24.9 px | 0.225 |
| 24² | 74 px | 6 | 13.369 | 5.88 % | 644 ms | 17.2 px | 0.233 |
| 32² | 55 px | 6 | 12.998 | 2.82 % | 749 ms | 11.7 px | 0.213 |
| 64² | 27 px | 2 | 12.400 | 3.73 % | 937 ms | 5.7 px | 0.210 |

```math
\log \sigma \;=\; -1.85 \;+\; 1.084\,\log w
\qquad\qquad R^2 = 0.998
```

<sub>$w$ = cell width in px. Six grid sizes, an 8× range of cell size.</sub>

**Scatter is a fixed fraction of the target, not a fixed property of the hand.** σ ≈ 0.23·cellPx
whether the cell is 222 px or 27 px. The calibration's model is the slope-0 case — σ fixed, cellPx
free — and the measured slope is 1.08.

Substituting the real relationship into the solve collapses it:

```math
g_\text{raw} \;=\; \frac{\mathit{field}_{px}}{4.133 \cdot 0.23 \cdot \mathit{field}_{px}/g}\cdot 0.85 \;=\; 0.9\,g
```

The procedure is a **mirror**: it hands back the grid it was calibrated on, times a constant. Since
that is always `REFERENCE_GRID = 24`, the recommendation is pinned near 22 — which snaps down to
16. Everything that moves it off 16 is noise in the σ estimate, and there is plenty: six
calibrations of the same hand on the same machine gave `g_raw` from 14.4 to 27.4 and recommended
12, 16, 16, 16, 16 and 24.

**Why it has not been replaced.** Its output barely matters — see the exchange rate below. The
calibration lands in the right neighbourhood by accident of its reference grid, and every value in
that neighbourhood scores about the same. It also still earns its keep as a warm-up and as the
record of the machine's geometry.

### What a finer grid actually costs

`B` factors exactly into three terms, and measuring each separately says where the trade really is:

```math
B \;=\; \underbrace{\log_2\!\left(\textcolor{#5a8ad0}{N}-1\right)}_{\text{bits per selection}}
   \;\times\; \underbrace{\frac{1000}{c}}_{\text{selections per second}}
   \;\times\; \underbrace{\frac{1-2\textcolor{#eb5460}{e}}{1-\textcolor{#eb5460}{e}}}_{\text{error penalty}}
```

<sub>$c$ = cycle time in ms per completed selection; $\textcolor{#eb5460}{e}$ = error rate.</sub>

| grid | bits/sel | cycle | rate/s | err | penalty | B |
|---|---|---|---|---|---|---|
| 8² | 5.98 | 601 ms | 1.665 | 6.67 % | 0.929 | 9.07 |
| 12² | 7.16 | 591 ms | 1.691 | 6.48 % | 0.931 | 11.22 |
| 16² | 7.99 | 655 ms | 1.526 | 4.74 % | 0.950 | 11.80 |
| 24² | 9.17 | 644 ms | 1.552 | 5.88 % | 0.938 | 13.37 ᵈ |
| 32² | 10.00 | 749 ms | 1.335 | 2.82 % | 0.971 | 13.00 |
| 64² | 12.00 | 937 ms | 1.068 | 3.73 % | 0.961 | 12.40 |

<sub>ᵈ 24² runs are lookahead depth 2; every other row is depth 1. Plain grid mode only — every run
above 64² in `logs/` is a SCOPE run and belongs to a different input modality.</sub>

**Error rate is not the currency.** The penalty term sits between 0.93 and 0.97 across the whole
range with no trend in grid size — it moves the score by at most a few percent and just as often
in the helpful direction. What you actually pay for resolution is **time**: per doubling of cells
per side you gain 13–31 % in bits per selection and lose 22–45 % of your selection rate.

Cycle time obeys Fitts cleanly across the entire measured range:

```math
c \;=\; 207 + 112\log_2 g \;\text{ms}
\qquad\qquad
\mathit{TP} \;=\; \frac{1000}{112} \;=\; 8.9\ \text{bits/s}
```

and since bits per selection grows as $2\log_2 g$ while cycle grows as $112\log_2 g$, the ceiling is

```math
\lim_{g\to\infty} B \;=\; \frac{2000}{112} \;=\; 17.9\ \text{bits/s} \;=\; 2\,\mathit{TP}
```

— **exactly twice the measured Fitts throughput**, which is the claim
[the whole design rests on](#why-a-grid), recovered from play data rather than assumed.

**But you approach that ceiling absurdly slowly.** If Fitts held forever: 32² → 13.0, 64² → 13.7,
128² → 14.1, 256² → 14.5. Each doubling past 32² buys under 5 %, and reaching even 80 % of the
asymptote would need a 168×168 grid. That is why the plateau is broad and why the calibration's
precision does not matter: anywhere from 16² to 64² is within ~10 % of the best available score.

**Where is the cliff?** Not established. Fitts still fits at 64² (the largest plain grid ever
played, n = 2 runs) with no departure — observed cycle is within 11 % of the fitted line at every
size from 8² to 64². The scored decline from 32² to 64² is −5 % on two runs, which is nothing. The
one hint of a cliff comes from SCOPE runs at 128²/256², a different modality, so it does not
transfer. **The cheap next experiment is two or three plain-grid runs at 128²** (13.7 px cells),
where extrapolating σ ≈ 0.23·cellPx down to the device's noise floor suggests the proportional
scatter law should finally break.

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
site there is no backend, so the report screen offers a **Download run log** button instead —
download them and point the analyzer at wherever they land with `--logs DIR`.

**Playing on more than one display?** Name each one in the **This machine** field on the config
screen. Screen size, window size and device pixel ratio are recorded automatically. This matters
more than it sounds: cell size in px descends from the window, so the same `16²` setting is a
110 px target on a 1750 px field and a 44 px target on a 700 px one. The analyzer groups on that
name (falling back to the random `installId`) and never pools two displays — sections `[12]` and
`[13]` would otherwise fit straight through two different experiments.

## Runs and analysis

Every run writes one JSON file that is the complete record: the generated sequence, every click
with its verdict and timestamp, the pointer path, the calibration, and the build that produced it.
`B` is independently recomputable from it — nothing on screen is unverifiable.

```
node scripts/analyze.mjs [--scored-only] [--machine NAME] [--logs DIR]
```

Section `[11]` covers grid mode: Fitts throughput, verify-dwell, and a mouse-vs-trackpad split.
Section `[12]` is the ghost A/B, and `[13]` the grid-size sweep and the scatter law the calibration
depends on (both below). See `logs/README.md` for the log format.

## Experiment: is the lookahead ghost worth anything?

Grid mode has always outlined the **next** target in grey and drawn a connector to it, on the
assumption that letting you plan the next movement while finishing this one would pay. That was
never measured, so there is a harness for it: tick **A/B the lookahead ghost** on the config
screen and the game assigns each scored run an arm — half with the ghost, half without.

### Result: it is worth about a quarter of the score

**13 paired runs, 16×16 grid, one player, one session** (`node scripts/analyze.mjs`, section `[12]`):

|  | ghost on | ghost off | Δ (on − off) | 95 % CI | p |
|---|---|---|---|---|---|
| **bits/s** | 12.504 | 10.044 | **+2.460** | [2.03, 2.89] | 3 × 10⁻⁸ |
| cycle time | 610 ms | 763 ms | **−153 ms** | [−169, −136] | 1 × 10⁻¹⁰ |
| error rate | 4.60 % | 4.69 % | −0.09 % | [−1.9, +1.7] | 0.92 |

The ghost is worth **+2.46 bits/s — roughly a quarter of the no-ghost score**, and four times the
0.60 bits/s these 13 pairs could resolve. Every one of the 13 pairs came out positive, so a sign
test — which assumes nothing at all about the distribution — gives p = 2.4 × 10⁻⁴ on its own. The
parametric and assumption-free tests agree.

**The whole gain is speed.** 153 ms saved per selection with error rate flat to within a tenth of
a percent: not a speed/accuracy trade laundered into the score, just less time per selection. Mean
index of difficulty matched across arms (3.082 vs 3.102, p = 0.51), so the ghost arm was not handed
easier targets. 153 ms is about one visual-search-plus-motor-planning cycle, which is what a
preview should remove — without it you pay that latency serially on every single selection.
Fitting Fitts per arm puts the difference in the intercept (669 ms off vs 376 ms on) rather than
the slope, i.e. a fixed overhead rather than a distance cost; but R² is 0.02 and 0.12, so those
fits are too weak to lean on. The 153 ms needs no fit.

**What this does not license.** One player, one session, one device — n = 1 organism. Only at
16×16: a roughly fixed ~150 ms saving is a larger *fraction* of a short cycle than a long one, so
the gain is probably smaller at 32×32 (partly offset by each selection being worth 10 bits instead
of 8) — untested. And `ghost` gates both the grey outline and the connector line, so this measures
the whole lookahead package, not the outline alone.

Two checks that came back clean: the effect does not drift across the session (+0.05 bits/s per
pair, flat), and the pairs alternate which arm leads, so it is neither warm-up nor order. The
mechanism check's one odd-looking number — ghost-off showing 2.86 % errors when the next target
was near vs 4.84 % far, where there should be no gap at all — is 2 errors out of 70 clicks.

### Depth 2: real, and about a sixth as valuable

**Lookahead** is a config value (0, 1 or 2). Depth 2 adds T+2 behind T+1, drawn dimmer, so the
preview reads as an ordered chain rather than two equal targets.

7 depth-2 runs at 16×16 against the 18 depth-1 runs at the same size:

|  | depth 2 (n = 7) | depth 1 (n = 18) | Δ | 95 % CI | p |
|---|---|---|---|---|---|
| bits/s | 13.038 ± 0.53 | 12.576 ± 0.55 | +0.462 | [−0.06, 0.99] | 0.078 |
| **cycle time** | 584 ± 19 ms | 605 ± 21 ms | **−21 ms** | [−40, −1.6] | 0.036 |
| accuracy | 95.6 % | 95.1 % | +0.5 % | [−1.3, +2.3] | 0.56 |

Against only the same-night depth-1 runs (36 minutes earlier, same sitting): +0.534 bits/s
(p = 0.052) and −26 ms (p = 0.013).

**The first preview bought −153 ms; the second buys −21 to −26 ms — about one sixth as much.**
That is what you would expect if T+2 is mostly too far ahead to plan against and half-stale by the
time you arrive. Cycle time clears significance and bits/s does not because cycle time is the
lower-variance measure (sd 3 % of its mean, vs 4.4 % for bits/s, which also absorbs error-rate
noise); this comparison resolves 0.73 bits/s at 80 % power and observed 0.46, so the bits/s result
is under-powered rather than null. Accuracy is flat, so again the gain is clean time.

**Weaker evidence than the depth-1 result, in three ways.** It is unpaired and across sessions,
though the same-night subset mitigates that. The depth-2 block trends −0.086 bits/s per run
(end-of-session fatigue), which biases *against* depth 2 — so +0.46 is the conservative estimate.
And the depth-2 build also *brightened* T+1 (`#6B7789` at 1.5 px → `#AEBACE` at 2 px), so what was
measured is "depth 2 with a bright T+1" versus "depth 1 with a dim T+1"; some unknown share of the
21 ms could be the brighter outline. There are no depth-1 runs on the current build, so the
brightness question cannot be settled from the existing data — it was judged too small to be worth
the runs. Section `[11]`'s per-depth breakdown is labelled config groups, not randomised arms, for
the same reason: only `[12]` licenses a causal claim.

The ghost stays on by default at depth 1.

### How the harness works

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
baseline — the run above reached 0.60 bits/s at 13 pairs.

The power calculation uses `(t₀.₉₇₅ + t₀.₈₀)·se`, not the textbook `(z₀.₉₇₅ + z₀.₈₀) = 2.802·se`.
At these sample sizes the normal form is badly optimistic: a Monte-Carlo of the function itself put
its true power at 8 pairs at 67 %, not the 80 % it claimed. `scripts/stats.test.mjs` pins the t
machinery to the published table and the pairing rules to hand-built logs — a wrong p-value is the
one number in this project that would look right while being wrong.

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
    calibration.ts    the grid-size algorithm, written out step by step. Pure, no DOM
    calibration-task.ts  the calibration screen + click capture that feeds it
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

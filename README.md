# Bit-Rate Maximizer

A browser typing game that maximizes a human player's **achieved bit rate** over a
60-second scored run, per the Shenoy et al. (2021) formula:

```
B = log2(N - 1) · max(Sc - Si, 0) / t      bits per second
```

`N` = alphabet size, `Sc` = correct selections, `Si` = incorrect selections, `t` =
elapsed seconds. Errors **subtract**, so at per-keystroke accuracy `p` the net
throughput scales as `(2p − 1)`: 95% accuracy keeps 90% of your bits, 90% keeps 80%.
**Accuracy is worth roughly twice what raw speed is worth**, and every design choice
below follows from that.

## Run it

```
./run.sh
```

Requires Node 18+ (it runs `npm ci`, `npm run build`, `npm run preview -- --open`).

**No Node?** A prebuilt `dist/` is committed. Serve it with anything static:

```
cd dist && python3 -m http.server 8000    # then open http://localhost:8000/
```

Play: **Practice** to warm up (untimed, `Esc` to exit), or **Start scored run** for the
60 s evaluation. Space/typing goes to the target under the magnifier.

- `?debug` — overlay showing keydown→paint latency and long-frame count.

## Why N = 8

Model the score per keystroke. Over the window, gross keystrokes `= r·t` (rate `r` in
keys/sec), correct `= p·r·t`, incorrect `= (1−p)·r·t`, so net `= (2p−1)·r·t` and

```
B ≈ log2(N − 1) · (2p − 1) · r
```

Three factors, and they trade against each other as `N` changes: `log2(N−1)` rises with
`N`, but both `r` (you can move more fingers per second when each finger owns one key)
and `p` (fewer, better-separated targets are easier to hit) fall as `N` grows. The
product peaks in the middle. Home row without lateral index-finger reaches — `asdfjkl;`
— is exactly one key per finger, which is where `r` peaks, and eight well-separated keys
keep `p` high.

Rough estimates (see the honesty note below):

| N  | alphabet       | r (keys/s) | p     | B ≈ log2(N−1)·(2p−1)·r |
|----|----------------|-----------:|------:|-----------------------:|
| 4  | `dfjk`         | 7.5        | 0.98  | ~11.4                  |
| 6  | `sdfjkl`       | 6.5        | 0.965 | ~14.0                  |
| **8** | **`asdfjkl;`** | **6.0** | **0.96** | **~15.5**           |
| 10 | `asdfghjkl;`   | 5.3        | 0.93  | ~14.4                  |

N = 8 sits at or near the maximum. **Honesty note:** those `r`/`p` numbers are
estimates, not measurements. The game is built to measure the real curve — every run
exports its full keystroke log (below), and the alphabet is a config field, so sweeping
N = 4/6/8/10 and reading the actual `B` off the report is a stronger answer than this
table. Do that before trusting the exact peak.

## Why touch typing (input modality)

Zero hardware, zero learning curve, and **eight independent effectors already trained in
every grader's motor cortex**. This is explicitly a *first-session* evaluation graded on
the mean of three players — a novel input modality (eye tracker, MIDI, gamepad chords)
loses more to first-session unfamiliarity than it can gain in theoretical throughput.
Touch typing starts every grader near their ceiling on keystroke one.

## Why lookahead (the primary speed lever)

The strip shows **7 glyphs ahead of the target** by default (configurable, never below
5). This is the single highest-leverage parameter: it lets a player **pipeline** motor
planning — queue the next several finger movements — instead of reacting to one symbol at
a time. Reaction is serial and slow; pipelining is what turns "read, then move" into a
continuous flow. It's a config option so graders can tune it to their comfort.

## Reading the strip: falling lanes (default) or a chunked row

By default the strip is a **falling-note layout** (think DDR): each key owns a vertical
column ordered left→right by finger — `a` (left pinky) at the far left through `;` (right
pinky) at the far right — so a glyph's column sits directly above the finger that types
it. The **left hand is blue, the right hand yellow**, and **faint lines link each glyph to
the next**, so the upcoming path is easy to trace. Glyphs fall to a type line near the
bottom where a box marks the current target, and **horizontal divider lines every four
rows** chunk the falling stream into runs of four. Reading a *column* is pre-attentive and
the chunk grouping lets the eye pre-read a run as a unit — together they enable pipelining.

Toggle **Falling lanes** off for a single **chunked row** instead (one flat line, letters
grouped in fours with a gap, a fixed centre magnifier). Both keep the letters printed on
every token, so nothing must be learned to start playing.

## Scoring semantics (stated plainly)

Two rules, implemented literally in `src/scoring.ts` and covered by tests:

- **Out-of-alphabet keys are ignored entirely** — not `Sc`, not `Si`, no visual
  response. They are not selections *in the alphabet*, so counting them would be
  incoherent. (Modifier chords with ctrl/meta/alt are likewise ignored, so browser
  shortcuts keep working, and auto-repeat is ignored — but a genuine double-tap of the
  same key, which happens with probability `1/N`, registers normally.)
- **Retry-until-correct.** A wrong *in-alphabet* key increments `Si` and does **not**
  advance the target; you must still hit the correct key. Input is never locked — the
  very next keydown is evaluated immediately. An alternative ("one press per target,
  advance regardless") is equivalent in expectation under this formula, but
  retry-until-correct keeps the visible strip in exact correspondence with progress,
  which makes ground truth obvious to someone watching over your shoulder. That
  legibility is the reason to choose it.

The final `t` is the full 60 s window (the running display uses live elapsed time).

## Configurability is a scoring strategy

The score is the **mean** of three very different players (an information-theory lead
with below-average hand-eye coordination; a 200+ wpm gamer; a balanced player). One
fixed configuration can't be optimal for all three, and the mean is dragged down by the
weakest run. So alphabet and lookahead are exposed at the config screen, and the practice
screen suggests: **making frequent errors → smaller alphabet (`dfjk`, N = 4)**;
**bottlenecked by reading speed → larger (`asdfghjkl;`, N = 10)**. Because accuracy is
worth ~2× speed, the error-prone player gains more by dropping N than the fast player
loses.

## The chunking trap (why single keystrokes)

An obvious move is to amortize the `N−1` penalty by making each *selection* a chunk of
`k` keystrokes — e.g. `k = 2` over 8 keys is `N = 64` symbols, `log2(63)/2 ≈ 2.99` bits
per keystroke vs `log2(7) ≈ 2.81`, a 6.5% gain. It's a trap at realistic accuracy,
because a chunk is correct only if *every* keystroke in it is, so per-keystroke
throughput goes as `log2(N)·(2pᵏ − 1)` vs `log2(N−1)·(2p − 1)`. Setting them equal for
`k = 2, N = 8`:

```
3·(2p² − 1) = 2.807·(2p − 1)   →   p ≈ 0.969
```

Below ~97% per-keystroke accuracy, chunking **loses** (at p = 0.96 it costs ~2%); only
above it does it gain. So this ships single-keystroke selections. If practice runs
reliably show accuracy > 97%, chunking becomes worth a branch — the point is that the
break-even is a calculation, not a guess.

## Latency (the thing most likely to silently cap the score)

The ceiling is how many keystrokes/second the interface accepts, not how fast a human
moves. So:

- Input is handled **synchronously** in one `window` keydown listener (`{ passive:false }`,
  attached once): classify, count, advance the index. State advancement **never** waits
  on an animation, transition, timeout, or frame.
- Rendering is a **separate `requestAnimationFrame` loop** that reads current state and
  draws. If the player outruns 60 fps for a moment, the renderer skips ahead — it never
  queues.
- Motion is **transform + opacity only** (never `left`/`margin`/layout), on a fixed pool
  of pre-created glyph nodes recycled on a treadmill (one `textContent` write per advance).
  The error shake is an absolutely-positioned `translateX` that never reflows the strip.
- `?debug` surfaces measured keydown→paint latency so this is verifiable, not assumed.

`prefers-reduced-motion` replaces the shake with a colour-only flash. Optional audio
(on by default, toggleable) uses `AudioContext` — a ~5 ms click on correct, a low tone on error —
never `<audio>` elements, whose latency is unacceptable.

## Verifiability

Trust nothing — recompute it. The end-of-run report offers a **JSON download** containing
the full generated target sequence *and* every keystroke with timestamps. From that log
you can recompute `B` independently and run your own uniformity test on the sequence. The
on-screen score is itself produced by folding that same log (`reduceLog`), so what you see
is exactly what the export reproduces. The sequence is sampled i.i.d. with replacement via
`crypto.getRandomValues` with rejection sampling (no modulo bias); back-to-back repeats are
**not** filtered (that would break i.i.d.), and `src/scoring.test.ts` asserts a χ²
uniformity test and the `1/N` adjacent-repeat rate.

## Tests

```
npm test        # vitest, 27 cases
```

Covers the scoring math (including `Si > Sc` clamping to 0, `t` boundaries, `N = 3`), RNG
uniformity (χ² for N = 3/8/10 + adjacent-repeat rate + a rejection-boundary case), the
state machine (retry-until-correct, ignored keys, double-tap), and an end-to-end bit rate
from a scripted keystroke log versus a hand-computed value.

## Structure

- `src/scoring.ts` — **pure, DOM-free** core: RNG, sequence generation, the bit-rate
  formula, and `reduceLog` (the authoritative fold). All of it unit-tested.
- `src/engine.ts` — live run state + the synchronous keydown handler.
- `src/strip.ts` — the treadmill renderer: pooled glyph nodes, magnifier fisheye, lanes.
- `src/app.ts` — screen router (config / run / report), 3-2-1 countdown, rAF loop.
- `src/report.ts`, `src/audio.ts`, `src/latency.ts`, `src/config.ts` — report/JSON,
  AudioContext feedback, the debug overlay, config persistence.

TypeScript strict throughout; no runtime dependencies.

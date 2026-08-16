# Bit-Rate Maximizer

A browser typing game. You type falling target keys for 60 seconds. The score is your
achieved **bit rate** — how many bits per second you communicate through the keyboard.

## Score

```
B = log2(N - 1) · max(Sc - Si, 0) / t      bits per second
```

- `N` — number of keys in the alphabet
- `Sc` — correct selections
- `Si` — incorrect selections
- `t` — 60 seconds

Errors subtract. So accuracy matters more than raw speed.

## Run it

```
./run.sh
```

Needs Node 18+ (it builds and opens the game).

No Node? A prebuilt `dist/` is committed. Serve it with anything static:

```
cd dist && python3 -m http.server 8000
```

## Play

On the start screen you set:

- **Your name** — labels this machine's saved runs.
- **Left hand home row** — keys the left hand types (default `asdf`). Edit for other layouts.
- **Right hand home row** — keys the right hand types (default `jkl;`).
- **Left / Right hand top row** — the customizable second row (default `qwer` / `uiop`), used
  only when the **Top row** toggle is on. Each top-row key shares its home-row finger's column,
  so `q` falls in the same lane as `a`, `w` as `s`, and so on.

- **Top row** — off by default (experiment). When on, the top rows join the alphabet, doubling
  it to N = 16; each top-row glyph is marked with a caret.
- **Chords** — off by default (experiment). When on, targets are 1–3 key chords you press
  together and release; all keys of a chord appear on one line, linked and boxed at once.
- **Challenge mode** — off by default (experiment/demo). The piano roll scrolls at a fixed rate
  like a rhythm game; you must hit each target while it's inside the highlighted band or it counts
  as a miss. Advancement is on a clock, not your input, so throughput is capped at the scroll rate.

The default alphabet is the two home rows, `asdfjkl;` (N = 8).

Then pick **Practice** (untimed, `Esc` to quit) or **Start scored run** (60 seconds). There is no
countdown — the clock starts on your first keystroke, when you type the highlighted target.

### Audio experiments (removed)

Two auditory layers were built, A/B-tested, and then removed because the data didn't support them
(the code and their specs, `bitrate-pacer-spec.md` / `bitrate-tones-spec.md`, remain for reference):

- a **pacer** — a metronome tick running ~10% above your measured keystroke rate, as an external
  pace to push against (no entrainment showed up: phase concentration *R* ≈ 0.01);
- **target tones** — a per-lane pitch (ascending major pentatonic, hand coded by timbre + pan),
  redundant with the visual lane.

A 3-arm A/B (**none** / **pacer only** / **tones only**), with each run's condition drawn from a
balanced reshuffled bag so order doesn't confound with the practice curve, gave (one player, n=7 per
arm; `node scripts/analyze.mjs --compare`):

| condition | bits/s      | median IKI  | accuracy      |
|-----------|-------------|-------------|---------------|
| none      | 6.24 ± 0.34 | 403 ± 26 ms | 97.6 ± 0.8 %  |
| pacer     | 6.19 ± 0.27 | 391 ± 18 ms | 95.6 ± 1.4 %  |
| tones     | 6.11 ± 0.32 | 379 ± 31 ms | 94.8 ± 1.5 %  |

**No bit-rate gain from either layer** (differences well within noise, *t* < 1). Both audio layers
made typing slightly *faster* (lower IKI) but *less accurate* — a speed–accuracy trade that cancels
out, since errors subtract double. The accuracy drop was the one effect that cleared noise (none vs.
tones *t* ≈ 4). Since `B` already rewards the operating point a self-paced player naturally picks,
neither added redundancy nor external pacing helped — so both were retired.

Type the highlighted key at the bottom. Left-hand keys are blue, right-hand keys are yellow.
The bar above shows the keys coming next.

## Runs and analysis

Every run is saved locally to `logs/` as a JSON file. Nothing is sent anywhere. Only keys in
the alphabet are recorded — no free text. The folder is gitignored and ships empty.

After a run, the report screen shows the run in detail. To compare runs across time:

```
node scripts/analyze.mjs
```

It reads every log in `logs/` and prints a summary (see `logs/README.md` for the log format).
Add `--compare` to focus on the A/B condition table (median IKI, accuracy, and bits/s per arm).

## Tests

```
npm test
```

## Structure

- `src/scoring.ts` — the scoring math and target-sequence generation. No DOM.
- `src/stats.js` — shared run statistics, used by the report screen and the analyzer.
- `src/engine.ts` — live run state and the keydown handler.
- `src/strip.ts` — the falling-lane renderer.
- `src/reportview.ts` — the post-run report screen.
- `src/app.ts` — screen flow (config → run → report).
- `scripts/analyze.mjs` — offline cross-run analysis.

TypeScript strict. No runtime dependencies.

## Design notes

_TODO: why N and the alphabet, why touch typing, the thumb key, latency, and accuracy._

## Development

_TODO._

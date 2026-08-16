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
- **Challenge mode** — off by default (experiment/demo). The piano roll scrolls like a rhythm
  game; you must hit each target while it's inside the highlighted band or it counts as a miss.
  The scroll rate follows the pacer beat (one target per beat — so as the pacer adapts to your
  rate, the roll speeds up or slows with it), seeded at a fixed rate until the pacer establishes.

The default alphabet is the two home rows, `asdfjkl;` (N = 8).

A **pacer** plays a kickdrum beat to pace against, running 20% above your measured keystroke rate
(re-estimated every 2 s from a trailing 10 s window, eased ≤5% per step). It is a suggestion only
— it never gates a target or affects scoring (see `bitrate-pacer-spec.md`).

Each lane also sounds a **target tone** (see `bitrate-tones-spec.md`), redundant with the visual.
Pitch ascends left→right on the major pentatonic (`a`=C5 up to `;`=E6), so it maps to screen
position, not hand; the hand is carried by timbre and pan instead (left = a warm mallet-ish tone
panned left, right = a brighter one panned right, each with a plucked attack that rings out). Each
tone is gated to its target's lifetime — it starts when the target
becomes current and releases when you hit it — so fast play runs legato and slow play sustains, and
the tone length is an audible readout of your own pacing.

Because eight lanes span more than an octave, a few tones are octave-equivalent (`a`/`k`, `s`/`l`,
`d`/`;`). That's deliberate: those pairs are no longer *homologous fingers* (`a` is left pinky,
`k` is right middle), so the one confusable pitch relation no longer lines up with a confusable
motor one.

Then pick **Practice** (untimed, `Esc` to quit) or **Start scored run** (60 seconds).

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

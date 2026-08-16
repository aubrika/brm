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

- **Target rate (bits/s)** — the pace to chase (default 8). A metronome ticks at the keystroke
  rate you'd need, at clean accuracy, to hit this bit rate: one tick every `log2(N-1) / target`
  seconds.

The default alphabet is the two home rows, `asdfjkl;` (N = 8).

Each lane sounds a distinct note — a C-major scale climbing left to right, `a`=do (C5) up to
`;`=do an octave higher (C6), voiced as a soft kalimba. The current target's note is re-plucked
and rings until you press it, so typing plays a melody and you hear which finger to fire next.

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

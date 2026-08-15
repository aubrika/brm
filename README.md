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
- **Left fingers** — keys for the left hand (default `asdf`).
- **Right fingers** — keys for the right hand (default `jkl;`).
- **Thumbs** — on by default. Adds thumb keys in the middle. A blank space entry is the
  spacebar. Default is the spacebar as one central key, so the default alphabet is
  `asdf` + space + `jkl;` (N = 9).

Then pick **Practice** (untimed, `Esc` to quit) or **Start scored run** (60 seconds).

Type the highlighted key at the bottom. Left-hand keys are blue, right-hand keys are yellow,
thumb keys are grey. The bar above shows the keys coming next.

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

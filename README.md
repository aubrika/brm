# Bit-Rate Maximizer

The bit-rate maximizer is a game with an uncommon purpose: actively helping the player get the highest score possible on their very first scored playthrough.

To play the game, the player simply uses a mouse (for best results) or other pointing device to click the orange grid cells as quickly and accurately as they can for 60 seconds. The position of the next orange cell is highlighted with a "ghost target" providing a degree of look-ahead, so that the player can infer where the mouse must move next. The player's score is identical to their bit rate, representing how fast the player transfers information through the game interface.

Bit rate is calculated as follows:

```math
B \;=\; \frac{\log_2\!\left(\textcolor{#5a8ad0}{N} - 1\right)\,\cdot\,\max\!\left(\textcolor{#b77e00}{S_c} - \textcolor{#eb5460}{S_i},\; 0\right)}{\textcolor{#838899}{t}}
```


| term | meaning | in the game |
|---|---|---|
| $\textcolor{#5a8ad0}{N}$ | number of possible selections | the number of grid cells on the target grid |
| $\textcolor{#b77e00}{S_c}$ | correct selections in time window $\textcolor{#838899}{t}$  | correct clicks of the target cell |
| $\textcolor{#eb5460}{S_i}$ | incorrect selections in $\textcolor{#838899}{t}$ | clicks that miss the target cell |
| $\textcolor{#838899}{t}$ | time in seconds | one 60-second evaluation window |

The target sequences (in this case, sequences of various grid states) comprising the set of possible selections must be `"sampled uniformly at random with replacement from an alphabet of size N ≥ 3. The sequence must be i.i.d. — no patterns, no structure, no language models, no predictive text, no word-level targets"`. This means the sequences are devoid of internal structure which could allow a player to start predicting them, making this something of a "noise transcription" task, and essentially less efficient than the transcription of natural language or other patterns. The randomness of the generated sequences may be confirmed in `src/core/sequence.ts`. The "alphabet" in the game is the set of (x,y) tuples where x,y >= 0 and x,y < G, where G is grid size, providing an $\textcolor{#5a8ad0}{N}$ of G^2 elements.

## Play It

**→ [aubrika.github.io/brm](https://aubrika.github.io/brm/)** — the game. Nothing to install.

To run it locally instead (which allows saving logged data):

```bash
./run.sh                                  # needs Node 18+; installs, builds, and opens the game
```

If you would rather not install a Node toolchain, a prebuilt `dist/` is committed:

```bash
cd dist && python3 -m http.server 8000    # then open http://localhost:8000
```

### What to expect

Two buttons: **Practice** and **Start scored run**.

- **Practice** runs as long as you like and ends when you press <kbd>Esc</kbd> (or tap *Exit* on a touchscreen). Nothing is scored. Use it to get a feel for the game.
- **Start scored run** is a single locked 60-second window. The clock does not start until your first click.

The live bit rate, the clock, and $\textcolor{#5a8ad0}{N}$ / $\textcolor{#b77e00}{S_c}$ / $\textcolor{#eb5460}{S_i}$ are on screen throughout, and the final run reports all four.

**On a phone or tablet**, the grid shrinks so cells stay big enough for a fingertip — which means $\textcolor{#5a8ad0}{N}$ is smaller there (36 on a typical phone, not 1024). Since $\textcolor{#5a8ad0}{N}$ is in the formula, a touch score is not directly comparable with a mouse score, but phone touchscreen play can still yield quite high bit rates presumably due to the lack of cursor travel time, additional finger recruitment, or both.

## Design Goals

1. Minimize training requirement: the game should require minimal familiarization and use common interface devices
2. Maximize decision density: $\textcolor{#5a8ad0}{N}$ should be as large as is possible without increasing decision latency to the point of bit rate reduction
3. Use UI features to reduce decision latency: where possible, the UI should assist the user in making the correct decision (as with the "ghost targets") without altering the IID property of the grid sequences
4. Provide accessible UI where possible: colorblind-safe palettes, and user-customizable support for alternate keyboard layouts

## Development Process

### *Version 0: Character Sequences (Typing Random Letters Slowly: The Game)*

An initial prototype was created to verify the bit-rate calculation of a player typing a single randomized sequence of home-row keys (asdfjkl;), displayed one at a time, on a QWERTY keyboard, yielding bit rates of 1-2 bit/s.

### *Version 1: Falling Lanes (The World's Least-Fun Rhythm Game)*

A brief review of the research on typing speed indicated that providing several characters at once could provide much higher reaction times for transcription, so several improvements were attempted. Displaying several letters at once yielded a bit rate of around 3 bit/s for IID data against the same home row alphabet of N=8. The introduction of a "piano roll" of vertically arranged letters, scrolling right to left, yielded an additional 1bit/s. The rotation of the piano roll 90 degrees, so that each "lane" sat directly above its associated finger, with the letters connected by a line traced along their sequence also yielded about 1bit/s thanks to a reduced reaction time. The introduction of the Okabe-Ito color palette seemed to reduce error rate of adjacent fingers by a marginal amount (but looked nice, I thought). The introduction of audio cues such as character-specific tones played to indicate the current target character, or a "pacer" to encourage faster input, seemed to have very little effect. This first "falling lane" version of the game, played with an $\textcolor{#5a8ad0}{N}$ of 4 to 16 seemed to hit a functional ceiling on performance at around 5 or 6 bit/s, with a couple outlier runs at 7 bit/s. A brief survey of research quickly indicated this was well below the commonly-attested bit rate of 10bit/s for human neural processing, so I decided to stop attempting incremental improvements to this version and move laterally.

You can still play V1 at [aubrika.github.io/brm/v1](https://aubrika.github.io/brm/v1/).

### *Version 2: Cell Selection (The World's Most Exciting Orange Square Blasting Game)*

The bit rate calculation provides two primary levers for improvement: increasing $\textcolor{#5a8ad0}{N}$ or increasing $\textcolor{#b77e00}{S_c}$ / $\textcolor{#838899}{t}$ without increasing $\textcolor{#eb5460}{S_i}$. It seemed my options for hitting the ceiling of physiological ability were then either to vastly increase the number of possible selections, or vastly increase the rate at which correct selections were made. Since V1 had largely focused on the latter by attempting to improve the player's transcription speed of random character sequences, I decided to try increasing $\textcolor{#5a8ad0}{N}$.

First, I asked a simple question: if I were to make (only) a correct decision every second, what set cardinality or $\textcolor{#5a8ad0}{N}$ would provide a bit rate of 10 bit/s? 1025. Where could I get an "alphabet" of size 1025 that everyone already knows and can hold in their head? I realized that if I switched the input to a pointing device (e.g. a mouse or trackpad), I could divide part of the player's visual field (e.g. a computer screen) into a grid, and a grid divided into 32 units on a side would have 1024 cells in it. Each cell would be a "letter" of the "alphabet" of the game, out of which the player is selecting a single option with every click. I also realized immediately that a naive implementation would lack any kind of look-ahead provision, so I implemented the "ghost" target to indicate the direction of the upcoming click and hopefully thereby reduce decision latency. My very first run of the V2 implementation against a 32x32 grid yielded a bit rate of 12bit/s, exceeding my expectations.

Various other improvements and experiments were attempted, including additional look-ahead targets (marginal or null improvement) and a "magnification" function to ostensibly allow for even larger $\textcolor{#5a8ad0}{N}$, but the additional time required for target acquisition nullified any advantage of the greater number of possible selections provided by a 128 x 128 grid, for example. Using a mouse, with a single highlighted target, and a single next target indicator, I am able to reliably hit bit rates of 12-13 bit/s, which exceeds the ceiling suggested by research of about 10 bit/s. Using a trackpad, however, my bit rate on the task never exceeded 10 bit/s, strongly recommending a mouse for optimal play.

## Results

The numbers below come from `logs/`, and `node scripts/analyze.mjs` recomputes all of them from that directory.

**`logs/` only fills up when the game is run locally.** `./run.sh` starts a server that exposes a small logging endpoint, and each finished run is saved to `logs/` automatically — that is where this dataset came from. The hosted build has no such endpoint and **transmits nothing**: playing at the link above writes nothing, anywhere. The report screen offers a **Download run log** button instead, producing the identical file by hand, so a run played on the hosted site is just as verifiable — it just has to be saved deliberately.

**The lookahead "ghost" target is worth +2.46 bits/s.** This is the single design decision with the largest measured effect across my runs. The A/B runs were played in ABBA-counterbalanced blocks with the look-ahead on or off, then paired:

| | ghost on | ghost off | Δ | 95% CI | p |
|---|---|---|---|---|---|
| bit rate | 12.504 b/s | 10.044 b/s | **+2.460** | [2.030, 2.889] | <0.001 |
| cycle time | 610 ms | 763 ms | −153 ms | [−169, −136] | <0.001 |
| error rate | 4.60% | 4.69% | −0.09% | [−1.88, 1.70] | 0.917 |

The ghost target buys its gain entirely in **speed**, at no cost in accuracy — knowing where to go next removes search time, but does not make you sloppier. (13 matched pairs, powered to detect ≥0.60 bits/s. A randomisation check confirms the two arms drew equally difficult sequences: mean Fitts ID 3.082 on vs 3.102 off, p=0.513.)

**$\textcolor{#5a8ad0}{N}$ = 1024 sits on a broad plateau, not a peak.** Results by grid size on my machine:

| grid | cell px | bits/selection | measured B |
|---|---|---|---|
| 8² | 222 | 5.98 | 9.07 b/s |
| 12² | 148 | 7.16 | 11.96 ±0.83 |
| 16² | 110 | 7.99 | 11.80 ±1.40 |
| 24² | 74 | 9.17 | **13.37 ±0.70** |
| 32² | 55 | 10.00 | **13.28 ±0.90** |
| 64² | 27 | 12.00 | 12.40 ±0.57 |

24² and 32² are statistically tied, and B falls off in both directions — too few cells drops bits per selection, too many can spend any gain on target acquisition time. 32² was initially chosen from that plateau for the round 10.00 bits/selection. This flatness is also why the game does **not** have a calibration step: three successive per-player calibrators were built and all three retired, because a plateau this broad didn't seem worth a measurement that was looking noisier than the difference it was trying to resolve.

**Aim scales with the target, which is why one fixed grid can serve every player.** Every logged click also records where the pointer actually landed relative to the centre of the cell it was aiming at. The spread of those offsets — call it $\sigma$, in pixels — settles a question that decides whether the game needs to adapt to each player at all: as cells get smaller, does a player's aim stay equally precise *in pixels*, so that fine grids become disproportionately error-prone? Or does it tighten to match the target?

It tightens, and almost exactly in proportion. Across the six grid sizes above, $\sigma$ came out at a near-constant **0.23 × the cell width**, whatever that width happened to be — a log-log slope of 1.07 (R² 0.999), where genuinely fixed precision would have given a slope of 0. Put through the ISO effective-width formula ($W_e = 4.133\sigma$, the width that captures ~96% of hits), that lands at $W_e \approx 0.94$ of a cell: about 96% of clicks fall inside the target no matter how big the target is — which is just the 2.5–6% error rates in the table above, restated.

So shrinking the grid costs **time, not accuracy**. The player slows down to hold the same relative precision, which is the ordinary Fitts' law tradeoff and matches the familiar UI heuristic that smaller buttons are slower to hit rather than likelier to be missed. It is visible in the table: cycle time climbs as cells shrink — 570 ms at 12², 737 ms at 32², 937 ms at 64² — while the error rate just wanders. That is also why the game has nothing left to calibrate per player — and why a fingertip needs different treatment, since a fingertip is a fixed physical size and its $\sigma$ *cannot* shrink to match a smaller cell. Hence the absolute 56px floor on touch, and a smaller $\textcolor{#5a8ad0}{N}$ instead.

## Verifying the numbers

Every run produces a self-contained JSON log — written to `logs/` automatically when running locally, or saved with **Download run log** from the report screen anywhere else — holding the **generated sequence** and **every input event** with timestamps and verdicts, so:

- $B$ can be recomputed from the file alone, independently of the code that displayed it;
- the sequence can be checked for uniformity by anyone who doubts the RNG (`src/core/sequence.ts` uses `crypto.getRandomValues` with rejection sampling, so there is no modulo bias);
- the on-screen report and the offline analysis are computed by the *same* module (`src/core/stats.js`), imported by both the browser and Node, so they cannot drift apart.

```bash
node scripts/analyze.mjs          # cross-run analysis over logs/
npx vitest run                    # 113 tests
```

## Relevant Research

I wasn't able to find any detailed research on, for example, typing speeds for IID data, other than a few references to it being "slower". This particular kind of evaluation setup seems relatively under-explored in the literature.

I was able to find and read W. E. Hick's *On the rate of gain of information* (1952), which indicated a bit rate ceiling of about 5 bit/s for a task roughly comparable to the one presented by my V1 implementation (using Morse paddles instead of a computer keyboard). This supports the plausibility of a 5-6 bit/s ceiling I hit, and also supports the decision to try a different implementation for higher bit rates.

I credit Zheng & Meister's *The unbearable slowness of being: Why do we live at 10 bits/s?* for inspiring me to explicitly target a 10bit/s bit rate, and thereby giving me the idea for the entire cell selection implementation.

## Potential Applications & Future Development

The look-ahead "ghost target" result above is the most potentially interesting thing to come out of this. A visual cue that costs nothing to deliver and adds 2.46 bits/s — purely by removing search time, with no accuracy penalty — suggests some applications beyond the game. One thought is that a pointing task like this might be used to confirm BCI functionality in an animal subject incapable of self-report but capable of similar pointing tasks, such as a primate. If the lookahead effect reproduces in a non-implanted non-human subject, then delivering the look-ahead cue *through an implant* (e.g. as a stimulus corresponding to the visual region of the upcoming target) could give a functional read on the channel: the subject's bit rate should be higher than control to the degree the implant is effectively transmitting the lookahead cue.


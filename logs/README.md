# Run logs

Each scored or practice run writes one full log here plus a summary line to `index.jsonl`.
The game's report screen and `scripts/analyze.mjs` both read these; nothing is ever
transmitted off this machine.

**These are keystroke timings from real people. `logs/*.json` and `logs/index.jsonl` are
gitignored** — the submitted repo ships this folder empty (just `.gitkeep` and this README).
A GRID (v2) run records only **cell indices** — no keyboard input is read at all. A keyboard
(v1) run records only **in-alphabet keys** — never free text, ever; out-of-alphabet presses are
kept only as a single count in `summary.outOfAlphabet`.

## Files

```
index.jsonl                              # one summary object per line, append-only
2026-08-14T19-03-22_calvin_a3f1.json     # one full log per run
analysis.json                            # written by scripts/analyze.mjs
```

Filename: `<ISO timestamp, colons→dashes>_<machine label, slugified>_<first 4 of runId>.json`
— sortable, greppable by machine, collision-free.

## Schema (`schemaVersion: 3`)

```jsonc
{
  "schemaVersion": 3,
  "meta": {
    "runId": "…",                  // crypto.randomUUID()
    "startedAt": "2026-…Z",
    "mode": "scored",              // "scored" | "practice"
    "machine": {
      "installId": "u_…",          // random, persisted in localStorage; not derived
      "label": "calvin",           // free text from the config screen; "" if unset
      "ua": "…", "platform": "…", "hardwareConcurrency": 10,
      "estimatedRefreshHz": 120,   // median of ~30 rAF ticks at startup
      "timeOriginPrecisionMs": 0.1 // smallest nonzero performance.now() delta (see below)
    },
    "appVersion": "1.0.0", "commit": "a1b2c3d",  // the build that produced this run
    // `config` states only what was actually played, discriminated by `mode`.
    // GRID (v2):     { "mode": "grid", "n": 1024, "durationMs": 60000, "sound": true }
    //                (the grid geometry itself lives in the top-level `grid` section)
    // KEYBOARD (v1): adds "alphabet", "leftFingers"/"rightFingers", "lookahead",
    //                "lanes", "errorFeedback", "chords" …
    "config": { "mode": "grid", "n": 1024, "durationMs": 60000, "sound": true }
  },
  "sequence": ["j","f",";", …],     // targets presented, in order
  "eventColumns": ["t","type","key","idx","verdict"],
  "events": [
    [412.3, "down", "j", 0, "ok"],
    [498.7, "up",   "j", 0, null],
    [640.1, "down", "k", 2, "err"], // idx is the LIVE target index → independently re-scorable
    [712.9, "down", ";", 2, "ok"]
  ],
  "latencySamples": [ { "t": 412.3, "downToPaintMs": 8.2 }, … ],
  // ---- GRID (v2) sections; absent on keyboard runs ----
  // `lookahead` is how many upcoming targets were previewed (0 | 1 | 2); `ghost` is the derived
  // boolean (lookahead > 0), kept so logs written before depth existed stay comparable. NOTE: T+1
  // was drawn dimmer before the depth-2 work, so depth-1 runs either side of that build differ
  // visually — group by meta.commit before comparing them.
  "grid": { "enabled": true, "gridSize": 32, "depth": 1, "fieldPx": 896, "cellPx": 28,
            "devicePixelRatio": 2, "ghost": true, "lookahead": 1, "crosshair": true, "hoverPulse": true,
            "pointerType": "mouse", "ghostAdjacent": [0,1,…], "pointerTypes": ["mouse",…] },
  "calibration": { "referenceGrid": 24, "clicks": [ {"t":…,"targetCell":…,"dx":…,"dy":…,"mtMs":…} ],
                   "sigmaX": …, "sigmaY": …, "sigmaUsed": …,   // sigmaUsed = RMS of the two axes
                   "effectiveWidthPx": …, "fittsA": …, "fittsB": …, "fittsR2": …,
                   "impliedThroughput": null,                   // null when the slope is unmeasurable
                   "recommendedGrid": 32, "chosenGrid": 32, "overridden": false,
                   "pointerType": "mouse", "fieldPx": 896, "devicePixelRatio": 2 },
  "pointerPath": [[t, x, y], …],   // field-local pointer samples, ~one per frame
  // Present only when the A/B harness assigned this run an arm. `block` is the pair index and
  // `position` is which half of the pair — the analyzer pairs on these, never on timestamps,
  // so an abandoned run or a mid-pair reload cannot silently mis-pair two conditions.
  // `grid.ghost` states what was actually drawn and must agree with `arm`.
  "ab": { "experiment": "ghost", "arm": "off", "block": 3, "position": 1 },
  // `scope` (pointer-lock magnifier experiment) appears only on scope runs.

  // `rollovers` is keyboard-only (it counts down/up overlap); it is 0 on grid runs,
  // which record no key-up events.
  "summary": { "bitsPerSecond": …, "n": …, "sc": …, "si": …, "elapsedS": 60,
               "accuracy": …, "grossKeysPerSec": …, "netSelectionsPerSec": …,
               "medianIkiMs": …, "rollovers": …, "droppedFrames": …, "outOfAlphabet": … }
}
```

- **`idx`** is the index into `sequence` that was live when the event fired. Because
  retry-until-correct doesn't advance on a miss, an `err` row's `idx` still points at the
  target that was missed, so `sequence[idx]` is ground truth for the confusion analysis, and
  the whole log is independently re-scorable.
- **`up` events** exist only to make *rollover* (the next key going down before the previous
  comes up) measurable. Scoring is keydown-only.

## Finger map (a documented assumption)

Hand and finger are derived purely from a key's **position in the alphabet string**: the first
`floor(N/2)` keys are the left hand, the rest the right; within each hand keys are ordered
**outside-in**, so the outermost key is the pinky, then ring, middle, and every remaining inner
key collapses onto the index finger. For the default `asdfjkl;` this is exact — one key per
finger — and for `asdfghjkl;` it correctly puts `f`+`g` on the left index and `h`+`j` on the
right index. It is an approximation for arbitrary alphabets, not anatomy.

## Timing precision

`performance.now()` is clamped by browsers unless the page is cross-origin isolated (commonly
100 µs in Chromium, coarser in Firefox). That is fine for IKI (hundreds of ms) and adequate for
rollover overlap (tens of ms), but `meta.machine.timeOriginPrecisionMs` records the measured
resolution so the analyzer can flag any machine where rollover timing is near the noise floor.

## Analyzing

```
node scripts/analyze.mjs [--machine calvin] [--scored-only]
```

Prints a text report (transition costs, within-run quartiles, post-error slowing by feedback
mode, confusion matrix, IKI histogram, and the slowest/fastest specific digraphs tagged by
hand/finger) and writes `analysis.json`.

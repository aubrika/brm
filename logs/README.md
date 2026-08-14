# Run logs

Each scored or practice run writes one full log here plus a summary line to `index.jsonl`.
The game's report screen and `scripts/analyze.mjs` both read these; nothing is ever
transmitted off this machine.

**These are keystroke timings from real people. `logs/*.json` and `logs/index.jsonl` are
gitignored** — the submitted repo ships this folder empty (just `.gitkeep` and this README).
Only **in-alphabet keys** are recorded — never free text, ever. Out-of-alphabet presses are
kept only as a single count in `summary.outOfAlphabet`.

## Files

```
index.jsonl                              # one summary object per line, append-only
2026-08-14T19-03-22_calvin_a3f1.json     # one full log per run
analysis.json                            # written by scripts/analyze.mjs
```

Filename: `<ISO timestamp, colons→dashes>_<machine label, slugified>_<first 4 of runId>.json`
— sortable, greppable by machine, collision-free.

## Schema (`schemaVersion: 2`)

```jsonc
{
  "schemaVersion": 2,
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
    "config": { "alphabet": "asdfjkl;", "n": 8, "lookahead": 7,
                "lanes": true, "sound": true, "errorFeedback": "flash+shake",
                "durationMs": 60000 }
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
mode, confusion matrix, IKI histogram) and writes `analysis.json`.

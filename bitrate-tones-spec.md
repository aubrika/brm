# Spec: Target tone layer

A short tone that sounds when a target becomes current, encoding lane identity redundantly with the
visual. Distinct from the adaptive pacer (see the pacer spec) — that one marks time and is not tied
to targets; this one is tied to targets and does not mark time. They can run together, but they are
separate features with separate toggles and separate log fields.

**What this is for.** Not identity — vision already delivers that in parallel across the visible
lookahead, faster than audition can deliver it serially. The tone is redundant confirmation plus a
rhythmic anchor, and the correlated-redundant-dimensions result (transmitted information rises when
dimensions vary in correlation, versus either alone) is the reason to expect a gain. Treat it as an
experiment with an A/B, not a shipped mechanic.

---

## 1. Pitch mapping

**Pitch ascends left to right across all eight lanes.** Pitch height corresponds to horizontal
screen position, which corresponds to key position — the same compatibility argument as the 90°
rotation, applied to a third axis. Do not use pitch to encode hand; hand is carried by pan and
timbre (§2).

**Major pentatonic**, because sustained tones will overlap at 2+ selections per second and pentatonic
has no semitones and no tritone — any two notes sounding together stay consonant. A diatonic or
chromatic ladder will beat and muddy at speed.

| lane | key | note | Hz |
|---|---|---|---|
| 0 | a | C5 | 523.25 |
| 1 | s | D5 | 587.33 |
| 2 | d | E5 | 659.25 |
| 3 | f | G5 | 783.99 |
| 4 | j | A5 | 880.00 |
| 5 | k | C6 | 1046.50 |
| 6 | l | D6 | 1174.66 |
| 7 | ; | E6 | 1318.51 |

Range chosen deliberately: 500–1300 Hz has good pitch discrimination and sits above where laptop
speakers roll off. Anything below ~400 Hz may not be audible at all on a grader's machine.

**Generalize to arbitrary N.** The alphabet is configurable, so generate the ladder rather than
hardcoding it: walk the major pentatonic degrees `[0, 2, 4, 7, 9]` semitones upward from C5,
repeating at +12 per octave, and take the first N. Cap at 12 lanes; above that the range gets
uncomfortable and the mapping should be disabled.

**Known limitation, worth a README line.** Eight notes spanning more than an octave leaves some
octave-equivalent pairs (a–k, s–l, d–;). Octave pairs are the most perceptually similar tones there
are — shared chroma is why they share a letter name. Avoiding them entirely requires a
non-octave-repeating scale, which is not worth the strangeness. What matters is that these pairs are
no longer *homologous fingers*: `a` is left pinky and `k` is right middle, so the confusable pitch
relation no longer coincides with the confusable motor relation. That is the specific improvement
over an octave-shift-per-hand scheme.

---

## 2. Hand coding: timbre primary, pan secondary

**Timbre is load-bearing; pan is a bonus.** Laptop speakers give almost no stereo separation, and it
is not safe to assume headphones. Timbre survives mono; panning does not.

- Left hand: sine, lowpass at ~2 kHz.
- Right hand: triangle, lowpass at ~4 kHz.
- Pan: `StereoPannerNode` at −0.7 / +0.7. Not hard-panned — full separation is fatiguing over a
  60-second run and phasey on speakers.

Split the hands at `floor(N/2)`, so this works for configurable alphabets.

---

## 3. Envelope

Gate the tone to the lifetime of the target — it starts when the target becomes current and releases
when it resolves.

- Attack 5 ms, no perceptible click.
- Sustain for as long as the target is current, **minimum 80 ms** so very fast play doesn't produce
  clipped stubs.
- Release ~120 ms exponential tail.

The consequence is that fast play produces a legato run and slow play produces sustained tones, so
tone length becomes an audible readout of the player's own pacing — they hear themselves slowing
before they see it. That is arguably the feature's main value, and it is lost if you use a
fixed-length blip. Do not use a fixed-length blip.

**Voice management.** Cap simultaneous voices at 3; steal the oldest. With the release tail,
overlapping voices are expected and desirable, but unbounded overlap turns into mud.

---

## 4. Implementation

- `src/audio/tones.ts`, separate module from the pacer, sharing one `AudioContext` and one master
  `GainNode`.
- Pre-compute the frequency table once at run start from the alphabet. No math in the hot path.
- `OscillatorNode`s are single-use; create per tone, `stop()` with the release tail scheduled, and
  let GC handle them. Do not attempt to pool oscillators.
- **Schedule against `AudioContext.currentTime`**, never `setTimeout` for envelope stages. Use
  `gain.setValueAtTime` / `exponentialRampToValueAtTime`.
- The trigger fires from the same place that advances the target index, but must be a fire-and-forget
  call. **No audio work may block or precede state advancement.** If `AudioContext` is suspended or
  unavailable, disable the layer silently and record that in the log.
- Independent volume from the pacer, default low.

---

## 5. Config

- `Target tones`: Off (default) / On.
- `Hand coding`: Timbre only / Timbre + pan (default when on).
- Volume slider, shared master with pacer but independently trimmable.

Off by default until the A/B says otherwise.

---

## 6. Logging and the A/B

Extend the run log:

```jsonc
"tones": {
  "enabled": true,
  "scale": "pentatonic",
  "baseHz": 523.25,
  "handCoding": "timbre+pan",
  "voiceStealEvents": 3
}
```

No need to log per-tone timestamps — tones are deterministic from target onsets, which are already
in `events`.

**The measurement that decides this feature:** median IKI and accuracy, tones on versus off, same
alphabet, alternating order across at least four blocks. Randomize the order; a straight on/off/on/off
run confounds the comparison with the practice curve.

Add to `analyze.mjs`: a `--compare tones` mode that groups runs by `tones.enabled` and reports median
IKI, accuracy, and B with per-block variance. Report it honestly — sustained tones at speed can
muddy rather than help, and a null or negative result is a legitimate README line. "We tried
auditory redundancy and measured no gain" is a stronger claim than an untested feature left switched
on.

---

## 7. Build order

1. Frequency table generation from arbitrary alphabets, unit-tested.
2. Single voice, fixed timbre, correct envelope with target-gated sustain. Verify no hot-path cost.
3. Timbre split by hand.
4. Pan.
5. Voice cap and stealing.
6. `--compare tones` in the analyzer, then run the A/B before deciding the default.

---

## Implementation notes (as built)

The sound design in §1–3 is implemented; the experiment scaffolding in §5–6 is deferred (the tones
are kept always-on for now rather than behind an A/B toggle — to be revisited when measuring).

- Pitch (`laneToneHz` in `src/audio.ts`) generates the pentatonic ladder from C5 for arbitrary N;
  the lane→pitch/hand map is `laneAudio` in `config.ts`. Unit-tested against the table above.
- Hand coding and the target-gated envelope (attack 5 ms, min-sustain 80 ms, ~120 ms release,
  3-voice cap with oldest-stolen) live in `AudioFeedback.toneAdvance` / `releaseAllTones`.
- The trigger fires from the index-advance point (`app.ts` `onKey`, correct branch, and at
  play-start), after state has advanced — fire-and-forget, never blocking scoring.
- Kept in `src/audio.ts` alongside the pacer (sharing the one `AudioContext`) rather than a
  separate `src/audio/tones.ts` module.

// The analyzer's presentation layer. Every function here takes an already-computed analysis object
// and returns lines of text; none of them compute anything, and none of them read a log. The split
// is what makes the numbers auditable — an analysis function can be read on its own to see what it
// measures, without 268 lines of padStart() in the way, and a formatting change cannot alter a
// result.
//
// Section numbers are historical and have gaps. They are kept because the README and several commit
// messages cite them ("see [12]"), and renumbering would silently break those references.

import { mean, machineKey } from './analyze.mjs';

function bucketLine(name, s) {
  if (s.count < 8) return `    ${name.padEnd(24)} n=${s.count} (too few)`;
  return `    ${name.padEnd(24)} median ${ms(s.median).padStart(6)}  p90 ${ms(s.p90).padStart(6)}  n=${s.count}`;
}

function gridArmLine(a) {
  return `    ${a.label.padEnd(10)}  TP ${a.throughput.toFixed(2)} b/s · MT=${Math.round(a.interceptMs)}+${Math.round(a.slopeMsPerBit)}·ID (R²${a.r2.toFixed(2)}) · B ${a.meanBps.toFixed(2)} · acc ${(a.meanAccuracy * 100).toFixed(1)}% · ${a.runs} run(s)`;
}

function machineLine(logs) {
  const m = logs[0].meta.machine;
  const fields = [...new Set(logs.filter((l) => l.grid?.fieldPx).map((l) => Math.round(l.grid.fieldPx)))].sort((a, b) => a - b);
  const screen = m.screenWidth ? `${m.screenWidth}×${m.screenHeight}` : 'screen unrecorded';
  const win = m.windowWidth ? `window ${m.windowWidth}×${m.windowHeight}` : 'window unrecorded';
  const dpr = m.devicePixelRatio ? ` @${m.devicePixelRatio}x` : '';
  return `${machineKey(logs[0]).padEnd(12)} ${String(logs.length).padStart(3)} runs · ${screen}${dpr} · ${win} · field ${fields.join('/') || '—'}px · ${m.platform || '?'} · ${m.estimatedRefreshHz || '?'}Hz`;
}

// ---------------------------------------------------------------- report ----
function ms(v) {
  return v ? `${Math.round(v)}ms` : '—';
}

// ---- one function per section ------------------------------------------------
// Each takes the analysis and returns its own lines. Numbers keep their historical gaps
// ([6] to [9] to [11]) because the README and several commit messages cite them.

/** Run identity: which machines, over what range, and every run in order. */
function reportIdentity(logs) {
  const L = [];
  const dates = logs.map((l) => l.meta.startedAt).sort();
  L.push(`  runs: ${logs.length}`);
  const byMachine = new Map();
  for (const l of logs) {
    const k = machineKey(l);
    if (!byMachine.has(k)) byMachine.set(k, []);
    byMachine.get(k).push(l);
  }
  L.push('  machines:');
  for (const ls of byMachine.values()) L.push('    ' + machineLine(ls));
  if (dates.length) L.push(`  range: ${dates[0]} → ${dates[dates.length - 1]}`);
  L.push('');
  L.push('  bits/s by run (chronological):');
  for (const l of logs) {
    const tag = l.meta.mode === 'scored' ? '●' : '○';
    const commit = (l.meta.commit || '—').padEnd(12);
    L.push(`    ${tag} ${String(l.summary.bitsPerSecond.toFixed(2)).padStart(6)}   ${commit} ${l.__file}`);
  }
  L.push('');
  return L;
}

function section01Transitions(analysis) {
  const L = [];
  L.push('  [1] IKI by transition type (correct pairs), per machine');
  for (const [label, b] of Object.entries(analysis.transitions)) {
    L.push(`  ${label}:`);
    L.push(bucketLine('same finger', b.sameFinger));
    L.push(bucketLine('same hand, diff finger', b.sameHand));
    L.push(bucketLine('cross hand', b.crossHand));
  }
  L.push('');
  return L;
}

function section02Quartiles(analysis) {
  const L = [];
  L.push('  [2] Within-run quartiles (median IKI per quarter)');
  for (const q of analysis.quartiles) L.push(`    Q${q.quarter}  median ${ms(q.median).padStart(6)}  n=${q.count}`);
  L.push('');
  return L;
}

function section03PostError(analysis) {
  const L = [];
  L.push('  [3] Post-error slowing, by error feedback');
  for (const [fb, g] of Object.entries(analysis.postError)) {
    const sign = g.inflationMs >= 0 ? '+' : '';
    L.push(`    ${fb.padEnd(14)} baseline ${ms(g.baselineMedian).padStart(6)}  post-error ${ms(g.postErrorMedian).padStart(6)}  (${sign}${Math.round(g.inflationMs)}ms, n=${g.postErrorCount})`);
  }
  L.push('');
  return L;
}

function section04Confusion(analysis) {
  const L = [];
  L.push('  [4] Error confusion (target → pressed), top 12');
  if (analysis.confusion.total === 0) L.push('    no errors recorded');
  for (const p of analysis.confusion.pairs.slice(0, 12)) {
    L.push(`    ${p.target} → ${p.pressed}   ${p.count}`);
  }
  L.push('');
  return L;
}

function section05Histogram(analysis) {
  const L = [];
  L.push('  [5] IKI histogram (25 ms bins)');
  const hist = analysis.histogram;
  const maxCount = Math.max(1, ...hist.bins);
  hist.bins.forEach((c, i) => {
    if (c === 0) return;
    const lo = i * hist.binMs;
    const bar = '█'.repeat(Math.round((c / maxCount) * 40));
    L.push(`    ${String(lo).padStart(4)}ms ${bar} ${c}`);
  });
  if (hist.overflow) L.push(`    ${String(hist.maxMs).padStart(4)}+  (overflow) ${hist.overflow}`);
  L.push(`    median ${ms(hist.median)}   p90 ${ms(hist.p90)}   n=${hist.total}`);
  L.push('');
  return L;
}

function section06Digraphs(analysis) {
  const L = [];
  const dg = analysis.digraphs;
  const KIND = { sameFinger: 'same-finger', sameHand: 'same-hand', crossHand: 'cross-hand', null: '—' };
  const dgLine = (r) =>
    `    ${r.a}→${r.b}  ${ms(r.median).padStart(6)}  p90 ${ms(r.p90).padStart(6)}  n=${String(r.count).padStart(3)}  ${(KIND[r.kind] ?? '—').padEnd(11)} ${r.handA}${r.handB}  ${r.fingerA}/${r.fingerB}`;
  L.push(`  [6] Specific digraphs, ranked by median IKI (n>=${dg.minCount})`);
  if (dg.alphabetsPresent.length > 1) L.push(`    (multiple alphabets present; classified using "${dg.alphabet}")`);
  if (dg.slowest.length === 0) {
    L.push('    not enough repeated digraphs yet');
  } else {
    L.push('    slowest:');
    for (const r of dg.slowest) L.push(dgLine(r));
    L.push('    fastest:');
    for (const r of dg.fastest) L.push(dgLine(r));
    L.push('    by kind (median of per-digraph medians):');
    for (const kind of ['sameFinger', 'sameHand', 'crossHand']) {
      const k = dg.byKind[kind];
      L.push(`      ${KIND[kind].padEnd(11)} ${ms(k.medianOfMediansMs).padStart(6)}   digraphs=${String(k.digraphs).padStart(2)}  transitions=${k.transitions}`);
    }
    const pf = (name, p) =>
      `    ${name.padEnd(9)} cross-hand ${p.crossHand}/${p.n}  same-hand ${p.sameHand}/${p.n}  same-finger ${p.sameFinger}/${p.n}  adjacent-key ${p.adjacentKey}/${p.n}  (${ms(p.medianOfMediansMs)})`;
    L.push(`    commonality (slowest ${dg.slowestProfile.n} vs fastest ${dg.fastestProfile.n}):`);
    L.push(pf('slowest', dg.slowestProfile));
    L.push(pf('fastest', dg.fastestProfile));
  }
  L.push('');
  return L;
}

function section09ByBuild(analysis) {
  const L = [];
  L.push('  [9] bits/s by build (commit), oldest first');
  for (const r of analysis.byBuild) {
    L.push(`    ${r.commit.padEnd(12)} v${String(r.version).padEnd(6)} median ${r.medianBps.toFixed(2).padStart(6)}  mean ${r.meanBps.toFixed(2).padStart(6)}  n=${String(r.n).padStart(3)}  ${String(r.first).slice(0, 10)}`);
  }
  L.push('');
  return L;
}

function section11GridMode(analysis) {
  const L = [];
  const gr = analysis.grid;
  L.push('  [11] GRID MODE (pointing) — Fitts throughput, dwell, next-target adjacency');
  if (!gr) {
    L.push('    no grid runs yet');
  } else {
    L.push(`    grid runs ${gr.runs}   moves ${gr.overall.moves}`);
    L.push(`    overall  ${gridArmLine(gr.overall).trim()}`);
    L.push('    by pointer type:');
    for (const a of gr.byPointer) L.push(gridArmLine(a));
    L.push('    ghost on/off, pooled and UNPAIRED (descriptive only — the test is [12]):');
    L.push(gridArmLine(gr.ghost.on));
    L.push(gridArmLine(gr.ghost.off));
    // Lookahead depth is a config choice, not a randomised arm, so these groups are whatever runs
    // happened to be played under each setting — different sessions, different warm-up, different
    // hands. Read the spread, not the gap between the means; only [12] licenses a causal claim.
    L.push('    by lookahead depth (config groups, NOT randomised — mean ± sd of bits/s):');
    for (const a of gr.byLookahead) {
      const m = mean(a.bpsList);
      const sd = a.bpsList.length > 1 ? Math.sqrt(a.bpsList.reduce((s2, v) => s2 + (v - m) * (v - m), 0) / (a.bpsList.length - 1)) : NaN;
      const spread = Number.isFinite(sd) ? ` ± ${sd.toFixed(2)}` : '';
      L.push(`      ${a.label.padEnd(18)} ${m.toFixed(3)}${spread} bits/s · cycle ${Math.round(a.meanCycleMs)}ms · acc ${(a.meanAccuracy * 100).toFixed(1)}% · ${a.runs} run(s)`);
    }
    if (gr.dwell.count > 0) {
      L.push(`    verify dwell (hover→click): median ${Math.round(gr.dwell.medianMs)}ms · mean ${Math.round(gr.dwell.meanMs)}ms · n=${gr.dwell.count}`);
    } else {
      L.push('    verify dwell: no pointer-path samples (older logs, or logging was off)');
    }
    L.push(`    misclicks landing on the ghost cell: ${gr.ghostMisclicks.ghostHits}/${gr.ghostMisclicks.errs} errors (${(gr.ghostMisclicks.share * 100).toFixed(1)}%)`);
    L.push(
      `    err rate by next-target distance:  near ${(gr.adjacency.nearErrRate * 100).toFixed(1)}% (n=${gr.adjacency.nearN})  vs  far ${(gr.adjacency.farErrRate * 100).toFixed(1)}% (n=${gr.adjacency.farN})`,
    );
  }
  L.push('');
  return L;
}

function section12GhostAb(analysis) {
  const L = [];
  const ab = analysis.ghostAb;
  L.push('  [12] GHOST A/B — does the next-target preview raise bit rate? (paired, within-block)');
  if (!ab || ab.runs === 0) {
    L.push('    no A/B-tagged runs. Arm "A/B the lookahead ghost" on the config screen, then play');
    L.push('    scored runs in pairs — the harness assigns one ghost-on and one ghost-off per pair.');
  } else if (ab.pairs.length === 0) {
    L.push(`    ${ab.runs} tagged run(s) but no complete pair yet — play the other half of the pair.`);
  } else {
    const sizes = ab.gridSizes.length === 1 ? `${ab.gridSizes[0]}×${ab.gridSizes[0]}` : ab.gridSizes.map((s) => `${s}²`).join(', ');
    L.push(`    ${ab.pairs.length} complete pair(s) · ${ab.runs} tagged run(s) · grid ${sizes}`);
    for (const d of ab.dropped) L.push(`    ! pair ${d.block + 1} dropped: ${d.why}`);
    L.push('    pair    ghost on              ghost off             Δ (on − off)');
    for (const p of ab.pairs) {
      const d = p.on.bps - p.off.bps;
      L.push(
        `    ${String(p.block + 1).padStart(4)}    ${p.on.bps.toFixed(3).padStart(7)} b/s          ${p.off.bps.toFixed(3).padStart(7)} b/s          ${(d >= 0 ? '+' : '') + d.toFixed(3)}`,
      );
    }
    const line = (label, test, on, off, fmt, unit) => {
      if (!Number.isFinite(test.p)) return `    ${label.padEnd(16)} ${fmt(on)} vs ${fmt(off)} — need ≥2 pairs to test`;
      const sign = test.mean >= 0 ? '+' : '';
      return (
        `    ${label.padEnd(16)} on ${fmt(on)}  off ${fmt(off)}  Δ ${sign}${fmt(test.mean)}${unit}` +
        `  95% CI [${fmt(test.lo)}, ${fmt(test.hi)}]  p=${test.p.toFixed(3)}`
      );
    };
    const b3 = (v) => v.toFixed(3);
    const ms0 = (v) => (Number.isFinite(v) ? Math.round(v).toString() : '—');
    const pct = (v) => (Number.isFinite(v) ? (v * 100).toFixed(2) : '—');
    L.push('');
    L.push(line('bits/s', ab.tests.bps, ab.means.on.bps, ab.means.off.bps, b3, ''));
    L.push(line('cycle time', ab.tests.cycleMs, ab.means.on.cycleMs, ab.means.off.cycleMs, ms0, 'ms'));
    L.push(line('error rate %', ab.tests.errRate, ab.means.on.errRate, ab.means.off.errRate, pct, '%'));
    L.push(`    randomisation check: mean ID on ${ab.means.on.meanId.toFixed(3)} vs off ${ab.means.off.meanId.toFixed(3)} bits (p=${ab.tests.meanId.p.toFixed(3)}) — should be ~equal`);
    if (Number.isFinite(ab.tests.bps.mde)) {
      L.push(`    resolution: ${ab.pairs.length} pairs can detect ≥ ${ab.tests.bps.mde.toFixed(2)} bits/s at 80% power.`);
      L.push('    A null result here means "smaller than that", never "zero".');
    }
    const near = (a) => (a.near.total > 0 ? (100 * a.near.err) / a.near.total : NaN);
    const far = (a) => (a.far.total > 0 ? (100 * a.far.err) / a.far.total : NaN);
    L.push('    mechanism check — error rate when T+1 is near vs far:');
    L.push(`      ghost on   near ${pct(near(ab.adjacency.on) / 100)}%  far ${pct(far(ab.adjacency.on) / 100)}%`);
    L.push(`      ghost off  near ${pct(near(ab.adjacency.off) / 100)}%  far ${pct(far(ab.adjacency.off) / 100)}%   (off should show NO gap — T+1 is invisible)`);
  }
  L.push('');
  return L;
}

function section13GridSizes(analysis) {
  const L = [];
  const gs = analysis.gridSizes;
  L.push('  [13] GRID SIZE SWEEP — what resolution costs and buys (scored, depth-1 geometry)');
  if (!gs) {
    L.push('    no scored grid runs yet');
  } else {
    for (const m of gs.perMachine) {
    if (gs.perMachine.length > 1) L.push(`    ── ${m.key} ──`);
    L.push('    grid   cellPx  runs   bits/sel   bits/s          err     cycle    sigma  sigma/cell  look');
    for (const r of m.rows) {
      const sd = Number.isFinite(r.sdBps) ? '±' + r.sdBps.toFixed(2) : '     ';
      const sig = Number.isFinite(r.sigmaPx) ? r.sigmaPx.toFixed(1).padStart(6) : '     —';
      const ratio = Number.isFinite(r.sigmaOverCell) ? r.sigmaOverCell.toFixed(3).padStart(10) : '         —';
      L.push(
        `    ${String(r.grid).padStart(4)}²  ${String(Math.round(r.cellPx)).padStart(6)}  ${String(r.runs).padStart(4)}   ` +
          `${r.bitsPerSelection.toFixed(2).padStart(7)}   ${r.meanBps.toFixed(3).padStart(6)} ${sd}  ` +
          `${(100 * r.errRate).toFixed(2).padStart(5)}%  ${String(Math.round(r.meanCycleMs)).padStart(5)}ms  ${sig}  ${ratio}  ${r.depths.join(',')}`,
      );
    }
    if (m.law) {
      // v1's calibration assumed scatter is a fixed px property of the hand (slope 0). The measured
      // slope is ~1: it is a fixed FRACTION of the target instead, which makes that calibration's
      // central equation cellPx = 4.133·σ true at EVERY grid size — no unique solution, which is
      // why it was retired. A slope that FALLS below 1 at the fine end would be the device noise
      // floor appearing, and is the one thing that could make σ a real measurement again.
      L.push('');
      L.push(`    scatter law:  log σ = ${m.law.intercept.toFixed(2)} + ${m.law.slope.toFixed(3)}·log cellPx   (R² ${m.law.r2.toFixed(3)}, ${m.rows.filter((r) => Number.isFinite(r.sigmaPx)).length} grid sizes)`);
      L.push(`    mean σ/cellPx = ${m.ratio.toFixed(3)}   →  We = 4.133σ = ${(4.133 * m.ratio).toFixed(2)}·cellPx`);
      L.push('    slope 0 = fixed scatter (what v1 calibration assumed); slope 1 = scatter scales with the target.');
    }
    L.push('');
    }
  }
  L.push('');
  return L;
}

function section14Calibration(analysis) {
  const L = [];

  return L;
}

function section15TouchSized(analysis) {
  const L = [];
  const cv = analysis.calibrationV2;
  L.push('  [14] CALIBRATION (retired) — the knee the old calibrator looked for, and whether it was there');
  if (!cv || (!cv.validity.length && !cv.knee.some((k) => k.rows.length))) {
    L.push('    no v2 calibrations and too few grid sizes played to look for a knee');
  } else {
    for (const k of cv.knee) {
      if (!k.rows.length) continue;
      L.push(`    ── ${k.key} — cycle time vs the Fitts line fitted on ${k.fittedTo.join('/')}² ──`);
      L.push('    grid   observed   predicted   excess   measured B   runs');
      for (const r of k.rows) {
        const flag = r.excess > 0.15 ? '  ← above the line' : '';
        L.push(
          `    ${String(r.grid).padStart(4)}²  ${String(Math.round(r.observed)).padStart(7)}ms  ${String(Math.round(r.predicted)).padStart(8)}ms  ` +
            `${(100 * r.excess).toFixed(0).padStart(5)}%  ${r.measuredBps.toFixed(2).padStart(10)}  ${String(r.runs).padStart(4)}${flag}`,
        );
      }
      const broke = k.rows.filter((r) => r.excess > 0.15);
      L.push(broke.length ? `    knee visible from ${broke[0].grid}² up.` : '    no departure in the measured range — the knee, if any, is finer than anything played.');
      L.push('');
    }
    if (!cv.validity.length) {
      L.push('    no v2 calibrations logged yet — play a scored run after calibrating to populate this.');
    } else {
      L.push('    validity — predicted best grid vs measured best:');
      for (const v of cv.validity) {
        const curve = v.est.map((e) => `${e.grid}:${e.bEst.toFixed(1)}`).join('  ');
        L.push(`    ${v.key}  method ${v.method}  r=${v.inflationRatio}`);
        L.push(`      B_est  ${curve}`);
        L.push(
          `      predicted argmax ${v.predictedArgmax}² → recommends ${v.recommended}² (played ${v.chosen}²)` +
            (v.measuredBest === null ? '  · no sweep on this machine to check against' : `  · measured best ${v.measuredBest}²  ${v.onPlateau ? '✓ on the plateau' : '✗ off the plateau'}`),
        );
      }
    }
  }
  const touch = analysis.touch;
  L.push('  [15] TOUCH-SIZED RUNS — coarse pointer, grid fitted to a fingertip');
  if (!touch || !touch.rows.length) {
    L.push('    none logged. (Touch runs are excluded from every analysis above by design: a');
    L.push('    different N on a different input device is a separate modality, not another point');
    L.push('    on the grid-size sweep.)');
  } else {
    L.push('    grid   cellPx   input   bits/s    acc     cycle   mode');
    for (const r of touch.rows) {
      L.push(
        `    ${String(r.grid).padStart(4)}²  ${String(r.cellPx).padStart(6)}  ${String(r.pointerType).padStart(6)}  ` +
          `${r.bps.toFixed(2).padStart(6)}  ${(100 * r.accuracy).toFixed(1).padStart(5)}%  ${String(Math.round(r.cycleMs)).padStart(5)}ms  ${r.mode}`,
      );
    }
    L.push('    Not comparable with the runs above: B divides by log2(N-1), but measured B is not');
    L.push('    flat in N (9.07 bits/s at 8², 13.37 at 24²), and a thumb is not a mouse.');
  }
  L.push('');
  return L;
}

/** The whole report, as an ordered list of sections — which is all this function should be. */
export function printReport(logs, analysis) {
  const L = [
    '════════════════════════════════════════════════════════════',
    '  Bit-Rate Maximizer — cross-run analysis',
    '════════════════════════════════════════════════════════════',
    ...reportIdentity(logs),
    ...section01Transitions(analysis),
    ...section02Quartiles(analysis),
    ...section03PostError(analysis),
    ...section04Confusion(analysis),
    ...section05Histogram(analysis),
    ...section06Digraphs(analysis),
    ...section09ByBuild(analysis),
    ...section11GridMode(analysis),
    ...section12GhostAb(analysis),
    ...section13GridSizes(analysis),
    ...section14Calibration(analysis),
    ...section15TouchSized(analysis),
    '════════════════════════════════════════════════════════════',
  ];
  console.log(L.join('\n'));
}

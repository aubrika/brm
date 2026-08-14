// Machine fingerprint gathered once at startup and stamped into every run log, so
// cross-machine analysis can attribute timing differences to the hardware. None of this is
// derived from anything identifying — installId is a fresh random token persisted in
// localStorage, not a hash of the device.

import type { MachineMeta } from './stats.js';

const INSTALL_KEY = 'brm.installId';

function getInstallId(): string {
  try {
    const existing = localStorage.getItem(INSTALL_KEY);
    if (existing) return existing;
    const buf = new Uint32Array(4);
    crypto.getRandomValues(buf);
    const id = 'u_' + Array.from(buf, (x) => x.toString(36)).join('').slice(0, 16);
    localStorage.setItem(INSTALL_KEY, id);
    return id;
  } catch {
    // private mode / storage disabled: a non-persisted id still tags this session's runs
    const buf = new Uint32Array(4);
    crypto.getRandomValues(buf);
    return 'u_' + Array.from(buf, (x) => x.toString(36)).join('').slice(0, 16);
  }
}

// Effective performance.now() resolution: browsers clamp it (commonly 100µs in Chromium,
// coarser in Firefox) unless the page is cross-origin isolated. Estimate it as the smallest
// nonzero delta over a burst of samples, so the analyzer can flag machines where rollover
// timing (tens of ms) is near the noise floor.
function measureTimePrecision(): number {
  let min = Infinity;
  let prev = performance.now();
  for (let i = 0; i < 1000; i++) {
    const now = performance.now();
    const d = now - prev;
    if (d > 0 && d < min) min = d;
    prev = now;
  }
  return Number.isFinite(min) ? Math.round(min * 1000) / 1000 : 0;
}

// Median frame interval over ~30 rAF ticks → refresh rate. Resolves a promise so startup
// isn't blocked; a 60 s run finishes long after this settles.
function measureRefreshHz(): Promise<number> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let last = -1;
    const tick = (t: number): void => {
      if (last >= 0) deltas.push(t - last);
      last = t;
      if (deltas.length < 30) {
        requestAnimationFrame(tick);
      } else {
        deltas.sort((a, b) => a - b);
        const med = deltas[deltas.length >> 1] || 16.67;
        resolve(Math.round(1000 / med));
      }
    };
    requestAnimationFrame(tick);
  });
}

// Kick the async refresh measurement immediately; resolve the full record once it lands.
export function probeMachine(): Promise<MachineMeta> {
  const nav = navigator as Navigator & { platform?: string };
  const base = {
    installId: getInstallId(),
    label: '', // filled from config at log-build time
    ua: nav.userAgent,
    platform: nav.platform ?? 'unknown',
    hardwareConcurrency: nav.hardwareConcurrency ?? 0,
    timeOriginPrecisionMs: measureTimePrecision(),
  };
  return measureRefreshHz().then((hz) => ({ ...base, estimatedRefreshHz: hz }));
}

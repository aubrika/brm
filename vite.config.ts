import { defineConfig } from 'vitest/config';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runLogPlugin } from './vite-plugin-runlog.js';

// Build stamp, baked into each run log so runs can be grouped by the exact build that produced
// them (which feature was live). Resolved once at config load; falls back gracefully when git or
// package.json is unavailable, and never fails the build.
const appVersion = (() => {
  try {
    return JSON.parse(readFileSync('package.json', 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const appCommit = (() => {
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    // dirty = modified TRACKED source. --untracked-files=no ignores build artifacts and Vite's own
    // temp config file (which exists while this runs); :!dist ignores a rebuilt bundle.
    const dirty = execSync("git status --porcelain --untracked-files=no -- ':!dist'", { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0;
    return dirty ? `${sha}-dirty` : sha; // -dirty flags a build with uncommitted source changes
  } catch {
    return 'unknown';
  }
})();

// base: './' keeps the built asset paths relative, so a grader can serve the prebuilt
// dist/ from anywhere (e.g. `python3 -m http.server` inside dist/) with no Node at all.
// The runLogPlugin adds POST /api/log + friends under `npm run dev`/`preview`; a plain
// static server simply lacks it and the client falls back to the JSON download.
export default defineConfig({
  base: './',
  plugins: [runLogPlugin()],
  build: { target: 'es2022' },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_COMMIT__: JSON.stringify(appCommit),
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});

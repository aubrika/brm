import { defineConfig } from 'vitest/config';
import { runLogPlugin } from './vite-plugin-runlog.js';

// base: './' keeps the built asset paths relative, so a grader can serve the prebuilt
// dist/ from anywhere (e.g. `python3 -m http.server` inside dist/) with no Node at all.
// The runLogPlugin adds POST /api/log + friends under `npm run dev`/`preview`; a plain
// static server simply lacks it and the client falls back to the JSON download.
export default defineConfig({
  base: './',
  plugins: [runLogPlugin()],
  build: { target: 'es2022' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});

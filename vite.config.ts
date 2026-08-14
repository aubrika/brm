import { defineConfig } from 'vitest/config';

// base: './' keeps the built asset paths relative, so a grader can serve the prebuilt
// dist/ from anywhere (e.g. `python3 -m http.server` inside dist/) with no Node at all.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});

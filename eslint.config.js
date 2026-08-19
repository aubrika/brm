// Lint config. Deliberately small: tsconfig.json already does the heavy lifting (strict,
// noUnusedLocals, noUnusedParameters, noImplicitReturns, noFallthroughCasesInSwitch), so this only
// adds the rules a type checker cannot see — the type-aware ones about promises and unsafe casts,
// which are the failure modes that actually bite in an app with a rAF loop and three fetch calls.
//
// Style is not linted and there is no formatter. The codebase is one author's and consistent; a
// formatter run now would rewrite every file and bury the history this project's commits carry.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'logs/**', 'node_modules/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // A floating promise in a game loop is a run that silently stops. postLog/fetchIndex are
      // deliberately fire-and-forget and are marked with `void` at the call site.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // The log is parsed from JSON, so a few `any`-shaped reads are unavoidable at the boundary;
      // warn rather than error so they stay visible without blocking the build.
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // tsconfig's noUnusedLocals already covers this and reports it better.
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    // The stats core and the analyzer are plain ESM JS on purpose — Node imports them with no build
    // step — so the type-aware rules have nothing to work with there.
    files: ['**/*.mjs', '**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
);

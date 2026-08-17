#!/usr/bin/env bash
# Deploy to GitHub Pages with CORRECT build provenance.
#
# Why this exists: every run log carries the commit it was produced by (`meta.commit`), and
# analyze.mjs [9] groups results by build. Building *before* committing — the obvious order —
# stamps the bundle with the PREVIOUS commit and marks it `-dirty`, because at build time HEAD is
# still the old commit and the source tree is modified. That silently mislabels every run.
#
# So the order here is: commit the SOURCE first, then build (HEAD is now correct, and the dirty
# check ignores dist/), then commit the dist as its own commit. The bundle therefore reports the
# exact commit whose source produced it.
#
#   usage:  scripts/deploy.sh "commit message"
set -euo pipefail
cd "$(dirname "$0")/.."

MSG="${1:-}"
if [ -z "$MSG" ]; then echo "usage: scripts/deploy.sh \"commit message\"" >&2; exit 1; fi

# 1. commit source only (dist is added in step 3). Note we do NOT exclude logs/: the run data
# there is already gitignored, while logs/README.md is tracked documentation — excluding it would
# leave the tree dirty at build time and stamp the bundle `-dirty` for no reason.
git add -A -- ':!dist'
if ! git diff --cached --quiet; then
  git commit -q -m "$MSG"
  echo "committed source: $(git rev-parse --short HEAD)"
else
  echo "no source changes to commit; deploying at $(git rev-parse --short HEAD)"
fi

# 2. build — HEAD is now the source commit, and vite's dirty check excludes dist/
npm run build

STAMP=$(git rev-parse --short HEAD)
echo "built at $STAMP; bundle reports: $(grep -ohE '"[0-9a-f]{7,8}(-dirty)?"' dist/assets/*.js | head -1)"

# 3. commit the built artifact separately, so its own stamp stays valid
git add dist
if ! git diff --cached --quiet; then git commit -q -m "build: dist at $STAMP"; fi

# 4. push source + publish dist/ (which contains v1/) to gh-pages
git push -q origin HEAD
git push -q origin "$(git subtree split --prefix dist HEAD)":refs/heads/gh-pages --force
echo "deployed → https://aubrika.github.io/brm/  (v1 → /brm/v1/)"

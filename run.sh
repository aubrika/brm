#!/usr/bin/env bash
set -euo pipefail

# Launch the game. Requires Node 18+ (for Vite). If you have no Node toolchain, a
# prebuilt dist/ is committed — see the README for the zero-Node path:
#   python3 -m http.server 8000   # run from inside dist/
command -v node >/dev/null || { echo "Node 18+ required: https://nodejs.org  (or use the zero-Node path in README_V2.md)"; exit 1; }

npm ci --silent
npm run build
npm run preview -- --open

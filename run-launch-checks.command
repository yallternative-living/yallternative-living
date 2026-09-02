#!/bin/bash
# Y'allternative Living -- full local launch check.
#
# Runs every gate CI runs, in the same order CI runs them: the fast smoke
# gate, the unit pool plus the static QA gate, lint, formatting, the browser
# integration suites across viewports, and the Playwright cross-browser run.
#
# The last two need a real Chrome (and, for cross-browser, Firefox and WebKit)
# plus disk space, which is why they can't run in a sandboxed environment --
# this file exists so they run here instead, on your machine. If the
# cross-browser step reports missing engines, install them once with:
#   npx playwright install --with-deps chromium firefox webkit
#
# Double-click this file in Finder, or run from Terminal:
#   bash run-launch-checks.command

cd "$(dirname "$0")" || exit 1

echo "Y'allternative Living -- local launch check"
echo "============================================"

if [ ! -d node_modules ]; then
  echo
  echo "node_modules not found -- running npm install first..."
  npm install || { echo "npm install failed. Fix that before continuing."; exit 1; }
fi

FAILED=0

run_step() {
  local name="$1"
  shift
  echo
  echo "-- $name --"
  if "$@"; then
    echo "PASS: $name"
  else
    echo "FAIL: $name"
    FAILED=$((FAILED + 1))
  fi
}

run_step "Fast smoke gate (npm run test:smoke)" npm run test:smoke
run_step "Static QA + unit tests (npm test)" npm test
run_step "Lint (npm run lint)" npm run lint
run_step "Format check (npm run format:check)" npm run format:check
run_step "Browser integration tests, all viewports (npm run test:integration)" npm run test:integration
run_step "Cross-browser tests, Chromium/Firefox/WebKit (npm run test:cross-browser)" npm run test:cross-browser

echo
echo "============================================"
if [ "$FAILED" -eq 0 ]; then
  echo "All checks passed. Safe to commit and push."
else
  echo "$FAILED check group(s) failed -- scroll up for details before pushing."
fi
echo "============================================"

# Keep the window open when double-clicked from Finder, so the summary
# above doesn't vanish the instant the script finishes.
read -n 1 -s -r -p "Press any key to close this window..."
echo

exit "$FAILED"

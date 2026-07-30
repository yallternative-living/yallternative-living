#!/bin/bash
# Y'allternative Living -- full local launch check.
#
# Runs everything that verifies the site before a push: static QA + unit
# tests (303+ checks, including the Stripe Tax and market-pickup logic in
# workers/checkout.js), lint, formatting, and the Puppeteer browser tests
# across viewports. The last one needs a real Chrome + disk space, which
# is why it can't run in a sandboxed environment -- this file exists so it
# runs here instead, on your machine.
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

run_step "Static QA + unit tests (npm test)" npm test
run_step "Lint (npm run lint)" npm run lint
run_step "Format check (npm run format:check)" npm run format:check
run_step "Browser integration tests, all viewports (npm run test:integration)" npm run test:integration

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

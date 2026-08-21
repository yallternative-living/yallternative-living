/**
 * @fileoverview Runs every scripts/*.test.js unit suite in one shot and
 * aggregates the results.
 *
 * These suites cover cart pricing, the Cloudflare Worker's checkout/tax/
 * gift-card math, the build-data compiler, main.js behaviour, the social-feed
 * sync, and the translator.
 *
 * qa-check.js used to run them itself, but through execSync with
 * stdio:"pipe", collapsing each suite to one ✓/✗ and truncating any error to
 * its first line -- a missing dependency reported itself as
 * "node:internal/modules/cjs/loader:1386", which names neither the module nor
 * the suite's own assertions. This runner inherits stdio instead, so a
 * failure tells you what actually broke, and it discovers suites by scanning
 * the directory rather than hard-coding seven paths that a new test file
 * would silently miss.
 *
 * Every suite runs even when an earlier one fails -- one broken file should
 * still report the state of the rest, not hide it.
 *
 * Run: node scripts/run-unit-tests.js
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPTS_DIR = __dirname;

const suites = fs
  .readdirSync(SCRIPTS_DIR)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

if (!suites.length) {
  console.error("No *.test.js suites found in scripts/ -- did they get moved or deleted?");
  process.exit(1);
}

const failures = [];

suites.forEach((file) => {
  console.log(`\n--- ${file} ---`);
  const run = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, file)], {
    stdio: "inherit",
    cwd: path.resolve(SCRIPTS_DIR, "..")
  });
  // A suite killed by a signal (or one that never started) has a null status;
  // treat that as a failure rather than silently counting it as a pass.
  if (run.status !== 0) {
    failures.push(`${file}${run.signal ? ` (killed by ${run.signal})` : ` (exit ${run.status})`}`);
  }
});

console.log("\n==================================================");
if (failures.length) {
  console.log(`Unit suites: ${suites.length - failures.length}/${suites.length} passed.`);
  failures.forEach((f) => console.log(`  ✗ ${f}`));
  console.log("==================================================");
  process.exit(1);
}
console.log(`Unit suites: ${suites.length}/${suites.length} passed.`);
console.log("==================================================");

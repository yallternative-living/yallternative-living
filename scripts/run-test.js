/**
 * @fileoverview `npm test` orchestrator.
 *
 * Runs the unit pool and the static QA gate and exits non-zero if EITHER
 * failed. The npm script used to be `run-unit-tests.js && qa-check.js`, so a
 * single broken unit suite meant the 700-assertion QA gate never ran at all --
 * during the 2026-09-01 audit `npm test` was red and nobody could tell whether
 * the static gate was green, because it had not executed (audit H-16).
 *
 * Written in Node rather than shell so it behaves the same on cmd.exe,
 * PowerShell and POSIX shells.
 *
 * Run: node scripts/run-test.js  (or: npm test)
 */

const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPTS_DIR = __dirname;
const ROOT_DIR = path.resolve(SCRIPTS_DIR, "..");

const GATES = [
  { name: "Unit suites", script: "run-unit-tests.js" },
  { name: "Static QA gate", script: "qa-check.js" }
];

const results = GATES.map((gate) => {
  console.log(`\n########## ${gate.name} (scripts/${gate.script}) ##########\n`);
  const res = spawnSync(process.execPath, [path.join(SCRIPTS_DIR, gate.script)], {
    cwd: ROOT_DIR,
    stdio: "inherit",
    env: process.env
  });
  const status = res.status === null ? 1 : res.status;
  return { ...gate, status, signal: res.signal };
});

console.log("\n##################################################");
results.forEach((r) => {
  const detail = r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
  console.log(`  ${r.status === 0 && !r.signal ? "✓" : "✗"} ${r.name} (${detail})`);
});
console.log("##################################################");

const failed = results.some((r) => r.status !== 0 || r.signal);
process.exit(failed ? 1 : 0);

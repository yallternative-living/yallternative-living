/**
 * @fileoverview Unit test suite for the High-Speed Smoke Test runner (scripts/smoke-test.js).
 *
 * Verifies:
 *   1. scripts/smoke-test.js executes and exits cleanly with code 0 on healthy repository.
 *   2. Smoke test completes strictly within the < 3000ms performance SLA budget.
 *   3. All 4 verification stages (Build, Cart Math, Worker Checkout, Static QA) execute and log diagnostic headers.
 *   4. Failure trapping really traps: a copy of the repository with one input
 *      broken makes smoke-test.js exit 1 with a diagnostic naming the problem.
 *
 * (4) used to be a comment and an assertion that stdout was a non-empty string
 * -- the suite only ever ran the happy path, so a smoke test that had stopped
 * failing on broken input would still have looked green (audit H-19).
 *
 * Run: node scripts/smoke-test.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SMOKE_TEST_SCRIPT = path.join(__dirname, "smoke-test.js");

let passed = 0;
let failed = 0;

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`);
  }
}

function assert(condition, label, detail) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

console.log("Running smoke-test.js unit verification suite...\n");

// Test 1: Clean execution of smoke-test.js
const startTime = Date.now();
const result = spawnSync(process.execPath, [SMOKE_TEST_SCRIPT], {
  cwd: ROOT,
  encoding: "utf8",
  env: process.env
});
const durationMs = Date.now() - startTime;

eq(result.status, 0, "smoke-test.js exits with status code 0 on clean repository");

// Test 2: Performance SLA (< 3000ms)
assert(
  durationMs < 3000,
  `smoke-test.js execution time meets < 3000ms SLA budget (${durationMs}ms)`,
  `Actual duration was ${durationMs}ms`
);

// Test 3: Output contains all 4 stages
const stdout = result.stdout || "";
assert(stdout.includes("STAGE 1: Site Data Build & Compiler"), "Output includes Stage 1 header");
assert(stdout.includes("STAGE 2: Pure Cart Math Engine"), "Output includes Stage 2 header");
assert(
  stdout.includes("STAGE 3: Cloudflare Worker Checkout Logic"),
  "Output includes Stage 3 header"
);
assert(
  stdout.includes("STAGE 4: High-Speed In-Process Static QA Assertions"),
  "Output includes Stage 4 header"
);
assert(stdout.includes("Performance SLA met"), "Output reports Performance SLA met");
assert(
  stdout.includes("All smoke test stages passed cleanly!"),
  "Output reports all stages passed cleanly"
);

assert(
  typeof result.stdout === "string" && result.stdout.length > 0,
  "smoke-test.js emits detailed diagnostic output to stdout"
);

// Test 4: Negative control -- the gate actually fails on broken input.
//
// Copy the working tree (minus node_modules/.git) into a scratch directory,
// truncate _headers so the site CSP disappears, and run the same script there.
// A smoke test that cannot go red is not a gate.
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yl-smoke-negative-"));
try {
  fs.cpSync(ROOT, scratchRoot, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== "node_modules" && base !== ".git";
    }
  });

  const scratchHeaders = path.join(scratchRoot, "_headers");
  assert(fs.existsSync(scratchHeaders), "scratch copy contains _headers to break");
  fs.writeFileSync(scratchHeaders, "");

  const broken = spawnSync(process.execPath, [path.join(scratchRoot, "scripts", "smoke-test.js")], {
    cwd: scratchRoot,
    encoding: "utf8",
    env: process.env
  });
  const brokenOutput = (broken.stdout || "") + (broken.stderr || "");

  eq(broken.status, 1, "smoke-test.js exits 1 when _headers has been emptied");
  assert(
    /Content-Security-Policy/i.test(brokenOutput),
    "failure output names the broken subject (Content-Security-Policy)",
    `output was: ${brokenOutput.slice(-400)}`
  );
  assert(
    /SMOKE TEST FAILED|✗/.test(brokenOutput),
    "failure output is an actionable diagnostic, not a silent non-zero exit"
  );
} finally {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
}

console.log("\n==================================================");
console.log(
  `smoke-test.test.js: ${passed} passed, ${failed} failed in ${(durationMs / 1000).toFixed(3)}s`
);
console.log("==================================================");

if (failed > 0) {
  process.exit(1);
}
process.exit(0);

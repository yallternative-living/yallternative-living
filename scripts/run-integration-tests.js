/**
 * @fileoverview Runs all integration test suites across isolated local server ports
 * in parallel using a worker pool and aggregates the results.
 *
 * Two sets of suites run concurrently:
 *
 * 1. A fixed list of browser gates that are not named `*.test.js`:
 *    - puppeteer_tests.js (port 8082)
 *    - extended_qa_test.js (port 8083)
 *    - a11y-check.js (port 8084)
 *    - test-m2-ugc-strip.js (port 8085)
 *    - security_stress_test.js (port 8086)
 *    - reveal-check.js (port 8087)
 *
 * 2. Every `scripts/*.browser.test.js`, discovered by glob. That suffix is the
 *    contract: a suite that drives Puppeteer or Playwright carries it and is
 *    therefore excluded from the Node-only unit pool (run-unit-tests.js) and
 *    from the CI `qa` job, which sets PUPPETEER_SKIP_DOWNLOAD. Audit H-16/H-17.
 *
 * A suite in the fixed list that no longer exists is a hard failure, not a
 * silent skip -- the previous `.filter(existsSync)` meant deleting a gate made
 * the board greener (audit H-19).
 *
 * Output is buffered per suite so logs remain clean, readable, and non-interleaved.
 *
 * Run: node scripts/run-integration-tests.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const SCRIPTS_DIR = __dirname;
const ROOT_DIR = path.resolve(SCRIPTS_DIR, "..");

const FIXED_SUITES = [
  "puppeteer_tests.js",
  "extended_qa_test.js",
  "security_stress_test.js",
  "test-m2-ugc-strip.js",
  "reveal-check.js",
  "a11y-check.js"
];

const missing = FIXED_SUITES.filter((f) => !fs.existsSync(path.join(SCRIPTS_DIR, f)));
if (missing.length) {
  missing.forEach((f) =>
    console.error(
      `Integration suite scripts/${f} is listed in run-integration-tests.js but does not exist.`
    )
  );
  console.error("Refusing to report a pass on a gate that silently vanished.");
  process.exit(1);
}

const browserSuites = fs
  .readdirSync(SCRIPTS_DIR)
  .filter((f) => f.endsWith(".browser.test.js"))
  .sort();

if (!browserSuites.length) {
  console.error(
    "No scripts/*.browser.test.js suites found -- the browser-driven suites were renamed or deleted."
  );
  process.exit(1);
}

const suites = FIXED_SUITES.concat(browserSuites);

const maxWorkers = Math.max(1, Math.min(os.cpus() ? os.cpus().length : 4, suites.length));
console.log(
  `Running ${suites.length} integration test suites in parallel across ${maxWorkers} workers...\n`
);

function runSuite(file) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, file)], {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("close", (status, signal) => {
      const durationMs = Date.now() - startTime;
      resolve({
        file,
        status,
        signal,
        durationMs,
        stdout,
        stderr,
        ok: status === 0 && !signal
      });
    });

    child.on("error", (err) => {
      const durationMs = Date.now() - startTime;
      resolve({
        file,
        status: 1,
        signal: null,
        durationMs,
        stdout,
        stderr: stderr + "\n" + err.stack,
        ok: false
      });
    });
  });
}

(async () => {
  const queue = [...suites];
  const results = [];
  const failures = [];

  // Worker pool
  async function worker() {
    while (queue.length > 0) {
      const file = queue.shift();
      const res = await runSuite(file);
      results.push(res);

      console.log(`\n==================================================`);
      console.log(`--- ${res.file} (${(res.durationMs / 1000).toFixed(2)}s) ---`);
      console.log(`==================================================`);
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
      if (!res.stdout.endsWith("\n") && !res.stderr.endsWith("\n")) {
        console.log();
      }

      if (!res.ok) {
        failures.push(
          `${res.file}${res.signal ? ` (killed by ${res.signal})` : ` (exit ${res.status})`}`
        );
      }
    }
  }

  const workers = Array.from({ length: maxWorkers }, () => worker());
  await Promise.all(workers);

  console.log("\n" + "=".repeat(50));
  if (failures.length) {
    console.log(
      `Integration test suites: ${suites.length - failures.length}/${suites.length} passed.`
    );
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    console.log("=".repeat(50));
    process.exit(1);
  }
  console.log(`Integration test suites: ${suites.length}/${suites.length} passed.`);
  console.log("=".repeat(50));
  process.exit(0);
})().catch((err) => {
  console.error("Integration test runner crashed:", err);
  process.exit(1);
});

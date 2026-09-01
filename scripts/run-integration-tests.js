/**
 * @fileoverview Runs all integration test suites across isolated local server ports
 * in parallel using a worker pool and aggregates the results.
 *
 * Suites run concurrently:
 * - puppeteer_tests.js (port 8082)
 * - extended_qa_test.js (port 8083)
 * - a11y-check.js (port 8084)
 * - test-m2-ugc-strip.js (port 8085)
 * - security_stress_test.js (port 8086)
 * - reveal-check.js (port 8087)
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

const suites = [
  "puppeteer_tests.js",
  "extended_qa_test.js",
  "security_stress_test.js",
  "test-m2-ugc-strip.js",
  "reveal-check.js",
  "a11y-check.js"
].filter((f) => fs.existsSync(path.join(SCRIPTS_DIR, f)));

if (!suites.length) {
  console.error("No integration test suites found in scripts/!");
  process.exit(1);
}

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

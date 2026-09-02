/**
 * @fileoverview Runs every Node-only scripts/*.test.js unit suite across a
 * parallel worker pool and aggregates the results.
 *
 * These suites cover cart pricing, the Cloudflare Worker's checkout/tax/
 * gift-card math, the build-data compiler, main.js behaviour, the social-feed
 * sync, global search, and the translator.
 *
 * SCOPE: `*.browser.test.js` is deliberately excluded. Those suites drive a
 * real Chromium (Puppeteer) or all three Playwright engines, so they belong to
 * `scripts/run-integration-tests.js` and the CI `browser` job that installs
 * the engines -- not to this pool, which the CI `qa` job runs with
 * PUPPETEER_SKIP_DOWNLOAD set. Seven browser-driven suites used to be globbed
 * in here, which is why the `qa` job could not pass (audit H-16/H-17).
 *
 * Suites are run concurrently across CPU cores using a worker pool.
 * Output is cleanly buffered per test suite and printed on completion so
 * log messages never interleave, and exit codes accurately reflect failures.
 *
 * Every suite runs even when an earlier one fails -- one broken file should
 * still report the state of the rest, not hide it.
 *
 * Run: node scripts/run-unit-tests.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const SCRIPTS_DIR = __dirname;
const ROOT_DIR = path.resolve(SCRIPTS_DIR, "..");

/**
 * Node-only gates that predate the `*.test.js` convention and were therefore
 * referenced by nothing (audit H-19: ~126 KB of tests wired into no npm
 * script). They run sequentially after the pool because
 * verify-build-reproducibility.js shells out to the site build six times and
 * must not race the suites that read generated files.
 */
const FIXED_GATES = [
  // smoke-test.test.js spawns scripts/smoke-test.js, whose first stage runs the
  // real build-site-data.js against the live tree. Inside the parallel pool
  // that rewrote every top-level page (twice: footer injection, then the
  // global-config pass) while the other suites were reading them, and any
  // suite that read thank-you.html between the two writes failed on copy
  // that was mid-rewrite (worker-retention's footer-form assertion, found
  // 2026-09-02). It runs here, after the pool, for the same reason
  // verify-build-reproducibility.js does.
  "smoke-test.test.js",
  // Same hazard, found the same way (2026-09-02 live-audit fix pass): this one
  // calls buildScript.buildSiteData() in-process rather than spawning
  // scripts/smoke-test.js, so the grep that caught smoke-test.test.js -- for
  // suites that shell out -- missed it. It is the same full site build,
  // rewriting every top-level page twice while the pool reads them, and it is
  // what made worker-retention.test.js's footer-form assertion fail
  // intermittently: it read thank-you.html in the window after the footer
  // block was injected and before the kitFormAction marker was resolved. Any
  // future suite that runs the real build belongs on this list, whether it
  // spawns it or requires it.
  "m1-compilation-challenger.test.js",
  "verify-pdp-metadata.js",
  // Red until the build stops stamping wall-clock time into feed.xml's
  // <lastBuildDate> and sw.js's CACHE_NAME (audit H-20, owned by the build
  // agent). Wired in anyway: a gate that is red for a known reason is worth
  // more than one nobody runs. It also rewrites the generated files as a side
  // effect, so the tree is dirty after a run until that fix lands.
  "verify-build-reproducibility.js"
];

const suites = fs
  .readdirSync(SCRIPTS_DIR)
  .filter(
    (f) =>
      f.endsWith(".test.js") && !f.endsWith(".browser.test.js") && FIXED_GATES.indexOf(f) === -1
  )
  .sort();

if (!suites.length) {
  console.error("No *.test.js suites found in scripts/ -- did they get moved or deleted?");
  process.exit(1);
}

const missingGates = FIXED_GATES.filter((f) => !fs.existsSync(path.join(SCRIPTS_DIR, f)));
if (missingGates.length) {
  missingGates.forEach((f) =>
    console.error(`Unit gate scripts/${f} is listed in run-unit-tests.js but does not exist.`)
  );
  console.error("Refusing to report a pass on a gate that silently vanished.");
  process.exit(1);
}

const maxWorkers = Math.max(1, Math.min(os.cpus() ? os.cpus().length : 4, suites.length));
console.log(
  `Running ${suites.length} unit test suites in parallel across ${maxWorkers} workers, ` +
    `then ${FIXED_GATES.length} Node-only gates sequentially...\n`
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

      console.log(`--- ${res.file} (${(res.durationMs / 1000).toFixed(2)}s) ---`);
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

  // Sequential Node-only gates. They are not `*.test.js` and are run last so
  // the build-driving one cannot race the pool.
  for (const file of FIXED_GATES) {
    const res = await runSuite(file);
    results.push(res);
    console.log(`--- ${res.file} (${(res.durationMs / 1000).toFixed(2)}s) ---`);
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    if (!res.ok) {
      failures.push(
        `${res.file}${res.signal ? ` (killed by ${res.signal})` : ` (exit ${res.status})`}`
      );
    }
  }

  const total = suites.length + FIXED_GATES.length;
  console.log("\n==================================================");
  if (failures.length) {
    console.log(`Unit suites: ${total - failures.length}/${total} passed.`);
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    if (failures.some((f) => f.startsWith("verify-build-reproducibility.js"))) {
      console.log(
        "  note: verify-build-reproducibility.js fails while the build stamps wall-clock\n" +
          "        time into feed.xml <lastBuildDate> and sw.js CACHE_NAME (audit H-20)."
      );
    }
    console.log("==================================================");
    process.exit(1);
  }
  console.log(`Unit suites: ${total}/${total} passed.`);
  console.log("==================================================");
  process.exit(0);
})().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});

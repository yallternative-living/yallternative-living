/**
 * @fileoverview Unit tests for workers/routes/http.js helpers.
 *
 * clientIp() picks the rate-limit bucket for every public Worker route. The
 * 2026-09-09 audit found it read the FIRST X-Forwarded-For entry -- the one a
 * caller writes -- so every per-IP limit was a limit per string the caller
 * chose. These pin the hop that is trusted now.
 *
 * Run: node scripts/worker-http.test.js
 */

let passed = 0;
let failed = 0;

function eq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
  } else {
    failed++;
    console.error(
      `  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`
    );
  }
}

function req(headers) {
  return new Request("https://example.test/api/order-status", { method: "POST", headers });
}

async function runWorkerHttpTests() {
  const { clientIp } = await import("../workers/routes/http.js");

  // Through Netlify: Netlify appends the shopper, Cloudflare appends Netlify.
  eq(
    clientIp(
      req({ "X-Forwarded-For": "203.0.113.5, 198.51.100.20", "CF-Connecting-IP": "198.51.100.20" })
    ),
    "203.0.113.5",
    "the entry before Cloudflare's own append is the client"
  );
  eq(
    clientIp(
      req({
        "X-Forwarded-For": "1.2.3.4, 203.0.113.5, 198.51.100.20",
        "CF-Connecting-IP": "198.51.100.20"
      })
    ),
    "203.0.113.5",
    "a caller-prepended entry is ignored in favour of the hop Netlify added"
  );
  eq(
    clientIp(
      req({
        "X-Forwarded-For": "   1.2.3.4 ,203.0.113.5 , 198.51.100.20 ",
        "CF-Connecting-IP": "198.51.100.20"
      })
    ),
    "203.0.113.5",
    "whitespace around entries does not matter"
  );

  // Direct to the Cloudflare route: nothing left after the strip, so the
  // address Cloudflare itself saw is the key.
  eq(
    clientIp(req({ "X-Forwarded-For": "203.0.113.5", "CF-Connecting-IP": "203.0.113.5" })),
    "203.0.113.5",
    "direct traffic keys on CF-Connecting-IP"
  );
  eq(clientIp(req({ "CF-Connecting-IP": "203.0.113.5" })), "203.0.113.5", "...with no XFF at all");

  // No Cloudflare header (unit tests, local dev): the last XFF entry.
  eq(clientIp(req({ "X-Forwarded-For": "203.0.113.5" })), "203.0.113.5", "single XFF entry");
  eq(
    clientIp(req({ "X-Forwarded-For": "1.2.3.4, 203.0.113.5" })),
    "203.0.113.5",
    "last XFF entry without a Cloudflare header"
  );
  eq(clientIp(req({})), "unknown", "nothing at all is 'unknown', never empty");

  // Oversized entries cannot be used as a key.
  const long = "x".repeat(60);
  eq(
    clientIp(
      req({ "X-Forwarded-For": `${long}, 203.0.113.5`, "CF-Connecting-IP": "198.51.100.20" })
    ),
    "203.0.113.5",
    "an over-long entry is skipped"
  );
  eq(
    clientIp(req({ "X-Forwarded-For": long, "CF-Connecting-IP": "198.51.100.20" })),
    "198.51.100.20",
    "...and only over-long entries fall back to CF-Connecting-IP"
  );

  console.log(`\nworker-http.test.js: ${passed} passed, ${failed} failed`);
  if (require.main === module) process.exit(failed ? 1 : 0);
  return { passed, failed };
}

if (require.main === module) {
  runWorkerHttpTests().catch((err) => {
    console.error("Worker http test suite error:", err);
    process.exit(1);
  });
}

module.exports = { runWorkerHttpTests };

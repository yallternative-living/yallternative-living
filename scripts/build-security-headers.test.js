/**
 * @fileoverview Unit tests for build-security-headers logic
 * Run: node scripts/build-security-headers.test.js
 */

const { extractInlineScripts } = require("./build-security-headers.js");

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

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
} else {
  console.log(`\nAll ${passed} test(s) passed.`);
}

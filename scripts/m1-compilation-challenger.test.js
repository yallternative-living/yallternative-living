/**
 * @fileoverview Adversarial Challenge & Stress Suite for Milestone 1
 * Data Compilation, Schema Validation, and Sanitization Pipeline.
 *
 * Covers:
 * 1. validateQuizData() stress testing across edge cases & referential integrity.
 * 2. renderSocialRowHtml() and getActiveSocialUrls() fuzzing against malicious URLs & injection vectors.
 * 3. build-site-data.js robustness under missing / partially undefined content.json.site fields.
 *
 * Run: node scripts/m1-compilation-challenger.test.js
 */

const assert = require("assert");
const buildScript = require("./build-site-data.js");

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failedTests++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.stack || err.message}`);
  }
}

console.log("===================================================================");
console.log("   MILESTONE 1 DATA COMPILATION & VALIDATION ADVERSARIAL SUITE     ");
console.log("===================================================================\n");

// ---------------------------------------------------------------------------
// 1. validateQuizData() Adversarial & Boundary Stress Tests
// ---------------------------------------------------------------------------
console.log("--- 1. validateQuizData() Boundary & Integrity Tests ---");

const mockProductsMap = {
  "sleep-salve": { id: "sleep-salve", name: "Sleep Salve", price: 16 },
  "lavender-soak": { id: "lavender-soak", name: "Lavender Soak", price: 14 },
  "body-butter": { id: "body-butter", name: "Whipped Body Butter", price: 20 }
};

const mockCategoriesMap = {
  salves: { id: "salves", label: "Botanical Salves" },
  soaks: { id: "soaks", label: "Mineral Bath Soaks" },
  body: { id: "body", label: "Body Care" }
};

const mockBundlesMap = {
  "bundle-sleep-kit": { id: "bundle-sleep-kit", name: "Sleep Kit Bundle" },
  "bundle-bath-set": { id: "bundle-bath-set", name: "Bath Set" }
};

// 1.1 Null / Undefined / Empty Quiz
runTest("validateQuizData accepts null quiz gracefully", () => {
  assert.strictEqual(
    buildScript.validateQuizData(null, mockProductsMap, mockCategoriesMap, mockBundlesMap),
    true
  );
});

runTest("validateQuizData accepts undefined quiz gracefully", () => {
  assert.strictEqual(
    buildScript.validateQuizData(undefined, mockProductsMap, mockCategoriesMap, mockBundlesMap),
    true
  );
});

runTest("validateQuizData accepts empty object quiz gracefully", () => {
  assert.strictEqual(
    buildScript.validateQuizData({}, mockProductsMap, mockCategoriesMap, mockBundlesMap),
    true
  );
});

runTest("validateQuizData accepts quiz with empty questions array", () => {
  assert.strictEqual(
    buildScript.validateQuizData(
      { questions: [] },
      mockProductsMap,
      mockCategoriesMap,
      mockBundlesMap
    ),
    true
  );
});

runTest("validateQuizData accepts quiz using steps alias with empty array", () => {
  assert.strictEqual(
    buildScript.validateQuizData({ steps: [] }, mockProductsMap, mockCategoriesMap, mockBundlesMap),
    true
  );
});

// 1.2 Invalid Question Structure
runTest("validateQuizData throws when questions is not an array (string)", () => {
  assert.throws(
    () => {
      buildScript.validateQuizData(
        { questions: "invalid-string" },
        mockProductsMap,
        mockCategoriesMap,
        mockBundlesMap
      );
    },
    { message: /Quiz questions must be an array/ }
  );
});

runTest("validateQuizData throws when questions is not an array (number)", () => {
  assert.throws(
    () => {
      buildScript.validateQuizData(
        { questions: 42 },
        mockProductsMap,
        mockCategoriesMap,
        mockBundlesMap
      );
    },
    { message: /Quiz questions must be an array/ }
  );
});

runTest("validateQuizData throws when a question element is null", () => {
  assert.throws(
    () => {
      buildScript.validateQuizData(
        { questions: [null] },
        mockProductsMap,
        mockCategoriesMap,
        mockBundlesMap
      );
    },
    { message: /Quiz question at index 0 must be an object/ }
  );
});

runTest("validateQuizData throws when a question element is a primitive string", () => {
  assert.throws(
    () => {
      buildScript.validateQuizData(
        { questions: ["not-an-object"] },
        mockProductsMap,
        mockCategoriesMap,
        mockBundlesMap
      );
    },
    { message: /Quiz question at index 0 must be an object/ }
  );
});

runTest("validateQuizData throws when question options is not an array", () => {
  assert.throws(
    () => {
      buildScript.validateQuizData(
        { questions: [{ id: "q1", options: "invalid-options" }] },
        mockProductsMap,
        mockCategoriesMap,
        mockBundlesMap
      );
    },
    { message: /Quiz question 'q1' options must be an array/ }
  );
});

runTest("validateQuizData throws when an option element is null", () => {
  assert.throws(
    () => {
      buildScript.validateQuizData(
        { questions: [{ id: "q1", options: [null] }] },
        mockProductsMap,
        mockCategoriesMap,
        mockBundlesMap
      );
    },
    { message: /Quiz question 'q1' option at index 0 must be an object/ }
  );
});

runTest("validateQuizData throws when an option element is a primitive", () => {
  assert.throws(
    () => {
      buildScript.validateQuizData(
        { questions: [{ id: "q1", options: [123] }] },
        mockProductsMap,
        mockCategoriesMap,
        mockBundlesMap
      );
    },
    { message: /Quiz question 'q1' option at index 0 must be an object/ }
  );
});

// 1.3 Product & Bundle Referential Integrity
runTest("validateQuizData passes when recommendedProductIds contains valid product ID", () => {
  const quiz = {
    questions: [
      {
        id: "q-vibe",
        options: [{ value: "calm", recommendedProductIds: ["sleep-salve"] }]
      }
    ]
  };
  assert.strictEqual(
    buildScript.validateQuizData(quiz, mockProductsMap, mockCategoriesMap, mockBundlesMap),
    true
  );
});

runTest("validateQuizData passes when recommendedProductIds contains valid bundle ID", () => {
  const quiz = {
    questions: [
      {
        id: "q-vibe",
        options: [{ value: "calm-bundle", recommendedProductIds: ["bundle-sleep-kit"] }]
      }
    ]
  };
  assert.strictEqual(
    buildScript.validateQuizData(quiz, mockProductsMap, mockCategoriesMap, mockBundlesMap),
    true
  );
});

runTest("validateQuizData passes with mixed product and bundle IDs", () => {
  const quiz = {
    questions: [
      {
        id: "q-vibe",
        options: [
          {
            value: "calm-mix",
            recommendedProductIds: ["sleep-salve", "bundle-sleep-kit", "lavender-soak"]
          }
        ]
      }
    ]
  };
  assert.strictEqual(
    buildScript.validateQuizData(quiz, mockProductsMap, mockCategoriesMap, mockBundlesMap),
    true
  );
});

runTest(
  "validateQuizData throws when recommendedProductIds contains non-existent product/bundle",
  () => {
    const quiz = {
      questions: [
        {
          id: "q-vibe",
          options: [{ value: "ghost", recommendedProductIds: ["phantom-potion"] }]
        }
      ]
    };
    assert.throws(
      () => {
        buildScript.validateQuizData(quiz, mockProductsMap, mockCategoriesMap, mockBundlesMap);
      },
      {
        message:
          /Quiz option 'ghost' in question 'q-vibe' references unknown product\/bundle ID: 'phantom-potion'/
      }
    );
  }
);

// 1.4 Category Referential Integrity
runTest("validateQuizData passes when categories contains valid category ID", () => {
  const quiz = {
    questions: [
      {
        id: "q-vibe",
        options: [{ value: "salve-lover", categories: ["salves", "soaks"] }]
      }
    ]
  };
  assert.strictEqual(
    buildScript.validateQuizData(quiz, mockProductsMap, mockCategoriesMap, mockBundlesMap),
    true
  );
});

runTest("validateQuizData throws when categories contains non-existent category ID", () => {
  const quiz = {
    questions: [
      {
        id: "q-vibe",
        options: [{ value: "ghost-cat", categories: ["unknown-category-id"] }]
      }
    ]
  };
  assert.throws(
    () => {
      buildScript.validateQuizData(quiz, mockProductsMap, mockCategoriesMap, mockBundlesMap);
    },
    {
      message:
        /Quiz option 'ghost-cat' in question 'q-vibe' references unknown category ID: 'unknown-category-id'/
    }
  );
});

runTest(
  "validateQuizData skips category checks when categoriesMap is empty or not supplied",
  () => {
    const quiz = {
      questions: [
        {
          id: "q-vibe",
          options: [{ value: "opt", categories: ["any-cat"] }]
        }
      ]
    };
    assert.strictEqual(
      buildScript.validateQuizData(quiz, mockProductsMap, {}, mockBundlesMap),
      true
    );
    assert.strictEqual(
      buildScript.validateQuizData(quiz, mockProductsMap, null, mockBundlesMap),
      true
    );
  }
);

// 1.5 Fallback ID & Non-Array Handling in Options
runTest(
  "validateQuizData uses question/option index fallback in error diagnostics when id/value are omitted",
  () => {
    const quiz = {
      questions: [
        {
          // omitted id
          options: [{ recommendedProductIds: ["missing-item-id"] }] // omitted value
        }
      ]
    };
    assert.throws(
      () => {
        buildScript.validateQuizData(quiz, mockProductsMap, mockCategoriesMap, mockBundlesMap);
      },
      {
        message:
          /Quiz option '0' in question '0' references unknown product\/bundle ID: 'missing-item-id'/
      }
    );
  }
);

runTest(
  "validateQuizData safely ignores non-array recommendedProductIds or categories without crashing",
  () => {
    const quiz = {
      questions: [
        {
          id: "q1",
          options: [
            {
              value: "opt1",
              recommendedProductIds: "sleep-salve", // string instead of array
              categories: null // null instead of array
            }
          ]
        }
      ]
    };
    assert.strictEqual(
      buildScript.validateQuizData(quiz, mockProductsMap, mockCategoriesMap, mockBundlesMap),
      true
    );
  }
);

// ---------------------------------------------------------------------------
// 2. renderSocialRowHtml() and getActiveSocialUrls() Adversarial Fuzzing
// ---------------------------------------------------------------------------
console.log("\n--- 2. Social Media Row & URL Sanitization Fuzzing Tests ---");

const maliciousUrls = [
  { name: "javascript:alert(1)", url: "javascript:alert(1)" },
  { name: "javascript:alert('XSS')", url: "javascript:alert('XSS')" },
  { name: "javascript:void(0)", url: "javascript:void(0)" },
  { name: "JAVASCRIPT:alert(1) (uppercase scheme)", url: "JAVASCRIPT:alert(1)" },
  { name: "JavaScript:alert(document.cookie)", url: "JavaScript:alert(document.cookie)" },
  { name: "newline preceding javascript: URL", url: "\njavascript:alert(1)" },
  { name: "tab preceding javascript: URL", url: "\tjavascript:alert(1)" },
  { name: "vbscript:msgbox(1)", url: "vbscript:msgbox(1)" },
  { name: "VBSCRIPT:msgbox(1)", url: "VBSCRIPT:msgbox(1)" },
  {
    name: "data:text/html,<script>alert(1)</script>",
    url: "data:text/html,<script>alert(1)</script>"
  },
  {
    name: "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    url: "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="
  },
  { name: "blob:https://example.com/uuid", url: "blob:https://example.com/uuid" },
  { name: "file:///etc/passwd", url: "file:///etc/passwd" },
  { name: "whitespace-only URL", url: "    \t\r\n   " },
  { name: "empty string URL", url: "" },
  { name: "document-relative URL (events.html)", url: "events.html" },
  { name: "fullwidth unicode scheme (ｊavascript:alert(1))", url: "ｊavascript:alert(1)" }
];

maliciousUrls.forEach((testCase) => {
  runTest(`renderSocialRowHtml neutralizes malicious URL: ${testCase.name}`, () => {
    const config = { instagram: testCase.url };
    const html = buildScript.renderSocialRowHtml(config);
    assert.strictEqual(
      html.includes("<a href="),
      false,
      `Should not render an <a> tag for ${testCase.name}`
    );
  });

  runTest(`getActiveSocialUrls excludes malicious URL: ${testCase.name}`, () => {
    const config = { instagram: testCase.url };
    const active = buildScript.getActiveSocialUrls(config);
    assert.strictEqual(active.length, 0, `getActiveSocialUrls should exclude ${testCase.name}`);
  });
});

// 2.2 Attribute Breakout & XSS Payloads in Valid HTTPS URLs
runTest("renderSocialRowHtml escapes double quote attribute breakouts in HTTPS URL", () => {
  const payload = 'https://instagram.com/user" onmouseover="alert(1)';
  const html = buildScript.renderSocialRowHtml({ instagram: payload });
  assert.strictEqual(
    html.includes('href="https://instagram.com/user&quot; onmouseover=&quot;alert(1)"'),
    true
  );
  assert.strictEqual(html.includes('" onmouseover="'), false);
});

runTest("renderSocialRowHtml escapes single quotes and backticks in URL", () => {
  const payload = "https://instagram.com/user' `test`";
  const html = buildScript.renderSocialRowHtml({ instagram: payload });
  assert.strictEqual(html.includes("&#39;"), true);
  assert.strictEqual(html.includes("&#96;"), true);
});

runTest("renderSocialRowHtml escapes <script> tags inside URL path", () => {
  const payload = "https://instagram.com/user<script>alert(1)</script>";
  const html = buildScript.renderSocialRowHtml({ instagram: payload });
  assert.strictEqual(html.includes("<script>"), false);
  assert.strictEqual(html.includes("&lt;script&gt;"), true);
});

// 2.3 Unicode, Emojis, and Query Parameters
runTest(
  "renderSocialRowHtml cleanly renders valid HTTPS URL with emojis and query parameters",
  () => {
    const validUrl = "https://www.instagram.com/yallternativeliving?vibe=goth&tag=✨";
    const html = buildScript.renderSocialRowHtml({ instagram: validUrl });
    assert.strictEqual(
      html.includes('href="https://www.instagram.com/yallternativeliving?vibe=goth&amp;tag=✨"'),
      true
    );
    assert.strictEqual(html.includes("Instagram (opens in new tab)"), true);
  }
);

// 2.4 Allowed Root-Relative & Protocol-Relative URLs
runTest("renderSocialRowHtml allows root-relative paths", () => {
  const html = buildScript.renderSocialRowHtml({ instagram: "/social/instagram" });
  assert.strictEqual(html.includes('href="/social/instagram"'), true);
});

runTest("renderSocialRowHtml allows protocol-relative URLs", () => {
  const html = buildScript.renderSocialRowHtml({
    instagram: "//instagram.com/yallternativeliving"
  });
  assert.strictEqual(html.includes('href="//instagram.com/yallternativeliving"'), true);
});

// 2.5 getActiveSocialUrls Deduplication and Sorting
runTest("getActiveSocialUrls returns sorted, deduplicated, sanitized list", () => {
  const config = {
    youtube: "https://youtube.com/@yall",
    facebook: "https://facebook.com/yall",
    etsy: "https://etsy.com/shop/yall",
    instagram: "https://instagram.com/yall",
    tiktok: "https://tiktok.com/@yall",
    pinterest: "https://facebook.com/yall" // duplicate URL across channels
  };
  const active = buildScript.getActiveSocialUrls(config);
  assert.deepStrictEqual(active, [
    "https://etsy.com/shop/yall",
    "https://facebook.com/yall",
    "https://instagram.com/yall",
    "https://tiktok.com/@yall",
    "https://youtube.com/@yall"
  ]);
});

// 2.6 Robust Input Types for renderSocialRowHtml
runTest("renderSocialRowHtml handles null / undefined / empty object gracefully", () => {
  const expectedEmpty = '<div class="social-row">\n\n        </div>';
  assert.strictEqual(buildScript.renderSocialRowHtml(null), expectedEmpty);
  assert.strictEqual(buildScript.renderSocialRowHtml(undefined), expectedEmpty);
  assert.strictEqual(buildScript.renderSocialRowHtml({}), expectedEmpty);
});

runTest("renderSocialRowHtml ignores non-string values without throwing", () => {
  const config = {
    instagram: 12345,
    tiktok: true,
    facebook: { url: "https://facebook.com" },
    etsy: ["https://etsy.com"]
  };
  const expectedEmpty = '<div class="social-row">\n\n        </div>';
  assert.strictEqual(buildScript.renderSocialRowHtml(config), expectedEmpty);
});

// ---------------------------------------------------------------------------
// 3. build-site-data.js Missing / Partially Undefined Fields in content.json.site
// ---------------------------------------------------------------------------
console.log("\n--- 3. Graceful Handling of Missing / Undefined content.json.site Fields ---");

// 3.1 Ritual Section Fallbacks
runTest(
  "renderRitualSectionHtml falls back to default title and subtitle when ritualDefaults is undefined",
  () => {
    const product = {
      id: "lavender-soak",
      name: "Lavender Soak",
      price: 14,
      pairsWith: ["sleep-salve"]
    };
    const html = buildScript.renderRitualSectionHtml(
      product,
      mockProductsMap,
      mockCategoriesMap,
      undefined // missing ritualDefaults
    );
    assert.strictEqual(html.includes("✦ Complete the Ritual: Botanical Pairing ✦"), true);
    assert.strictEqual(
      html.includes("Pair this item with complementary botanicals crafted to work together."),
      true
    );
  }
);

runTest("renderRitualSectionHtml handles product without pairsWith gracefully", () => {
  const product = { id: "sleep-salve", name: "Sleep Salve", price: 16 };
  const html = buildScript.renderRitualSectionHtml(product, mockProductsMap, mockCategoriesMap, {
    title: "Custom",
    subtitle: "Custom"
  });
  assert.strictEqual(html, "");
});

runTest(
  "renderRitualSectionHtml handles pairsWith containing unavailable / comingSoon products gracefully",
  () => {
    const product = {
      id: "lavender-soak",
      name: "Lavender Soak",
      price: 14,
      pairsWith: ["coming-soon-butter", "out-of-stock-salve"]
    };
    const testMap = {
      "coming-soon-butter": {
        id: "coming-soon-butter",
        name: "Butter",
        comingSoon: true,
        price: 20
      },
      "out-of-stock-salve": { id: "out-of-stock-salve", name: "Salve", stock: 0, price: 16 }
    };
    const html = buildScript.renderRitualSectionHtml(
      product,
      testMap,
      mockCategoriesMap,
      undefined
    );
    assert.strictEqual(html, "", "Should return empty string when no paired products are buyable");
  }
);

// 3.2 Site ID & Config Verification under Undefined / Partial Fields
runTest("validateSiteIds handles null / undefined / empty site config object without error", () => {
  // If validateSiteIds fails, it calls process.exit(1).
  // Under null/undefined/empty object it should return cleanly.
  assert.doesNotThrow(() => {
    buildScript.validateSiteIds(null);
    buildScript.validateSiteIds(undefined);
    buildScript.validateSiteIds({});
  });
});

// 3.4 FAQ Markdown & Link Sanitization against Hostile Schemes
console.log("\n--- 3.4 FAQ Markdown & safeLinkUrl Hostile Scheme Neutralization ---");

const hostileLinkUrls = [
  "javascript:alert(1)",
  "javascript:/*--></title></style></textarea>*/<svg/onload=alert(1)>",
  "vbscript:msgbox(1)",
  "data:text/html,<script>alert(1)</script>",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "file:///etc/shadow",
  "blob:https://example.com/uuid"
];

hostileLinkUrls.forEach((hostileUrl) => {
  runTest(`safeLinkUrl rejects hostile scheme: ${hostileUrl.slice(0, 40)}`, () => {
    const res = buildScript.safeLinkUrl(hostileUrl);
    assert.strictEqual(res, "", `Should reject hostile URL: ${hostileUrl}`);
  });

  runTest(
    `renderFaqAnswerHtml strips hostile link in markdown [Click](${hostileUrl.slice(0, 40)})`,
    () => {
      const markdown = `Check our [policy](${hostileUrl}) for details.`;
      const html = buildScript.renderFaqAnswerHtml(markdown);
      assert.strictEqual(
        html.includes("<a href="),
        false,
        "Should render plain text without <a> tag"
      );
      assert.strictEqual(html.includes("Check our policy"), true);
    }
  );
});

runTest("safeLinkUrl strips control characters (\\x00-\\x1F, \\x7F)", () => {
  const dirty = "https://example.com/\x00\x08\x1b\x7fpath";
  const clean = buildScript.safeLinkUrl(dirty);
  assert.strictEqual(clean, "https://example.com/path");
});

runTest("safeLinkUrl allows legitimate http, https, mailto, and document-relative paths", () => {
  assert.strictEqual(
    buildScript.safeLinkUrl("https://yallternativeliving.com"),
    "https://yallternativeliving.com"
  );
  assert.strictEqual(buildScript.safeLinkUrl("http://example.com"), "http://example.com");
  assert.strictEqual(
    buildScript.safeLinkUrl("mailto:support@yallternativeliving.com"),
    "mailto:support@yallternativeliving.com"
  );
  assert.strictEqual(buildScript.safeLinkUrl("events.html"), "events.html");
  assert.strictEqual(buildScript.safeLinkUrl("/shop.html#bundle-1"), "/shop.html#bundle-1");
});

// 3.5 Simulated Compilation Sub-pipeline with Missing Site Sections
runTest(
  "Footer social block generator operates safely when social object is completely missing",
  () => {
    const rendered = buildScript.renderSocialRowHtml(undefined);
    assert.strictEqual(rendered, '<div class="social-row">\n\n        </div>');
    const active = buildScript.getActiveSocialUrls(undefined);
    assert.deepStrictEqual(active, []);
  }
);

runTest("Ritual Section generator operates safely when ritualDefaults is omitted", () => {
  const prod = {
    id: "lavender-soak",
    name: "Lavender Soak",
    price: 14,
    pairsWith: ["sleep-salve"]
  };
  const html = buildScript.renderRitualSectionHtml(prod, mockProductsMap, mockCategoriesMap, null);
  assert.strictEqual(html.includes("Botanical Pairing"), true);
  assert.strictEqual(html.includes("Pair this item with complementary botanicals"), true);
});

// 3.3 End-to-End Build Pipeline Execution Test under Clean Repo State
runTest("Canonical buildSiteData() executes cleanly without unhandled exceptions", () => {
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    buildScript.buildSiteData();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("\n===================================================================");
console.log(
  `STRESS TEST SUMMARY: ${passedTests} PASSED, ${failedTests} FAILED (Total: ${totalTests})`
);
console.log("===================================================================");

if (failedTests > 0) {
  process.exit(1);
} else {
  process.exit(0);
}

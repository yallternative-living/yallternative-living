/**
 * @fileoverview Unit pins for scripts/i18n-new-strings.js -- the discovery
 * half of the translation pipeline.
 *
 * Node-only on purpose. The tool itself drives a real Chromium through
 * scripts/extract-i18n-strings.js to learn what the translator can reach, but
 * everything it DECIDES -- which reachable strings are translation candidates,
 * which keys they get, which dictionary entries went stale, and how the two
 * JSON files are rewritten -- is pure and lives in exported functions, so it
 * belongs in the browserless pool the CI `qa` job runs with
 * PUPPETEER_SKIP_DOWNLOAD set. The browser half is proved by the recorded
 * proof run in TEST_INFRA.md instead.
 *
 * Three things here are asserted against the SHIPPED data rather than a
 * fixture, because a fixture would only test the fixture:
 *   - every digest in assets/data/i18n-translation-basis.json still matches
 *     build-site-data.js's digestEnglish over the live en.json, which is what
 *     makes "CHANGED" mean the same thing here and in the build gate;
 *   - a real product name is recognised as a catalog atom and a real filled
 *     tpl.* string as template-covered, so the skip rules are held to the
 *     actual catalog;
 *   - appending nothing to the live en.json and basis reproduces those files
 *     byte for byte, which is what stops --write from silently reformatting
 *     515 keys around a two-key addition.
 *
 * Run: node scripts/i18n-new-strings.test.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const tool = require("./i18n-new-strings.js");
const build = require("./build-site-data.js");

let passed = 0;
let failed = 0;
function ok(label) {
  passed++;
  void label;
}
function fail(label, detail) {
  failed++;
  console.error("  ✗ " + label + (detail ? "\n      " + detail : ""));
}
function assert(condition, label, detail) {
  if (condition) ok(label);
  else fail(label, detail);
}
function assertEqual(actual, expected, label) {
  assert(
    actual === expected,
    label,
    "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)
  );
}

console.log("Running i18n-new-strings pins...\n");

const enDoc = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/data/locales/en.json"), "utf8"));
const basisDoc = JSON.parse(
  fs.readFileSync(path.join(ROOT, "assets/data/i18n-translation-basis.json"), "utf8")
);
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/data/products.json"), "utf8"));
const glossary = JSON.parse(
  fs.readFileSync(path.join(ROOT, "assets/data/brand-glossary.json"), "utf8")
);
const reviewsDoc = JSON.parse(
  fs.readFileSync(path.join(ROOT, "assets/data/site-reviews.json"), "utf8")
);

// ---------------------------------------------------------------------------
// 1. The digest is the build gate's digest, not a second implementation.
// ---------------------------------------------------------------------------
assert(typeof build.digestEnglish === "function", "build-site-data exports digestEnglish");
assert(typeof build.collectBuiltHtml === "function", "build-site-data exports collectBuiltHtml");

const enKeys = Object.keys(enDoc.phrases);
assert(enKeys.length >= 300, "en.json has a dictionary to test over", "found " + enKeys.length);
const basisKeys = Object.keys(basisDoc.basis);
assert(basisKeys.length >= 300, "the basis file has entries", "found " + basisKeys.length);
const digestMismatches = enKeys.filter(function (k) {
  return basisDoc.basis[k] !== build.digestEnglish(enDoc.phrases[k]);
});
assertEqual(
  digestMismatches.length,
  0,
  "every recorded basis digest matches digestEnglish over the live en.json"
);

// ---------------------------------------------------------------------------
// 2. Keys: content-derived, stable, shaped.
// ---------------------------------------------------------------------------
const sample = "Straight from the workbench in Landrum.";
const key1 = tool.keyForText(sample, build.digestEnglish);
const key2 = tool.keyForText(sample, build.digestEnglish);
assertEqual(key1, key2, "the same text keys the same way twice");
assert(
  /^auto\.[a-z][A-Za-z]*\.[0-9a-f]{6}$/.test(key1),
  "a minted key is auto.<camelSlug>.<6 hex>",
  key1
);
assert(
  tool.keyForText(sample + " Really.", build.digestEnglish) !== key1,
  "a different string gets a different key"
);
assertEqual(tool.slugFromText("Add to Cart"), "addToCart", "slug camelCases the first words");
assertEqual(
  tool.slugFromText("Free shipping on orders of $40 or more"),
  "freeShippingOnOrders",
  "slug stops at four words and drops the money"
);
assertEqual(tool.slugFromText("★★★★★ · 5"), "phrase", "a wordless string still gets a slug");
assert(tool.slugFromText("x".repeat(200)).length <= 44, "slug is length-capped");

const collided = tool.assignKeys([sample], [key1], build.digestEnglish);
assertEqual(collided.length, 1, "assignKeys returns one entry per text");
assert(collided[0].key !== key1, "a key already taken is widened, never reused", collided[0].key);
assert(
  collided[0].key.indexOf("auto." + tool.slugFromText(sample) + ".") === 0,
  "widening keeps the slug"
);

// ---------------------------------------------------------------------------
// 3. Skip rules, against the shipped catalog and dictionary.
// ---------------------------------------------------------------------------
const atoms = tool.collectCatalogAtoms(catalog);
assert(atoms.size > 50, "the catalog yields never-translated atoms", "found " + atoms.size);
const reviewTexts = tool.collectReviewTexts(reviewsDoc);
assert(reviewTexts.size > 10, "site-reviews.json yields verbatim review text", reviewTexts.size);

const ctx = {
  enValues: new Set(Object.values(enDoc.phrases)),
  manifestTexts: new Set(["A string only cart.js ever renders"]),
  templateMatchers: tool.buildTemplateMatchers(enDoc.phrases),
  catalogAtoms: atoms,
  reviewTexts: reviewTexts,
  protectedTerms: glossary.protectedTerms
};
assert(
  ctx.templateMatchers.length > 5,
  "tpl.* phrases compile to matchers",
  ctx.templateMatchers.length
);
assert(
  tool.templateIsSpecificEnough("Enlarge photo of {product}"),
  "a template with real literal text is used as a matcher"
);
assert(
  !tool.templateIsSpecificEnough("{variant} for {product}"),
  "a template that is two placeholders around a connective is not used as a matcher"
);
assert(
  !tool.templateIsSpecificEnough("{product} \u2014 {variant}"),
  "a template that is two placeholders around a dash is not used as a matcher"
);
assert(
  ctx.templateMatchers.every(function (m) {
    return m.key !== "tpl.variantFor";
  }),
  "tpl.variantFor is excluded from the live matcher set"
);
assert(
  tool.isCatalogComposite("Beeswax and Shea Butter", atoms, glossary.protectedTerms),
  "a string made of nothing but catalog atoms is a composite label"
);
assert(
  !tool.isCatalogComposite(
    "Beeswax melted slowly over a low flame until it pours clean.",
    atoms,
    glossary.protectedTerms
  ),
  "a sentence that merely mentions an atom is not a composite label"
);

const firstProduct = catalog.products[0];
const firstReview = reviewsDoc.reviews[0];
const cases = [
  ["Skip to main content", "in-dictionary", "an existing English value"],
  ["A string only cart.js ever renders", "runtime-manifest", "a declared runtime string"],
  ["Enlarge photo of " + firstProduct.name, "tpl-template", "a filled tpl.* template"],
  [firstProduct.name, "catalog-atom", "a product name"],
  ["Beeswax", "catalog-atom", "an ingredient token"],
  [
    ": " + firstProduct.variants.options[0].label,
    "catalog-atom",
    "a variant chip with its separator"
  ],
  [firstReview.text, "review-verbatim", "a customer review body"],
  ['"' + firstReview.text + '"', "review-verbatim", "a review body in decorative quotes"],
  ["y.allternative.living@gmail.com", "email-or-url", "an email address"],
  ["YALL-XXXX-XXXX-XXXX", "machine-code", "a gift-card shaped code"],
  ["$14", "no-translatable-words", "a price"],
  ["★★★★★", "no-translatable-words", "a star run"],
  ["16 oz", "no-translatable-words", "a size the catalog does not sell"],
  ["Y'allternative Living", "brand-glossary", "a protected brand term"],
  [
    firstProduct.variants.options[0].label + " for " + firstProduct.name,
    "catalog-composite",
    "a variant label glued to a product name by a connective"
  ],
  ["Sip your coffee on the porch.", null, "real copy is a candidate"],
  [
    "Ships in a 2 oz tin from Landrum, SC.",
    null,
    "copy that mentions a protected term is a candidate"
  ],
  [
    "Aromatherapy mist for the threshold.",
    null,
    "copy is not swallowed by the {variant} for {product} template"
  ]
];
assertEqual(cases.length, 18, "the skip-rule table has every case wired");
cases.forEach(function (row) {
  assertEqual(tool.skipReason(row[0], ctx), row[1], "skipReason: " + row[2]);
});

// ---------------------------------------------------------------------------
// 4. Deferral: strings that must not enter the dictionary yet.
// ---------------------------------------------------------------------------
const volatileCases = [
  ["Showing 20 of 20 goods", true],
  ["Batch: Late October 2026", true],
  ["2 reviews of this one, all from earlier batches.", true],
  ["Free shipping on orders of $40 or more", true],
  ["A 2 oz tin that softens coarse facial hair.", false],
  ["100% ring-spun cotton, cut to fit everybody.", false],
  ["Most orders ship in 1-3 business days.", false],
  ["Straight from the workbench.", false]
];
assertEqual(volatileCases.length, 8, "the volatile-number table has every case wired");
volatileCases.forEach(function (row) {
  assertEqual(
    tool.hasVolatileNumber(row[0]),
    row[1],
    "hasVolatileNumber: " + JSON.stringify(row[0])
  );
});

assertEqual(
  tool.deferReason("Your cart is empty.", { inBuiltHtml: false, inManifest: false }),
  "runtime-only",
  "a string only JavaScript renders is deferred until the manifest declares it"
);
assertEqual(
  tool.deferReason("Your cart is empty.", { inBuiltHtml: false, inManifest: true }),
  null,
  "a declared runtime string is writable"
);
assertEqual(
  tool.deferReason("Showing 20 of 20 goods", { inBuiltHtml: true, inManifest: false }),
  "volatile-numeric",
  "a data-derived count is deferred even when it is in the built HTML"
);
assertEqual(
  tool.deferReason("Browse the shop", { inBuiltHtml: true, inManifest: false }),
  null,
  "ordinary copy in a built page is writable"
);

// ---------------------------------------------------------------------------
// 5. classifyReachable splits and sorts, and loses nothing.
// ---------------------------------------------------------------------------
/* The two candidates are SYNTHETIC on purpose. This fixture used to use a real
   product blurb, which worked right up until the translation step started
   writing product blurbs into en.json -- at which point the blurb classified as
   `in-dictionary`, the count dropped to one, and this suite went red on a tree
   where nothing was wrong. The bot runs `npm test` before it commits, so that
   would have wedged the pipeline permanently. A candidate has to be a string
   the dictionary can never legitimately acquire. */
const reachableFixture = [
  { text: "Skip to main content", kind: "text", pages: ["index.html"] },
  { text: firstProduct.name, kind: "text", pages: ["shop.html"] },
  {
    text: "Blithe wording that exists only in this test fixture.",
    kind: "text",
    pages: ["shop.html", "faq.html"]
  },
  {
    text: "A sentence no page carries and no dictionary holds.",
    kind: "text",
    pages: ["shop.html"]
  }
];
const split = tool.classifyReachable(reachableFixture, ctx);
assertEqual(
  split.candidates.length + split.skipped.length,
  reachableFixture.length,
  "every reachable string lands in exactly one of the two piles"
);
assertEqual(split.candidates.length, 2, "two of the four fixtures are candidates");
assertEqual(
  split.candidates[0].text,
  "A sentence no page carries and no dictionary holds.",
  "candidates come back sorted by text"
);
assertEqual(split.candidates[1].pages.length, 2, "a candidate keeps the pages it was seen on");

// ---------------------------------------------------------------------------
// 6. CHANGED and ORPHANED.
// ---------------------------------------------------------------------------
const fixturePhrases = {
  "a.kept": "Unchanged copy",
  "a.edited": "Copy that got a word swapped",
  "a.unrecorded": "Copy nobody recorded a basis for",
  "a.runtimeOnly": "Only cart.js renders this",
  "a.inHtml": "Present in a built page but not in the render",
  "a.dead": "Nothing shows this any more"
};
const fixtureBasis = {
  "a.kept": build.digestEnglish(fixturePhrases["a.kept"]),
  "a.edited": build.digestEnglish("Copy before the word swap"),
  "a.runtimeOnly": build.digestEnglish(fixturePhrases["a.runtimeOnly"]),
  "a.inHtml": build.digestEnglish(fixturePhrases["a.inHtml"]),
  "a.dead": build.digestEnglish(fixturePhrases["a.dead"])
};
const changed = tool.computeChanged(fixturePhrases, fixtureBasis, build.digestEnglish);
assertEqual(changed.length, 2, "two keys are reported as changed");
const edited = changed.filter(function (c) {
  return c.key === "a.edited";
})[0];
assert(!!edited, "the edited key is reported");
assertEqual(
  edited.previousDigest,
  fixtureBasis["a.edited"],
  "changed carries the digest it drifted from"
);
const unrecorded = changed.filter(function (c) {
  return c.key === "a.unrecorded";
})[0];
assert(!!unrecorded, "a key with no recorded basis is reported as changed");
assertEqual(unrecorded.previousDigest, null, "a never-recorded key reports a null previous digest");

const orphanCtx = {
  reachableTexts: new Set([fixturePhrases["a.kept"], fixturePhrases["a.edited"]]),
  manifestTexts: new Set([fixturePhrases["a.runtimeOnly"]]),
  inBuiltHtml: function (value) {
    return value === fixturePhrases["a.inHtml"];
  }
};
const orphaned = tool.computeOrphaned(
  fixturePhrases,
  orphanCtx,
  new Set(
    changed.map(function (c) {
      return c.key;
    })
  )
);
assertEqual(orphaned.join(","), "a.dead", "only the genuinely dead key is orphaned");
assert(orphaned.indexOf("a.runtimeOnly") === -1, "a declared runtime string is not orphaned");
assert(orphaned.indexOf("a.inHtml") === -1, "a string present in a built page is not orphaned");
assert(
  orphaned.indexOf("a.unrecorded") === -1,
  "a key already reported as changed is not also orphaned"
);

// ---------------------------------------------------------------------------
// 7. Writing: append at the end, reorder nothing, reformat nothing.
// ---------------------------------------------------------------------------
const entries = [
  { key: "auto.oneNewThing.aaaaaa", text: "One new thing" },
  { key: "auto.anotherNewThing.bbbbbb", text: "Another new thing" }
];
const nextEn = tool.appendPhrases(enDoc, entries);
const nextEnKeys = Object.keys(nextEn.phrases);
assertEqual(nextEnKeys.length, enKeys.length + 2, "both new keys land in en.json");
assertEqual(
  nextEnKeys.slice(0, enKeys.length).join("\n"),
  enKeys.join("\n"),
  "every existing key keeps its position"
);
assertEqual(
  nextEnKeys[enKeys.length],
  entries[0].key,
  "new keys are appended in order, at the end"
);
assertEqual(
  nextEn.phrases[entries[1].key],
  "Another new thing",
  "the appended value is the English"
);
assertEqual(nextEn.meta, enDoc.meta, "meta is carried through untouched");

/* The basis file ships sorted because --record-basis rewrites it sorted, but
   this appender must not care: it is handed a deliberately unsorted map and
   has to leave that order alone. */
const unsortedBasis = { note: "n", basis: { zeta: "0000000000", alpha: "1111111111" } };
const nextBasis = tool.appendBasis(unsortedBasis, entries, build.digestEnglish);
assertEqual(
  Object.keys(nextBasis.basis).join(","),
  "zeta,alpha," + entries[0].key + "," + entries[1].key,
  "existing basis order survives and the new digests are appended"
);
assertEqual(
  nextBasis.basis[entries[0].key],
  build.digestEnglish("One new thing"),
  "the recorded digest is digestEnglish of the new English"
);
assertEqual(nextBasis.basis.zeta, "0000000000", "an existing digest is never recomputed");

const enRaw = fs.readFileSync(path.join(ROOT, "assets/data/locales/en.json"), "utf8");
assertEqual(
  JSON.stringify(tool.appendPhrases(enDoc, []), null, 2) + "\n",
  enRaw,
  "appending nothing reproduces en.json byte for byte"
);
const basisRaw = fs.readFileSync(
  path.join(ROOT, "assets/data/i18n-translation-basis.json"),
  "utf8"
);
assertEqual(
  JSON.stringify(tool.appendBasis(basisDoc, [], build.digestEnglish), null, 2) + "\n",
  basisRaw,
  "appending nothing reproduces the basis file byte for byte"
);

// ---------------------------------------------------------------------------
// 8. Argument parsing.
// ---------------------------------------------------------------------------
const parsed = tool.parseArgs(["--write", "--json", "out.json", "--base", "http://127.0.0.1:9"]);
assertEqual(parsed.write, true, "--write parses");
assertEqual(parsed.json, "out.json", "--json takes its path");
assertEqual(parsed.base, "http://127.0.0.1:9", "--base takes its URL");
const bare = tool.parseArgs([]);
assertEqual(bare.write, false, "a bare run is a dry run");
assertEqual(bare.json, null, "a bare run writes no report file");
let threw = false;
try {
  tool.parseArgs(["--nope"]);
} catch {
  threw = true;
}
assert(threw, "an unknown flag is refused rather than ignored");
threw = false;
try {
  tool.parseArgs(["--json"]);
} catch {
  threw = true;
}
assert(threw, "--json without a path is refused");

console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);

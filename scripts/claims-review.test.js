/**
 * @fileoverview Unit pins for scripts/claims-review.js and
 * scripts/lib/copy-claims-rules.js.
 *
 * Node-only and offline: nothing here opens a socket, and there is no key on
 * the machine that runs it. The model pass is driven through an injected
 * client so the three cases that matter -- a clean answer, a schema-conformant
 * hallucination, and a provider that is simply down -- are proved rather than
 * hoped for. The Resend send is driven through an injected fetch for the same
 * reason.
 *
 * The assertions held against the SHIPPED data rather than a fixture, because
 * a fixture would only test the fixture:
 *
 *   - the pending-decision allowlist resolves to the product names that are in
 *     assets/data/products.json TODAY, so a rename cannot leave a stale entry;
 *   - those live names produce no findings when they are re-saved unchanged,
 *     which is the difference between a reviewer she reads and one she filters;
 *   - the live bug-spray blurb -- the one piece of copy the compliance review
 *     called a problem today -- lands in knownPending and not in findings.
 *
 * Run: node scripts/claims-review.test.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const tool = require("./claims-review.js");
const rules = require("./lib/copy-claims-rules.js");

let passed = 0;
let failed = 0;
function ok() {
  passed++;
}
function fail(label, detail) {
  failed++;
  console.error("  x " + label + (detail ? "\n      " + detail : ""));
}
function assert(condition, label, detail) {
  if (condition) ok();
  else fail(label, detail);
}
function assertEqual(actual, expected, label) {
  assert(
    actual === expected,
    label,
    "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)
  );
}

console.log("Running claims-review pins...\n");

const PRODUCTS = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/data/products.json"), "utf8"));
const CONTENT = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/data/content.json"), "utf8"));
const TABLE = rules.loadTable();
const TERMS = rules.flattenTerms(TABLE);
const ALLOWLIST = rules.buildAllowlist(PRODUCTS);

const productsFields = tool.FILE_SOURCES.filter(function (s) {
  return s.file === "assets/data/products.json";
})[0].fields;
const reviewFields = tool.FILE_SOURCES.filter(function (s) {
  return s.file === "assets/data/site-reviews.json";
})[0].fields;

function product(overrides) {
  return Object.assign(
    {
      id: "test-salve",
      name: "Test Salve",
      blurb: "A tin of something that smells like cedar.",
      description: "",
      image: "assets/img/test.jpg",
      etsyUrl: "https://www.etsy.com/listing/1/test",
      tags: [],
      keywords: []
    },
    overrides || {}
  );
}

function extract(doc, fields) {
  return tool.extractStrings(doc, fields || productsFields, "assets/data/products.json");
}

function changesBetween(baseDoc, headDoc, fields) {
  return tool.changedStrings(extract(baseDoc, fields), extract(headDoc, fields));
}

// ---------------------------------------------------------------------------
// 1. The path matcher.
// ---------------------------------------------------------------------------
{
  assert(tool.matchPattern("products[].blurb", "products[].blurb"), "an exact path matches");
  assert(
    !tool.matchPattern("products[].blurb", "products[].name"),
    "a different field does not match"
  );
  assert(
    tool.matchPattern("products[].usageGuide.*", "products[].usageGuide.howToApply"),
    "* matches one segment"
  );
  assert(
    !tool.matchPattern("products[].usageGuide.*", "products[].usageGuide.a.b"),
    "* does not cross a dot"
  );
  assert(tool.matchPattern("home.**", "home.badges.badge1Text"), "** matches any depth");
  assert(tool.matchPattern("*[].name", "upcoming[].name"), "a wildcard segment matches an array");
  assert(
    !tool.matchPattern("products[].name", "bundles[].name"),
    "a wildcard is not implied where none was written"
  );
}

// ---------------------------------------------------------------------------
// 2. What counts as copy. Plumbing must never reach a report about wording.
// ---------------------------------------------------------------------------
{
  assert(tool.looksLikeCopy("Calms the itch underneath."), "a sentence is copy");
  assert(tool.looksLikeCopy("Miracle"), "a single word is copy");
  assert(!tool.looksLikeCopy("assets/img/tank-top.jpg"), "an image path is not copy");
  assert(!tool.looksLikeCopy("https://www.etsy.com/listing/1"), "a URL is not copy");
  assert(!tool.looksLikeCopy("shop.html"), "a page filename is not copy");
  assert(!tool.looksLikeCopy("a134e5d8e8e54a8e90e9c21e9dba5acb"), "an analytics id is not copy");
  assert(!tool.looksLikeCopy("y.allternative.living@gmail.com"), "an email address is not copy");
  assert(!tool.looksLikeCopy("YOUR_GIFTUP_ID"), "a config placeholder is not copy");
  assert(!tool.looksLikeCopy("2026-06-16"), "a date is not copy");
  assert(!tool.looksLikeCopy(""), "an empty string is not copy");
  assert(!tool.looksLikeCopy("$40"), "a bare price is not copy");
}

// ---------------------------------------------------------------------------
// 3. The diff extractor: added, edited, unchanged, reordered, deleted.
// ---------------------------------------------------------------------------
{
  const base = { products: [product()] };

  const unchanged = changesBetween(base, JSON.parse(JSON.stringify(base)));
  assertEqual(unchanged.length, 0, "an identical file yields nothing to review");

  const added = changesBetween(base, {
    products: [product(), product({ id: "new-salve", name: "New Salve", blurb: "Brand new." })]
  });
  assertEqual(added.length, 2, "an added product yields its name and blurb, and no plumbing");
  assert(
    added.every(function (c) {
      return c.change === "added" && c.key.indexOf("[new-salve]") !== -1;
    }),
    "and every one of them is marked added, against the new product"
  );

  const edited = changesBetween(base, {
    products: [product({ blurb: "A tin of something that smells like bourbon." })]
  });
  assertEqual(edited.length, 1, "an edited blurb yields exactly one string");
  assertEqual(edited[0].change, "edited", "marked edited");
  assertEqual(edited[0].kind, "blurb", "with the field named in words");
  assert(
    edited[0].previous === "A tin of something that smells like cedar.",
    "and the previous wording carried along"
  );

  /* Identity is the product id, not the array index: moving a product must not
     read as twenty edits. */
  const reordered = changesBetween(
    { products: [product(), product({ id: "b", name: "B Salve" })] },
    { products: [product({ id: "b", name: "B Salve" }), product()] }
  );
  assertEqual(reordered.length, 0, "reordering the catalogue changes no wording");

  const deleted = changesBetween({ products: [product(), product({ id: "gone" })] }, base);
  assertEqual(deleted.length, 0, "deleted copy is not reviewed -- it cannot claim anything");

  const reviews = tool.changedStrings(
    tool.extractStrings(
      { reviews: [{ id: "r1", text: "smells great", ownerReply: "thank you!" }] },
      reviewFields,
      "assets/data/site-reviews.json"
    ),
    tool.extractStrings(
      {
        reviews: [
          { id: "r1", text: "it healed my eczema", ownerReply: "thank you!" },
          { id: "r2", text: "second purchase" }
        ]
      },
      reviewFields,
      "assets/data/site-reviews.json"
    )
  );
  assertEqual(reviews.length, 2, "an edited review and a new one, and not the unchanged reply");
  assert(
    reviews.every(function (r) {
      return r.isReview;
    }),
    "both are flagged as review text"
  );
}

// ---------------------------------------------------------------------------
// 4. Every rule category, positive and negative.
// ---------------------------------------------------------------------------
{
  function hits(text) {
    return rules.scanText(text, { terms: TERMS }).matches.map(function (m) {
      return m.term;
    });
  }
  function categoryOf(text) {
    const m = rules.scanText(text, { terms: TERMS }).matches[0];
    return m ? m.category : null;
  }

  assertEqual(categoryOf("This salve heals cracked hands."), "drug", "drug: heals");
  assertEqual(categoryOf("Good for eczema flare-ups."), "drug", "drug: a named condition");
  assertEqual(categoryOf("Helps you sleep through the night."), "drug", "drug: a phrase term");
  assertEqual(categoryOf("Anti-inflammatory arnica."), "drug", "drug: a hyphenated action term");
  assertEqual(categoryOf("Repels mosquitoes for hours."), "pesticide", "pesticide: repels");
  assertEqual(categoryOf("Tell the ticks to buzz off."), "pesticide", "pesticide: a phrase term");
  assertEqual(categoryOf("All natural, we promise."), "marketing", "marketing: all natural");
  assertEqual(categoryOf("Hypoallergenic and non-toxic."), "marketing", "marketing: two terms");

  assertEqual(
    hits("A 2 oz tin that smells like a stiff drink and cedarwood.").length,
    0,
    "sensory description is not a claim"
  );
  assertEqual(
    hits("Built for night owls and overthinkers -- part of your wind-down ritual.").length,
    0,
    "the review's own approved rewrite is not a claim"
  );
  assertEqual(
    hits("Y'allternative Miracle Balm, the one y'all keep re-ordering.").length,
    0,
    "puffery is not a claim"
  );
  assertEqual(hits("Retreat to the porch. Please yourself.").length, 0, "word boundaries hold");
  assertEqual(
    hits("Sticks to your hands in the best way.").length,
    0,
    "'tick' does not fire inside 'sticks'"
  );

  const overlapping = hits("All natural, every bit of it.");
  assertEqual(overlapping.length, 1, "'all natural' reports once, not twice");
  assertEqual(overlapping[0], "all natural", "and the longer term is the one reported");

  const both = rules.scanText("Repels mosquitoes and is all natural.", { terms: TERMS }).matches;
  const cats = both
    .map(function (m) {
      return m.category;
    })
    .sort();
  assert(
    cats.indexOf("pesticide") !== -1 && cats.indexOf("marketing") !== -1,
    "two categories in one sentence are both reported"
  );

  /* Republished testimonials are their own category (prior review 4b). */
  const asReview = rules.scanText("It healed my eczema in a week.", {
    terms: TERMS,
    isReview: true
  }).matches;
  assert(asReview.length > 0, "a review that makes a claim is caught");
  assert(
    asReview.every(function (m) {
      return m.category === "testimonial" && m.citation === "S4B";
    }),
    "and reported as a republished testimonial, citing section 4b"
  );

  /* Every term in the table gets a rewording, including one a brief adds. */
  const missing = TERMS.filter(function (t) {
    return rules.suggestionsFor(t.term, t.category, TABLE).length === 0;
  });
  assertEqual(missing.length, 0, "every term in the table has a rewording to offer");
}

// ---------------------------------------------------------------------------
// 5. The known-pending allowlist, against the live catalogue.
// ---------------------------------------------------------------------------
{
  const phrases = ALLOWLIST.map(function (a) {
    return a.phrase;
  });
  const names = PRODUCTS.products.map(function (p) {
    return p.name;
  });
  assert(ALLOWLIST.length >= 4, "the allowlist has the pending decisions in it");
  ["frankincense-salve", "sleep-salve", "backroad-soak", "bug-spray"].forEach(function (id) {
    const entry = ALLOWLIST.filter(function (a) {
      return a.productId === id && a.field === "name";
    })[0];
    assert(entry, "the pending name for " + id + " resolves against the live catalogue");
    if (entry) {
      assert(
        names.indexOf(entry.phrase) !== -1,
        "and it is the name products.json carries right now, not a copy of it",
        entry.phrase
      );
    }
  });

  /* The point of the allowlist: re-saving these names finds nothing new. */
  phrases.forEach(function (phrase) {
    const scan = rules.scanText(phrase, { terms: TERMS, allowlist: ALLOWLIST });
    assertEqual(
      scan.matches.length,
      0,
      "re-saving " + JSON.stringify(phrase.slice(0, 40)) + " produces no new finding"
    );
    assert(scan.pendingHits.length > 0, "and is recorded as a pending decision instead");
  });

  /* A brand name must not license a claim in a sentence AROUND it. */
  const around = rules.scanText("Y'all Heal Now Miracle Frankincense Salve treats rough patches.", {
    terms: TERMS,
    allowlist: ALLOWLIST
  });
  assertEqual(around.matches.length, 1, "a claim beside a pending name is still reported");
  assertEqual(around.matches[0].term, "treats", "and it is the new word, not the product name");

  /* An allowlist entry that names a product nobody sells any more disappears. */
  const gone = rules.buildAllowlist({ products: [] });
  assertEqual(gone.length, 0, "a renamed or removed product drops out of the allowlist");
}

// ---------------------------------------------------------------------------
// 6. The overlay: a research brief changes the word lists, not the code.
// ---------------------------------------------------------------------------
{
  const overlaid = rules.loadTable({
    overlay: {
      categories: {
        drug: {
          add: [{ term: "detox", reason: "a detox claim is a claim about the body" }],
          remove: ["pain"]
        }
      },
      rewordings: [{ when: ["detox"], try: ["a long soak, nothing more"] }]
    },
    env: {}
  });
  const overlaidTerms = rules.flattenTerms(overlaid).map(function (t) {
    return t.lower;
  });
  assert(overlaidTerms.indexOf("detox") !== -1, "an overlay adds a term");
  assert(overlaidTerms.indexOf("pain") === -1, "and removes one");
  assertEqual(
    rules.suggestionsFor("detox", "drug", overlaid)[0],
    "a long soak, nothing more",
    "and its rewording comes with it"
  );
  assert(
    rules.flattenTerms(rules.loadTable({ env: {} })).some(function (t) {
      return t.lower === "pain";
    }),
    "the module constant is never mutated by an overlay"
  );

  let threw = null;
  try {
    rules.loadTable({ overlay: { categories: { drugz: { add: ["x"] } } }, env: {} });
  } catch (err) {
    threw = err.message;
  }
  assert(
    threw && threw.indexOf("drugz") !== -1,
    "a typo in a research brief is an error, not a silently disabled rule"
  );
}

// ---------------------------------------------------------------------------
// 7. Merge, dedupe and severity ranking.
// ---------------------------------------------------------------------------
{
  function finding(over) {
    return Object.assign(
      {
        source: "rule table",
        severity: "definite",
        file: "assets/data/products.json",
        key: "products[a].blurb",
        where: "a - blurb",
        category: "marketing",
        term: "all natural",
        quote: "All natural and lovely.",
        why: "because",
        suggestions: []
      },
      over || {}
    );
  }

  assertEqual(
    tool.mergeFindings([finding(), finding()], []).length,
    1,
    "the same rule on the same string reports once"
  );

  const covered = tool.mergeFindings(
    [finding()],
    [
      finding({
        source: "second pass",
        severity: "likely",
        term: null,
        quote: "all natural and lovely"
      })
    ]
  );
  assertEqual(covered.length, 1, "a model finding the rule table already made is dropped");
  assertEqual(covered[0].source, "rule table", "and the rule table's version is the one kept");

  const distinct = tool.mergeFindings(
    [finding()],
    [
      finding({
        source: "second pass",
        severity: "likely",
        category: "drug",
        term: null,
        quote: "brings the itch right down"
      })
    ]
  );
  assertEqual(distinct.length, 2, "a model finding the table missed survives");

  const ranked = tool.mergeFindings(
    [finding({ severity: "definite", key: "products[z].blurb" })],
    [
      finding({ severity: "possible", term: null, key: "products[a].name", quote: "q1" }),
      finding({ severity: "likely", term: null, key: "products[a].blurb", quote: "q2" })
    ]
  );
  assertEqual(ranked[0].severity, "definite", "definite ranks first");
  assertEqual(ranked[1].severity, "likely", "then likely");
  assertEqual(ranked[2].severity, "possible", "then possible");

  assertEqual(tool.severityForConfidence("high"), "likely", "a confident model finding is likely");
  assertEqual(tool.severityForConfidence("low"), "possible", "an unsure one is possible");
  assert(
    rules.severityRank("definite") < rules.severityRank("likely"),
    "and a model finding can never outrank the rule table"
  );
}

// ---------------------------------------------------------------------------
// 8. The model pass: a clean answer, a hallucination, and a provider that is down.
// ---------------------------------------------------------------------------
const modelPassPins = (async function () {
  const entries = [
    {
      file: "assets/data/products.json",
      key: "products[porch].blurb",
      kind: "blurb",
      isReview: false,
      change: "added",
      text: "Brings the itch right down and you will sleep like a rock."
    }
  ];

  const good = await tool.modelPass(entries, TABLE, {
    completeJSON: function (spec) {
      assert(
        spec.system.indexOf("Miracle") !== -1 && spec.system.indexOf("puffery") !== -1,
        "the prompt tells the model that puffery is not a claim"
      );
      assert(
        spec.system.indexOf("all natural") !== -1,
        "and hands it the rule table so it does not repeat pass 1"
      );
      return Promise.resolve({
        findings: [
          {
            id: "products[porch].blurb",
            quote: "Brings the itch right down",
            why: "acts on a symptom",
            category: "drug",
            confidence: "high",
            suggestion: "conditions the skin underneath"
          }
        ]
      });
    }
  });
  assertEqual(good.findings.length, 1, "a clean model answer becomes one finding");
  assertEqual(good.findings[0].severity, "likely", "at likely, never definite");
  assertEqual(good.skipped, null, "and the pass is not marked skipped");

  const hallucinated = await tool.modelPass(entries, TABLE, {
    completeJSON: function () {
      return Promise.resolve({
        findings: [
          {
            id: "products[porch].blurb",
            quote: "cures baldness overnight",
            why: "invented",
            category: "drug",
            confidence: "high",
            suggestion: "x"
          },
          {
            id: "products[nope].blurb",
            quote: "Brings the itch right down",
            why: "wrong id",
            category: "drug",
            confidence: "high",
            suggestion: "x"
          }
        ]
      });
    }
  });
  assertEqual(
    hallucinated.findings.length,
    0,
    "a quote that is not in the string, and an id that was never sent, are both dropped"
  );

  const down = await tool.modelPass(entries, TABLE, {
    completeJSON: function () {
      return Promise.reject(new Error("HTTP 503 from gemini/gemini-3.8-flash"));
    }
  });
  assertEqual(down.findings.length, 0, "a provider outage yields no model findings");
  assert(
    down.skipped && down.skipped.indexOf("503") !== -1,
    "and the reason is carried into the report verbatim"
  );

  /* The whole run must still report the deterministic findings. */
  const result = await tool.review({
    changed: [
      {
        file: "assets/data/products.json",
        key: "products[porch].blurb",
        kind: "blurb",
        change: "added",
        isReview: false,
        text: "All natural and repels mosquitoes."
      }
    ],
    productsDoc: PRODUCTS,
    table: TABLE,
    client: {
      completeJSON: function () {
        return Promise.reject(new Error("no key"));
      }
    }
  });
  assert(result.findings.length >= 2, "the rule table's findings survive a dead model");
  assert(
    result.findings.every(function (f) {
      return f.source === "rule table";
    }),
    "and nothing is attributed to a model that never answered"
  );
  assertEqual(result.secondPassSkipped, "no key", "with the second pass reported as skipped");

  /* The offline responder proves the second pass end to end with no network. */
  const mocked = tool.mockResponder({
    user: JSON.stringify({
      items: [{ id: "x", where: "x", text: "Brings the itch right down." }]
    })
  });
  assertEqual(mocked.findings.length, 1, "the mock responder finds the implied claim");
  assert(
    mocked.findings[0].why.indexOf("[mock]") === 0,
    "and marks itself so it can never pass for a real model finding"
  );
})();

// ---------------------------------------------------------------------------
// 9. The Markdown shape.
// ---------------------------------------------------------------------------
{
  const summary = {
    reviewed: 2,
    files: ["assets/data/products.json"],
    findings: [
      {
        severity: "definite",
        source: "rule table",
        file: "assets/data/products.json",
        key: "products[porch].blurb",
        where: "porch - blurb",
        category: "pesticide",
        citation: "S4",
        term: "mosquitoes",
        quote: "Tell the mosquitoes to buzz off.",
        why: "a repellency claim",
        suggestions: ["a porch mist for evenings outside"]
      }
    ],
    knownPending: ALLOWLIST.map(function (a) {
      return Object.assign({ touchedThisChange: false }, a);
    }),
    modelUsed: true,
    secondPassSkipped: null,
    fallbackWarning: null
  };

  const md = tool.renderMarkdown(summary, { date: "2026-09-04" });
  assert(md.indexOf("## Copy review - 2026-09-04") === 0, "the report opens with a dated heading");
  assert(md.indexOf("> Tell the mosquitoes to buzz off.") !== -1, "it quotes her sentence");
  assert(md.indexOf("compliance review, section 4") !== -1, "it names the rule's section");
  assert(md.indexOf("Try instead:") !== -1, "it offers a rewording");
  assert(md.indexOf("### Already on your list") !== -1, "pending decisions get their own section");
  assert(
    md.indexOf("never edits your words") !== -1,
    "and it says plainly that nothing was changed"
  );
  assert(md.indexOf("@") === -1, "with no @-mention when the repo has not named an owner");

  const mentioned = tool.renderMarkdown(summary, { date: "2026-09-04", mention: "savanna" });
  assert(mentioned.indexOf("@savanna") !== -1, "and an @-mention when it has");

  const clean = tool.renderMarkdown(Object.assign({}, summary, { findings: [] }), {
    date: "2026-09-04"
  });
  assert(
    clean.indexOf("Nothing in what you changed reads as a health") !== -1,
    "a clean run says so in one line"
  );

  const grouped = tool.groupFindings([
    summary.findings[0],
    Object.assign({}, summary.findings[0], { term: "buzz off", why: "also a claim" })
  ]);
  assertEqual(grouped.length, 1, "two rules on one sentence quote it once");
  assertEqual(grouped[0].findings.length, 2, "with both reasons under it");

  const skipped = tool.renderMarkdown(
    Object.assign({}, summary, { modelUsed: false, secondPassSkipped: "HTTP 503" }),
    { date: "2026-09-04" }
  );
  assert(
    skipped.indexOf("did not run this time: HTTP 503") !== -1,
    "a skipped second pass is stated, not hidden"
  );
}

// ---------------------------------------------------------------------------
// 10. The email: who it goes to, what it says, and when it is not sent.
// ---------------------------------------------------------------------------
const emailPins = (async function () {
  const summary = {
    reviewed: 1,
    files: ["assets/data/products.json"],
    findings: [
      {
        severity: "definite",
        source: "rule table",
        file: "assets/data/products.json",
        key: "products[beard-salve].blurb",
        where: "beard-salve - blurb",
        category: "drug",
        citation: "S1",
        term: "relieves",
        quote: "Relieves the itch underneath.",
        why: "acting on a symptom is a drug claim",
        suggestions: ["tames the scratch"]
      }
    ],
    knownPending: [],
    modelUsed: true,
    secondPassSkipped: null,
    fallbackWarning: null,
    emailTo: tool.ownerEmail(CONTENT)
  };

  assertEqual(
    tool.ownerEmail(CONTENT),
    CONTENT.contact.email,
    "the recipient is read from content.json at run time, never hard-coded"
  );
  assertEqual(tool.ownerEmail({}), null, "and is null when content.json has no contact address");

  const mail = tool.renderEmail(summary, { to: summary.emailTo, productsDoc: PRODUCTS });
  assertEqual(
    mail.subject,
    "A note about your wording on Bourbon Beard Salve",
    "one product means the subject names it"
  );
  assert(mail.text.indexOf("Relieves the itch underneath.") !== -1, "the text part quotes her");
  assert(mail.text.indexOf("tames the scratch") !== -1, "and carries the rewording");
  assert(
    mail.text.indexOf("Nothing on the site was changed") !== -1,
    "and closes by saying nothing was changed"
  );
  assert(mail.html.indexOf("<blockquote") !== -1, "the html part quotes it as a blockquote");
  assert(
    mail.html.indexOf("Nothing on the site was changed") !== -1,
    "and carries the same closing line"
  );
  assert(
    mail.html.indexOf("<script") === -1 && mail.html.indexOf("&quot;") !== -1,
    "with every value escaped"
  );

  const twoProducts = Object.assign({}, summary, {
    findings: summary.findings.concat([
      Object.assign({}, summary.findings[0], { key: "products[bug-spray].blurb" })
    ])
  });
  assertEqual(
    tool.renderEmail(twoProducts, { productsDoc: PRODUCTS }).subject,
    "A note about your wording on 2 products",
    "two products means the subject counts them"
  );
  assertEqual(
    tool.renderEmail(
      Object.assign({}, summary, {
        findings: [Object.assign({}, summary.findings[0], { file: "assets/data/content.json" })]
      }),
      { productsDoc: PRODUCTS }
    ).subject,
    "A note about some wording you just saved",
    "and page copy gets a neutral subject"
  );

  /* The send decision, in the two halves it is actually asked in: the review
     step decides whether there is anything to say, and the step that holds the
     key decides whether it can say it. Folding the two together would mean the
     review step -- which deliberately has no RESEND_API_KEY -- always deciding
     not to send. */
  const full = { RESEND_API_KEY: "k", FROM_EMAIL: "Y'all <hello@example.com>" };
  assertEqual(tool.shouldSendEmail(summary).send, true, "findings and a recipient: send");
  assertEqual(
    tool.shouldSendEmail(Object.assign({}, summary, { findings: [] })).send,
    false,
    "no findings: no email, however many decisions are still pending"
  );
  assertEqual(
    tool.shouldSendEmail(Object.assign({}, summary, { knownPending: ALLOWLIST, findings: [] }))
      .send,
    false,
    "and a knownPending-only run emails nothing at all"
  );
  assertEqual(
    tool.shouldSendEmail(Object.assign({}, summary, { emailTo: null })).send,
    false,
    "no contact address in content.json: no email"
  );

  assertEqual(tool.sendBlockedReason(full), null, "both settings present: nothing blocks the send");
  assert(
    tool.sendBlockedReason({ FROM_EMAIL: full.FROM_EMAIL }).indexOf("RESEND_API_KEY") !== -1,
    "a missing key is named, so the skip notice is useful"
  );
  assert(
    tool.sendBlockedReason({ RESEND_API_KEY: "k" }).indexOf("FROM_EMAIL") !== -1,
    "and so is a missing sender -- Resend rejects an unverified one"
  );

  /* The send itself, through an injected fetch. One request, no key in a URL. */
  let seen = null;
  const sent = await tool.sendEmail(mail, {
    env: full,
    fetchImpl: function (url, init) {
      seen = { url: url, init: init };
      return Promise.resolve({ ok: true, status: 200 });
    }
  });
  assertEqual(sent.sent, true, "a 200 from Resend is a sent email");
  assertEqual(seen.url, tool.RESEND_ENDPOINT, "posted to the Resend endpoint");
  assert(seen.url.indexOf(full.RESEND_API_KEY) === -1, "with the key never in the URL");
  assertEqual(
    seen.init.headers.Authorization,
    "Bearer k",
    "and the key in the Authorization header, exactly as workers/submit-form.js does it"
  );
  const body = JSON.parse(seen.init.body);
  assertEqual(body.from, full.FROM_EMAIL, "from is the verified sender, not an invented address");
  assertEqual(body.to[0], CONTENT.contact.email, "to is the shop mailbox");
  assert(body.html && body.text, "and both parts are sent");

  const failed503 = await tool.sendEmail(mail, {
    env: full,
    fetchImpl: function () {
      return Promise.resolve({
        ok: false,
        status: 503,
        text: function () {
          return Promise.resolve("upstream unavailable");
        }
      });
    }
  });
  assertEqual(failed503.sent, false, "a Resend outage is not a sent email");
  assert(failed503.reason.indexOf("503") !== -1, "and says so");

  const threw = await tool.sendEmail(mail, {
    env: full,
    fetchImpl: function () {
      return Promise.reject(new Error("getaddrinfo ENOTFOUND"));
    }
  });
  assertEqual(threw.sent, false, "a network error is caught, never thrown");
  assert(threw.reason.indexOf("ENOTFOUND") !== -1, "and reported");
})();

// ---------------------------------------------------------------------------
// 11. The flags.
// ---------------------------------------------------------------------------
{
  const args = tool.parseArgs([
    "--base",
    "abc",
    "--head",
    "def",
    "--provider",
    "mock",
    "--json",
    "out.json",
    "--dry-run"
  ]);
  assertEqual(args.base, "abc", "--base is read");
  assertEqual(args.head, "def", "--head is read");
  assertEqual(args.provider, "mock", "--provider is read");
  assertEqual(args.dryRun, true, "--dry-run is a switch");

  const files = tool.parseArgs(["--files", "a.json", "b.json", "--provider", "mock"]);
  assertEqual(files.files.length, 2, "--files takes a list");
  assertEqual(files.provider, "mock", "and stops at the next flag");

  [["--base"], ["--nope"], ["--format", "yaml"], ["--files"]].forEach(function (argv) {
    let caught = false;
    try {
      tool.parseArgs(argv);
    } catch {
      caught = true;
    }
    assert(caught, "a bad flag is refused: " + argv.join(" "));
  });
}

// ---------------------------------------------------------------------------
// 12. Against the shipped catalogue: the live copy the review flagged.
// ---------------------------------------------------------------------------
{
  const bugSpray = PRODUCTS.products.filter(function (p) {
    return p.id === "bug-spray";
  })[0];
  assert(bugSpray, "the bug spray is still in the catalogue");
  if (bugSpray) {
    const scan = rules.scanText(bugSpray.blurb, { terms: TERMS, allowlist: ALLOWLIST });
    assertEqual(
      scan.matches.length,
      0,
      "the live bug-spray blurb produces no NEW finding -- it is a decision she already has"
    );
    assert(
      scan.pendingHits.indexOf("bug-spray-blurb") !== -1,
      "and lands under known-pending instead"
    );
  }

  /* Every product name in the shipped catalogue that is NOT on the pending
     list must be clean -- if one is not, the allowlist is out of date. */
  const surprises = PRODUCTS.products
    .map(function (p) {
      const scan = rules.scanText(p.name, { terms: TERMS, allowlist: ALLOWLIST });
      return scan.matches.length ? p.name + " -> " + scan.matches[0].term : null;
    })
    .filter(Boolean);
  assertEqual(
    surprises.length,
    0,
    "no shipped product name trips a rule outside the pending list",
    surprises.join("; ")
  );
}

Promise.all([modelPassPins, emailPins])
  .then(function () {
    console.log("\n" + passed + " passed, " + failed + " failed");
    process.exit(failed ? 1 : 0);
  })
  .catch(function (err) {
    console.error("suite crashed: " + (err && err.stack ? err.stack : err));
    process.exit(1);
  });

/**
 * @fileoverview Unit pins for scripts/search-enrich.js, its rules module, and
 * the merge scripts/build-site-data.js does with what it writes.
 *
 * Node-only and offline: the provider is the shared client's `mock`, and the
 * one filesystem test writes into os.tmpdir(). Nothing here opens a socket and
 * nothing here writes into the repository.
 *
 * The assertions that matter most are the surface ones. "itchy skin" is a legal
 * query synonym and an illegal published keyword, and if that asymmetry ever
 * collapses in either direction this file goes red: collapse it one way and the
 * shop stops answering the words half its customers type, collapse it the other
 * and the shop publishes a symptom word next to a salve.
 *
 * Since the 2026-09-04 legal brief there is a third surface, and its assertions
 * are the ones to read next: a NAMED DISEASE ("eczema", "psoriasis") is illegal
 * on both of the bot's surfaces and lives in MEDICAL_QUERY_TERMS, which maps to
 * no product at all.
 *
 * Three things are held against the SHIPPED repo rather than a fixture, because
 * a fixture would only test the fixture:
 *
 *   - the rules module's synonym-key normalisation is the build's own, so a key
 *     the bot accepts is the key the build stores;
 *   - the query-side words the build refuses and the policy would allow are
 *     exactly the three the TODO names, so the reconciliation list cannot go
 *     stale silently;
 *   - every entry in the committed assets/data/search-enrichment.json still
 *     passes today's policy and today's build.
 *
 * Run: node scripts/search-enrich.test.js
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const tool = require("./search-enrich.js");
const rules = require("./lib/search-enrichment-rules.js");
const build = require("./build-site-data.js");
const llm = require("./lib/llm.js");

let passed = 0;
let failed = 0;
function ok() {
  passed++;
}
function fail(label, detail) {
  failed++;
  console.error("  ✗ " + label + (detail ? "\n      " + detail : ""));
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
function assertDeep(actual, expected, label) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    "expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual)
  );
}

console.log("Running search-enrich pins...\n");

const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/data/products.json"), "utf8"));

function product(over) {
  return Object.assign(
    {
      id: "test-salve",
      name: "Bourbon Beard Salve",
      blurb: "A conditioning salve for the beard.",
      description: "",
      category: "salves",
      ingredients: ["Beeswax", "Jojoba oil"],
      concerns: ["dry-skin"],
      keywords: ["beard", "grooming"],
      price: 20
    },
    over || {}
  );
}

// ---------------------------------------------------------------------------
// 1. The digest: what re-enriches a product, and what must not.
// ---------------------------------------------------------------------------
{
  const base = tool.digestProduct(product());
  assertEqual(tool.digestProduct(product()), base, "the digest is stable across identical copy");
  assertEqual(
    tool.digestProduct(product({ price: 99, stock: 3, image: "x.jpg", featured: true })),
    base,
    "a price, stock, photo or featured change does NOT cost a regeneration"
  );
  ["name", "blurb", "description", "category"].forEach(function (field) {
    const over = {};
    over[field] = "something else entirely";
    assert(tool.digestProduct(product(over)) !== base, "editing " + field + " changes the digest");
  });
  assert(
    tool.digestProduct(product({ ingredients: ["Beeswax"] })) !== base,
    "editing the ingredients changes the digest"
  );
  assert(
    tool.digestProduct(product({ concerns: [] })) !== base,
    "editing the concerns changes the digest"
  );
}

// ---------------------------------------------------------------------------
// 2. planWork: new, changed, unchanged, removed, and a policy bump.
// ---------------------------------------------------------------------------
{
  const p = product();
  const digest = tool.digestProduct(p);
  const fresh = {
    "test-salve": {
      keywords: ["post shave"],
      querySynonyms: [],
      source: { model: "m", digest: digest, policy: rules.POLICY_VERSION, date: "2026-09-04" }
    }
  };

  let plan = tool.planWork({ products: [p], enrichment: fresh });
  assertDeep(plan.unchanged, ["test-salve"], "an unchanged product is left alone");
  assertEqual(plan.needed.length, 0, "and costs no call");
  assertDeep(plan.carried["test-salve"], fresh["test-salve"], "its entry is carried verbatim");

  plan = tool.planWork({ products: [p], enrichment: {} });
  assertEqual(plan.needed.length, 1, "a product with no entry is work");
  assertEqual(plan.needed[0].reason, "new", "and is reported as new");

  plan = tool.planWork({ products: [product({ blurb: "Rewritten." })], enrichment: fresh });
  assertEqual(plan.needed.length, 1, "edited copy is work");
  assertEqual(plan.needed[0].reason, "changed", "and is reported as changed");

  plan = tool.planWork({ products: [p], enrichment: fresh, policyVersion: "9999-01-01" });
  assertEqual(plan.needed.length, 1, "a policy bump re-enriches everything");

  plan = tool.planWork({
    products: [p],
    enrichment: Object.assign({ "deleted-product": fresh["test-salve"] }, fresh)
  });
  assertDeep(plan.removed, ["deleted-product"], "a product gone from products.json is removed");
  assert(
    !Object.prototype.hasOwnProperty.call(plan.carried, "deleted-product"),
    "and is not carried into the next document"
  );
}

// ---------------------------------------------------------------------------
// 3. The product side: every filter, both ways.
// ---------------------------------------------------------------------------
{
  const ctx = {
    ownerKeywords: ["beard", "grooming"],
    nameTokens: rules.wordsOf("Bourbon Beard Salve")
  };

  function keep(term, label) {
    const r = rules.screenKeyword(Object.assign({ term: term }, ctx));
    assert(r.ok, label || "keyword kept: " + term, r.reason);
    return r;
  }
  function drop(term, match, label) {
    const r = rules.screenKeyword(Object.assign({ term: term }, ctx));
    assert(!r.ok, label || "keyword dropped: " + term);
    if (!r.ok) {
      assert(
        new RegExp(match, "i").test(r.reason),
        "  ...for the right reason (" + term + ")",
        "reason was: " + r.reason
      );
    }
  }

  keep("post hike", "an occasion survives");
  keep("stocking stuffer", "a gift context survives");
  keep("that bug stuff", "plain language survives");
  keep("lavendar", "a misspelling survives");
  keep("beard oil", "a phrase that merely CONTAINS a name token survives");
  keep("jojoba", "an ingredient name survives");

  drop("eczema", "symptom or condition", "a condition word is refused on the published surface");
  drop("psoriasis", "psoriasis");
  drop("insomnia", "symptom or condition");
  drop("sore muscles", "symptom or condition");
  drop("relieves pain", "treatment claim|symptom");
  drop("heals dry skin", "treatment claim");
  drop("all natural", "unsubstantiated");
  drop("organic", "unsubstantiated");
  drop("mosquito repellent", "pesticide");
  drop("tick bites", "pesticide");
  drop("burts bees dupe", "another brand");
  drop("bourbon", "already a word in the product's own name");
  drop("grooming", "duplicates a keyword the owner already wrote");
  drop(
    "GROOMING",
    "duplicates a keyword the owner already wrote",
    "the owner dedupe is case-insensitive"
  );
  drop("x".repeat(41), "over the 40-char cap");
  drop("beeswax (cera alba)", "characters a search word should not have");
  drop("   ", "empty after trimming");
  drop(42, "not a string");

  const taken = new Set(["post hike"]);
  const dup = rules.screenKeyword({ term: "Post Hike", ownerKeywords: [], taken: taken });
  assert(!dup.ok && /same batch/.test(dup.reason), "a repeat inside one batch is dropped");
}

// ---------------------------------------------------------------------------
// 4. The query side, and the asymmetry that is the whole design.
// ---------------------------------------------------------------------------
{
  const entry = rules.screenSynonymEntry({
    entry: {
      key: "Dry Skin",
      terms: ["itchy skin", "eczema", "insomnia", "sore muscles", "cures itch", "psoriasis flare"]
    }
  });
  assert(entry.ok, "a symptom-word synonym entry survives", entry.reason);
  assertEqual(entry.value.key, "dry_skin", "the key is normalised the way the build normalises it");
  assertDeep(
    entry.value.terms,
    ["itchy skin", "sore muscles"],
    "LAY symptom words are KEPT on the query side"
  );
  const reasons = entry.dropped.map(function (d) {
    return d.item + ": " + d.reason;
  });
  assert(
    entry.dropped.some(function (d) {
      return d.item === "cures itch" && /cures/.test(d.reason);
    }),
    "but a medicine word is still refused there",
    reasons.join(" | ")
  );
  assert(
    entry.dropped.some(function (d) {
      return d.item === "psoriasis flare" && /medicalQueryTerms/.test(d.reason);
    }),
    "and a named disease is refused, naming the router it belongs to instead",
    reasons.join(" | ")
  );
  assert(
    entry.dropped.some(function (d) {
      return d.item === "eczema" && /maps to no product/.test(d.reason);
    }),
    "including the one this file used to assert was KEPT here",
    reasons.join(" | ")
  );

  /* The asymmetry, stated once, in both directions. Lay vocabulary only: the
     named diseases that used to sit in this list are asserted the other way
     round two blocks below. */
  /* "bites" and "mosquito" stood in this list until 2026-09-04. They are
     router words now: brief 7(g)'s bug-spray paragraph puts repel, repellent,
     mosquito, tick and bites on all three ban surfaces AND in the router,
     because 7 USC 136(u) plus 40 CFR 152.15 make naming the pest the claim,
     "(by labeling or otherwise)". "bug spray" replaces them as the outdoor
     query a shopper actually types -- it names the product form, not the pest. */
  ["itchy skin", "itch", "rash", "sore muscles"].forEach(function (word) {
    assert(!rules.querySideHit(word), "query side allows " + JSON.stringify(word));
    assert(!!rules.productSideHit(word), "product side refuses " + JSON.stringify(word));
  });

  /* Two of the allowed query words are legal on BOTH surfaces, and that is not
     an oversight: "flaky" and "tired legs" are the exact register the 2026-09-01
     review told the owner to prefer over "eczema" and "sore muscles", and
     "bug spray" and "porch nights" are what replaced "mosquito" and "bites" in
     QUERY_SIDE_ALLOWED on 2026-09-04: a product form and a place, naming no
     pest and no effect, so FIFRA has nothing to bite on. A word being safe to
     publish does not stop it being worth recognising. */
  ["flaky", "tired legs", "bug spray", "porch nights"].forEach(function (word) {
    assert(!rules.querySideHit(word), "query side allows " + JSON.stringify(word));
    assert(
      !rules.productSideHit(word),
      "and so does the product side -- it is preferred prose " + JSON.stringify(word)
    );
  });

  /* The router: a named disease or a treatment word is refused on BOTH of the
     bot's surfaces, and the reason says where it went instead. Brief 7(b). */
  [
    "eczema",
    "psoriasis",
    "insomnia",
    "wound",
    "infection",
    "pain",
    "arthritis",
    "repellent",
    "mosquito",
    "mosquitoes",
    "tick",
    "ticks",
    "bite",
    "bites"
  ].forEach(function (word) {
    const hit = rules.querySideHit(word);
    assert(!!hit, "the router word " + JSON.stringify(word) + " is refused on the query side");
    assert(
      /medicalQueryTerms/.test(hit.why),
      "  ...with a reason naming the router",
      hit && hit.why
    );
    assert(!!rules.productSideHit(word), "  ...and on the product side");
  });
  rules.MEDICAL_QUERY_TERMS.forEach(function (entry) {
    assert(
      typeof entry.term === "string" && entry.term.trim().length > 0,
      "every router entry has a term"
    );
    assert(
      typeof entry.why === "string" && entry.why.length > 8,
      "every router entry says why: " + entry.term
    );
    assert(
      typeof entry.brief === "string" && /^7\(/.test(entry.brief),
      "every router entry cites the brief section that put it there: " + entry.term
    );
    assert(!!rules.productSideHit(entry.term), "no router word is ever publishable: " + entry.term);
  });
  assertDeep(
    rules.medicalQueryTermList().slice(0, 3),
    ["eczema", "psoriasis", "dermatitis"],
    "the emitted shape is a plain array of strings, in declaration order"
  );
  ["eczema", "psoriasis", "insomnia", "mosquito", "bites", "tick"].forEach(function (word) {
    assert(
      !rules.QUERY_SIDE_ALLOWED.some(function (a) {
        return a.term === word;
      }),
      JSON.stringify(word) + " is no longer advertised as an allowed synonym"
    );
  });
  /* Every pest word reaches the outdoor-defense shelf, and none of them reaches
     it by being a synonym for a jar. The shelf's own invitation is asserted in
     scripts/medical-query-router.browser.test.js, where it is rendered. */
  ["mosquito", "mosquitos", "mosquitoes", "tick", "ticks", "bite", "bites"].forEach(
    function (word) {
      assert(
        rules.MEDICAL_QUERY_TERMS.some(function (e) {
          return e.term === word && /136\(u\)|pest|plural|misspelled/.test(e.why);
        }),
        JSON.stringify(word) + " is on the router with a FIFRA reason"
      );
    }
  );
  ["cure", "treats", "treatment", "medicine", "medical", "prescription", "diagnose"].forEach(
    function (word) {
      assert(!!rules.querySideHit(word), "neither side allows " + JSON.stringify(word));
      assert(!!rules.productSideHit(word), "  ...including the product side");
    }
  );

  const noKey = rules.screenSynonymEntry({ entry: { key: "!!!", terms: ["x"] } });
  assert(
    !noKey.ok && /empty key/.test(noKey.reason),
    "a key that normalises to nothing is dropped"
  );
  const noTerms = rules.screenSynonymEntry({ entry: { key: "itch", terms: ["cures itch"] } });
  assert(
    !noTerms.ok && /no term left/.test(noTerms.reason),
    "an entry whose every term was refused is dropped whole"
  );
  const bannedKey = rules.screenSynonymEntry({ entry: { key: "medical stuff", terms: ["a"] } });
  assert(
    !bannedKey.ok && /key contains/.test(bannedKey.reason),
    "a banned word in the KEY is refused"
  );
  const notObject = rules.screenSynonymEntry({ entry: ["a"] });
  assert(!notObject.ok && /key, terms/.test(notObject.reason), "a non-object entry is refused");
}

// ---------------------------------------------------------------------------
// 5. The rules module agrees with the build it has to satisfy.
// ---------------------------------------------------------------------------
{
  assert(
    rules.SEARCH_SYNONYM_BANNED === build.SEARCH_SYNONYM_BANNED,
    "the banned list is IMPORTED from the build, not copied"
  );
  assertDeep(
    rules.QUERY_SIDE_BLOCKED_BY_BUILD_ONLY,
    [],
    "nothing is refused by the build alone any more -- the policy names every word it does"
  );
  /* This was ["wound", "infection", "psoriasis"] until the 2026-09-04 brief
     closed the TODO by moving them into MEDICAL_QUERY_TERMS rather than by
     shortening SEARCH_SYNONYM_BANNED. If it ever fills up again, somebody added
     a word to the build's list and to no list in the rules module, and the bot
     is now refusing a word for a reason it cannot explain. */
  /* The router list has to reach the client, and it has to reach ONLY the
     client. Held against the shipped artefacts rather than a fixture, because a
     fixture would only prove the fixture. */
  const shippedIndex = (function () {
    const sandbox = { window: {} };
    const src = fs.readFileSync(path.join(ROOT, "assets/js/search-data.js"), "utf8");
    new Function("window", src)(sandbox.window);
    return sandbox.window.YL_SEARCH_INDEX;
  })();
  assertDeep(
    shippedIndex.medicalQueryTerms,
    rules.medicalQueryTermList(),
    "assets/js/search-data.js carries the router list, sourced from the rules module"
  );
  assert(
    shippedIndex.medicalQueryTerms.every(function (t) {
      return typeof t === "string";
    }),
    "and carries it as plain strings -- no product ids, no destinations"
  );
  const contentJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, "assets/data/content.json"), "utf8")
  );
  const chipText = JSON.stringify((contentJson.search || {}).popularChips || []).toLowerCase();
  const sitemap = fs.readFileSync(path.join(ROOT, "sitemap.xml"), "utf8").toLowerCase();
  rules.medicalQueryTermList().forEach(function (term) {
    assert(
      chipText.indexOf(term) === -1,
      "no popular-search chip presents " + JSON.stringify(term) + " (brief 7(c)(5))"
    );
    assert(sitemap.indexOf(term) === -1, "and no sitemap URL does either: " + JSON.stringify(term));
  });

  ["Dry Skin", "post-hike!", "  Bug   Spray  ", "níght"].forEach(function (raw) {
    const mine = rules.normalizeSynonymKey(raw);
    const theirs = Object.keys(
      build.buildSearchSynonyms({}, [{ key: raw, terms: ["placeholder"] }])
    )[0];
    assertEqual(mine, theirs, "key normalisation matches the build for " + JSON.stringify(raw));
  });
  rules.SEARCH_SYNONYM_BANNED.forEach(function (word) {
    assert(
      !!rules.querySideHit(word) && !!rules.productSideHit(word),
      "the bot never proposes " + JSON.stringify(word) + ", which the build would throw on"
    );
  });
}

// ---------------------------------------------------------------------------
// 6. The merge, in the build: owner first, deduped, and never in products.json.
// ---------------------------------------------------------------------------
{
  assertDeep(
    build.mergeEnrichedKeywords(["beard", "Grooming"], ["post shave", "beard", "GROOMING", "  "]),
    ["beard", "Grooming", "post shave"],
    "owner's keywords lead, the bot only appends, dedupe is case-insensitive"
  );
  assertDeep(
    build.mergeEnrichedKeywords(["beard"], undefined),
    ["beard"],
    "no enrichment leaves the owner's list exactly as it was"
  );
  assertDeep(
    build.mergeEnrichedKeywords(undefined, ["post shave"]),
    ["post shave"],
    "a product with no keywords of its own still gets the bot's"
  );
  assertDeep(
    build.mergeEnrichedKeywords(["beard"], [null, 7, { a: 1 }]),
    ["beard"],
    "non-strings in the enrichment file are ignored, not rendered"
  );

  const enrichment = {
    alive: { querySynonyms: [{ key: "gift", terms: ["secret santa"] }] },
    dead: { querySynonyms: [{ key: "ghost", terms: ["nobody"] }] }
  };
  assertDeep(
    build.enrichedQuerySynonyms(enrichment, ["alive"]),
    [{ key: "gift", terms: ["secret santa"] }],
    "an entry for a product that no longer exists never reaches the index"
  );

  const missing = build.readSearchEnrichment("assets/data/does-not-exist.json");
  assertDeep(missing, {}, "a missing enrichment file is not an error");
}

// ---------------------------------------------------------------------------
// 7. The mock emits real violations, and screenBatch catches every one.
// ---------------------------------------------------------------------------
{
  const work = [{ id: "test-salve", product: product(), digest: "abc1234567", reason: "new" }];
  const response = tool.mockResponder({
    user: tool.buildUserPayload(work, [], [])
  });
  const emitted = response.products[0];
  assert(emitted.keywords.indexOf("eczema") !== -1, "the mock emits a condition word as a keyword");
  assert(
    emitted.keywords.some(function (k) {
      return k.length > rules.LIMITS.maxTermChars;
    }),
    "the mock emits an over-long string"
  );
  assert(
    emitted.keywords.indexOf("beard") !== -1,
    "the mock emits a duplicate of an owner keyword"
  );
  assert(
    JSON.stringify(emitted.querySynonyms).indexOf("cures itch") !== -1,
    "the mock emits a banned synonym term"
  );

  const screened = tool.screenBatch({
    group: work,
    response: response,
    model: "mock",
    date: "2026-01-01"
  });
  const entry = screened.entries["test-salve"];
  assert(entry.keywords.indexOf("eczema") === -1, "screenBatch drops the condition keyword");
  assert(
    entry.keywords.every(function (k) {
      return k.length <= rules.LIMITS.maxTermChars;
    }),
    "screenBatch drops the over-long string"
  );
  assert(entry.keywords.length > 0, "and keeps the legitimate ones");
  assert(
    JSON.stringify(entry.querySynonyms).indexOf("cures") === -1,
    "screenBatch drops the banned synonym term"
  );
  assert(
    JSON.stringify(entry.querySynonyms).indexOf("eczema") === -1 &&
      JSON.stringify(entry.querySynonyms).indexOf("psoriasis") === -1,
    "and drops the named diseases from the query side too -- they are the router's"
  );
  assert(
    JSON.stringify(entry.querySynonyms).indexOf("itchy skin") !== -1,
    "while the LAY symptom phrase survives there -- the asymmetry, end to end"
  );
  assert(
    screened.dropped.some(function (d) {
      return d.item === "eczema" && /medicalQueryTerms/.test(d.reason);
    }),
    "and the drop log says where the disease word went instead",
    JSON.stringify(screened.dropped)
  );
  assert(screened.dropped.length >= 4, "every drop is reported", JSON.stringify(screened.dropped));
  screened.dropped.forEach(function (d) {
    assert(
      typeof d.id === "string" &&
        typeof d.item === "string" &&
        typeof d.reason === "string" &&
        d.reason,
      "each drop carries id, item and a reason",
      JSON.stringify(d)
    );
  });
  assertEqual(entry.source.digest, "abc1234567", "the entry records the digest it was made from");
  assertEqual(entry.source.policy, rules.POLICY_VERSION, "and the policy version");

  const caps = tool.screenBatch({
    group: work,
    response: {
      products: [
        {
          id: "test-salve",
          keywords: Array.from({ length: 40 }, function (_, i) {
            return "word" + i;
          }),
          querySynonyms: Array.from({ length: 20 }, function (_, i) {
            return { key: "k" + i, terms: ["t" + i] };
          })
        }
      ]
    },
    model: "mock"
  });
  assertEqual(
    caps.entries["test-salve"].keywords.length,
    rules.LIMITS.maxKeywords,
    "the keyword cap holds"
  );
  assertEqual(
    caps.entries["test-salve"].querySynonyms.length,
    rules.LIMITS.maxSynonymEntries,
    "the synonym cap holds"
  );

  const absent = tool.screenBatch({ group: work, response: { products: [] }, model: "mock" });
  assertDeep(absent.missing, ["test-salve"], "a product the model skipped is reported missing");
  assert(!absent.entries["test-salve"], "and gets no entry at all rather than an empty one");
}

// ---------------------------------------------------------------------------
// 8. A whole run, through the shared client's mock: two runs, no diff.
// ---------------------------------------------------------------------------
{
  const catalog = {
    products: [
      product(),
      product({ id: "second", name: "Porch Sweep Clearing Mist", keywords: [] })
    ],
    concerns: CATALOG.concerns,
    categories: CATALOG.categories
  };
  function client() {
    return llm.createClient({ provider: "mock", mockResponder: tool.mockResponder });
  }

  const first = client();
  Promise.resolve()
    .then(function () {
      return tool.enrichAll({
        catalog: catalog,
        enrichment: {},
        client: first,
        date: "2026-01-01"
      });
    })
    .then(function (run1) {
      assertEqual(run1.generated.length, 2, "a first run enriches every product");
      assertEqual(first.telemetry.calls, 1, "in one batched call");
      const text1 = tool.serializeDocument(run1.document);

      const second = client();
      return tool
        .enrichAll({
          catalog: catalog,
          enrichment: JSON.parse(text1),
          client: second,
          date: "2026-01-01"
        })
        .then(function (run2) {
          assertEqual(second.telemetry.calls, 0, "a second run makes no call at all");
          assertEqual(run2.generated.length, 0, "and generates nothing");
          assertEqual(
            tool.serializeDocument(run2.document),
            text1,
            "so two runs in a row produce a byte-identical file"
          );

          /* Removal, through the whole run rather than through planWork alone. */
          const third = client();
          return tool
            .enrichAll({
              catalog: { products: [product()], concerns: [], categories: [] },
              enrichment: JSON.parse(text1),
              client: third,
              date: "2026-01-01"
            })
            .then(function (run3) {
              assert(
                !Object.prototype.hasOwnProperty.call(run3.document, "second"),
                "a deleted product drops out of the enrichment file"
              );
              assertDeep(run3.plan.removed, ["second"], "and the removal is reported");
              assertEqual(third.telemetry.calls, 0, "without costing a call");
            });
        });
    })
    .then(function () {
      // -----------------------------------------------------------------
      // 9. Serialisation: 2-space, trailing newline, stable order.
      // -----------------------------------------------------------------
      const text = tool.serializeDocument({
        zebra: {
          keywords: ["b"],
          querySynonyms: [],
          source: { digest: "d", model: "m", date: "x", policy: "p" }
        },
        alpha: {
          keywords: ["a"],
          querySynonyms: [],
          source: { model: "m", digest: "d", date: "x", policy: "p" }
        }
      });
      assert(text.endsWith("}\n"), "the file ends with exactly one newline");
      assert(!text.endsWith("\n\n"), "and not two");
      assert(/\n {2}"alpha"/.test(text), "top-level entries are indented two spaces");
      assert(
        text.indexOf('"alpha"') < text.indexOf('"zebra"'),
        "product ids are sorted, so a catalogue reorder is not a diff"
      );
      const entryOrder = JSON.stringify(Object.keys(JSON.parse(text).alpha));
      assertEqual(
        entryOrder,
        JSON.stringify(["keywords", "querySynonyms", "source"]),
        "and every entry has the same field order"
      );
      assertEqual(
        JSON.stringify(Object.keys(JSON.parse(text).alpha.source)),
        JSON.stringify(["model", "digest", "policy", "date"]),
        "including inside source"
      );
      assertEqual(
        tool.serializeDocument(JSON.parse(text)),
        text,
        "and the format survives a round trip"
      );

      // -----------------------------------------------------------------
      // 10. The build's veto, and the restore that follows it.
      // -----------------------------------------------------------------
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yl-search-enrich-"));
      const target = path.join(dir, "search-enrichment.json");

      let calls = 0;
      let veto = tool.writeAndVerify({
        enrichmentPath: target,
        text: "NEW\n",
        previous: "OLD\n",
        runBuild: function () {
          calls++;
          return { ok: false, error: "search.extraSynonyms: refused" };
        }
      });
      assert(!veto.ok, "a build that throws vetoes the run");
      assertEqual(
        fs.readFileSync(target, "utf8"),
        "OLD\n",
        "the previous file is restored byte for byte"
      );
      assertEqual(calls, 2, "and the build is re-run so the generated files match what is on disk");
      assert(/refused/.test(veto.error), "the build's own message is carried into the summary");
      assert(/refused/.test(veto.restoreFailed), "a failed restore build is reported separately");

      veto = tool.writeAndVerify({
        enrichmentPath: target,
        text: "NEW\n",
        previous: null,
        runBuild: function () {
          return { ok: false, error: "nope" };
        }
      });
      assert(
        !fs.existsSync(target),
        "when there was no file before, a veto leaves no file behind either"
      );

      const good = tool.writeAndVerify({
        enrichmentPath: target,
        text: "GOOD\n",
        previous: null,
        runBuild: function () {
          return { ok: true };
        }
      });
      assert(good.ok && !good.restored, "a build that passes keeps the new file");
      assertEqual(fs.readFileSync(target, "utf8"), "GOOD\n", "with the new bytes");
      fs.rmSync(dir, { recursive: true, force: true });

      // -----------------------------------------------------------------
      // 11. The CLI surface.
      // -----------------------------------------------------------------
      assertEqual(tool.parseArgs(["--dry-run"]).dryRun, true, "--dry-run parses");
      assertEqual(tool.parseArgs(["--provider", "mock"]).provider, "mock", "--provider parses");
      let threw = false;
      try {
        tool.parseArgs(["--provider"]);
      } catch {
        threw = true;
      }
      assert(threw, "a flag with no value is an error, not a silent default");
      threw = false;
      try {
        tool.parseArgs(["--nonsense"]);
      } catch {
        threw = true;
      }
      assert(threw, "an unknown flag is an error");

      // -----------------------------------------------------------------
      // 12. The committed file still passes today's policy and today's build.
      // -----------------------------------------------------------------
      const committed = tool.loadEnrichment(tool.ENRICHMENT_PATH).doc;
      const liveIds = new Set(
        CATALOG.products.map(function (p) {
          return p.id;
        })
      );
      Object.keys(committed).forEach(function (id) {
        assert(liveIds.has(id), "committed enrichment entry " + id + " is a real product");
        const entry = committed[id];
        (entry.keywords || []).forEach(function (k) {
          const r = rules.screenKeyword({ term: k });
          assert(
            r.ok,
            "committed keyword " + JSON.stringify(k) + " (" + id + ") still passes",
            r.reason
          );
        });
        (entry.querySynonyms || []).forEach(function (s) {
          let refused = null;
          try {
            build.buildSearchSynonyms({}, [s]);
          } catch (e) {
            refused = e.message;
          }
          assert(
            !refused,
            "committed synonym " + JSON.stringify(s.key) + " (" + id + ") still builds",
            refused
          );
        });
      });

      // -----------------------------------------------------------------
      // 13. The prompt is generated from the policy, not typed out.
      // -----------------------------------------------------------------
      const fragment = rules.promptFragment();
      ["eczema", "psoriasis", "mosquito", "natural", "heal"].forEach(function (word) {
        assert(fragment.indexOf(word) !== -1, "the prompt names " + word);
      });
      assert(
        fragment.indexOf("Named diseases and treatment verbs are NOT synonyms") !== -1 &&
          fragment.indexOf("NO product") !== -1,
        "and tells the model that the router words are not synonyms and map to no product"
      );
      assert(
        fragment.indexOf("PUBLISHED") !== -1 && fragment.indexOf("never displayed") !== -1,
        "and states the two-surface rule in both directions"
      );
      const system = tool.buildSystemPrompt({ synonymKeys: ["lavender", "gift"] });
      assert(system.indexOf("lavender, gift") !== -1, "the system prompt shows the existing keys");
      assert(
        system.indexOf(String(rules.LIMITS.maxKeywords)) !== -1,
        "and the caps the filter will enforce"
      );
    })
    .then(function () {
      console.log("\n" + passed + " passed, " + failed + " failed");
      process.exit(failed ? 1 : 0);
    })
    .catch(function (err) {
      console.error("suite crashed: " + (err && err.stack ? err.stack : err));
      process.exit(1);
    });
}

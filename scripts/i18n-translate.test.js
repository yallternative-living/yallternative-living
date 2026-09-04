/**
 * @fileoverview Unit pins for scripts/i18n-translate.js and its two libraries.
 *
 * Node-only and offline. The provider layer is exercised through an injected
 * `fetchImpl`, so every branch that matters -- a 429 retried, a retired model
 * id fallen through to the alias, a schema-conformant hallucination -- is
 * driven here rather than hoped for in CI. Nothing in this file opens a
 * socket; there is no key on the machine that runs it.
 *
 * The three assertions that are held against the SHIPPED data rather than a
 * fixture, because a fixture would only test the fixture:
 *
 *   - none of the Traditional-Chinese characters the zh gate rejects appears
 *     anywhere in the committed zh.json, so the detector cannot quietly start
 *     rejecting good copy;
 *   - accepting nothing reproduces all seven files byte for byte, which is
 *     what stops a two-key addition from re-serialising 515 keys;
 *   - the claims table's source parity permits the live "calms the itch"
 *     blurb and still refuses a claim the English does not make.
 *
 * Run: node scripts/i18n-translate.test.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const tool = require("./i18n-translate.js");
const llm = require("./lib/llm.js");
const claimRules = require("./lib/i18n-claims-rules.js");
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

console.log("Running i18n-translate pins...\n");

const GLOSSARY = JSON.parse(
  fs.readFileSync(path.join(ROOT, "assets/data/brand-glossary.json"), "utf8")
);
const PROTECTED = GLOSSARY.protectedTerms;

/* A six-locale fixture with the same shape as the real files: two keys already
   complete, one key missing everywhere, one key whose German is empty. */
function fixture() {
  const enPhrases = {
    "nav.home": "Home",
    "pdp.addToCart": "Add to Cart",
    "auto.aTinThatCalms.aaaaaa": "A 2 oz tin that calms the itch underneath.",
    "tpl.enlarge": "Enlarge photo of {product}"
  };
  const filled = {
    "nav.home": { es: "Inicio", de: "Startseite", fr: "Accueil", ja: "ホーム", zh: "首页" },
    "pdp.addToCart": {
      es: "Añadir al carrito",
      de: "In den Warenkorb",
      fr: "Ajouter au panier",
      ja: "カートに入れる",
      zh: "加入购物车"
    },
    "auto.aTinThatCalms.aaaaaa": { es: "", de: "", fr: "", ja: "", zh: "" },
    "tpl.enlarge": {
      es: "Ampliar foto de {product}",
      de: "",
      fr: "Agrandir la photo de {product}",
      ja: "{product}の写真を拡大",
      zh: "放大{product}的照片"
    }
  };
  const localeDocs = {};
  tool.TARGET_LOCALES.forEach(function (code) {
    const phrases = {};
    Object.keys(enPhrases).forEach(function (key) {
      phrases[key] = filled[key][code];
    });
    localeDocs[code] = { meta: { code: code, name: code, dir: "ltr" }, phrases: phrases };
  });
  const basis = {};
  Object.keys(enPhrases).forEach(function (key) {
    basis[key] = build.digestEnglish(enPhrases[key]);
  });
  return {
    enDoc: { meta: { code: "en", name: "English", dir: "ltr" }, phrases: enPhrases },
    localeDocs: localeDocs,
    basisDoc: { note: "fixture", basis: basis },
    glossary: GLOSSARY
  };
}

function localePhrasesOf(ctx) {
  const out = {};
  tool.TARGET_LOCALES.forEach(function (code) {
    out[code] = ctx.localeDocs[code].phrases;
  });
  return out;
}

/* The provider layer itself -- retries, the pinned-to-alias model fallback,
   the call cap, the mock transform -- is scripts/lib/llm.js and is pinned by
   scripts/llm.test.js. What is asserted here is this bot's use of it. */

// ---------------------------------------------------------------------------
// 1. Every deterministic post-check, in both directions.
// ---------------------------------------------------------------------------
{
  function check(overrides) {
    return tool.checkTranslation(
      Object.assign(
        {
          key: "test.key",
          en: "Add to Cart",
          translated: "In den Warenkorb",
          locale: "de",
          protectedTerms: PROTECTED
        },
        overrides
      )
    );
  }

  assertEqual(check({}), null, "a good translation passes every check");
  assert(check({ translated: "" }) !== null, "an empty translation is refused");
  assert(check({ translated: "   " }) !== null, "a whitespace-only translation is refused");
  assert(check({ translated: undefined }) !== null, "a missing translation is refused");

  assertEqual(
    check({
      en: "Enlarge photo of {product}",
      translated: "Foto von {produkt} vergrößern"
    }) !== null,
    true,
    "a renamed placeholder is refused"
  );
  assertEqual(
    check({ en: "Enlarge photo of {product}", translated: "Foto von {product} vergrößern" }),
    null,
    "a preserved placeholder passes"
  );
  assert(
    check({ en: "Enlarge photo of {product}", translated: "Foto vergrößern" }) !== null,
    "a dropped placeholder is refused"
  );

  assert(
    check({
      en: "Try the Bourbon Beard Salve.",
      translated: "Probier den Bourbon-Bartbalsam."
    }) !== null,
    "a translated brand name is refused"
  );
  assertEqual(
    check({
      en: "Try the Bourbon Beard Salve.",
      translated: "Probier den Bourbon Beard Salve."
    }),
    null,
    "a preserved brand name passes"
  );

  assert(check({ translated: "Add to Cart" }) !== null, "an English passthrough is refused");
  assertEqual(
    check({ en: "$24.00", translated: "$24.00" }),
    null,
    "a string with nothing translatable in it may legitimately stay identical"
  );

  assert(
    check({ en: "Shop", translated: "Der ausgesprochen lange deutsche Einkaufsbereich hier" }) !==
      null,
    "an implausibly long translation is refused"
  );
  assert(
    check({
      en: "For anybody who's ever been told they're a little too much: taking up space was the plan.",
      translated: "Zu viel."
    }) !== null,
    "a truncated rewrite is refused"
  );

  assertEqual(
    tool.hasTraditionalChinese("加入购物车"),
    null,
    "Simplified Chinese carries no Traditional-only character"
  );
  assert(tool.hasTraditionalChinese("加入購物車") !== null, "Traditional Chinese is detected");
  assert(
    check({ locale: "zh", en: "Add to Cart", translated: "加入購物車" }) !== null,
    "a Traditional-Chinese value is refused in the Simplified locale"
  );
  assertEqual(
    check({ locale: "zh", en: "Add to Cart", translated: "加入购物车" }),
    null,
    "the Simplified equivalent passes"
  );

  assert(
    check({
      locale: "de",
      en: "Herbal goods for people who like plants.",
      translated: "Kräuterheilmittel für Pflanzenfreunde."
    }) !== null,
    "a claim the English does not make is refused"
  );
  assertEqual(
    check({
      locale: "fr",
      en: "A 2 oz tin that calms the itch underneath.",
      translated: "Une boîte de 2 oz qui apaise les démangeaisons."
    }),
    null,
    "source parity lets a faithful translation of 'calms' through"
  );
  assert(
    check({
      locale: "ja",
      en: "Small-batch and made by hand.",
      translated: "少量生産で、安心してお使いいただけます。"
    }) !== null,
    "安心 is refused whatever the English says"
  );
}

// ---------------------------------------------------------------------------
// 2. The Traditional detector, held against the shipped Simplified dictionary.
// ---------------------------------------------------------------------------
{
  const zh = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/data/locales/zh.json"), "utf8"));
  const offenders = Object.keys(zh.phrases).filter(function (key) {
    return tool.hasTraditionalChinese(zh.phrases[key]) !== null;
  });
  assertEqual(
    offenders.length,
    0,
    "no character in the Traditional list appears in the committed zh.json"
  );
  assert(
    tool.TRADITIONAL_ONLY.length >= 40,
    "the Traditional list is big enough to be worth having"
  );
}

// ---------------------------------------------------------------------------
// 3. Work items: what gets translated, and into which locales.
// ---------------------------------------------------------------------------
{
  const ctx = fixture();
  const work = tool.buildWorkItems({
    report: {
      new: [
        { key: "auto.newOne.bbbbbb", en: "A brand new line.", defer: null, kind: "text" },
        { key: "auto.deferred.cccccc", en: "Showing 20 of 20 goods", defer: "volatile-numeric" }
      ],
      changed: [],
      orphaned: []
    },
    enPhrases: ctx.enDoc.phrases,
    localePhrases: localePhrasesOf(ctx),
    basis: ctx.basisDoc.basis,
    digestFn: build.digestEnglish
  });

  const byKey = {};
  work.items.forEach(function (i) {
    byKey[i.key] = i;
  });
  assert(!byKey["nav.home"], "a fully translated key is not work");
  assertEqual(
    byKey["auto.aTinThatCalms.aaaaaa"].locales.length,
    5,
    "a key empty everywhere needs all five"
  );
  assertEqual(
    byKey["tpl.enlarge"].locales.join(","),
    "de",
    "a key missing one locale asks only for that one"
  );
  assertEqual(byKey["auto.newOne.bbbbbb"].isNew, true, "a report NEW entry is work");
  assert(!byKey["auto.deferred.cccccc"], "a deferred NEW entry is left for a human");

  const order = work.items.map(function (i) {
    return i.key;
  });
  assertEqual(
    order[order.length - 1],
    "auto.newOne.bbbbbb",
    "new keys come last, so the diff is an append"
  );

  const changedWork = tool.buildWorkItems({
    report: {
      new: [],
      changed: [{ key: "nav.home", en: "Home", previousDigest: "old" }],
      orphaned: []
    },
    enPhrases: ctx.enDoc.phrases,
    localePhrases: localePhrasesOf(ctx),
    basis: ctx.basisDoc.basis,
    digestFn: build.digestEnglish
  });
  const changedItem = changedWork.items.filter(function (i) {
    return i.key === "nav.home";
  })[0];
  assertEqual(changedItem.locales.length, 5, "a CHANGED key is re-translated in all five locales");
  assertEqual(changedItem.reason, "changed", "and is reported as changed, not as missing");

  const orphanWork = tool.buildWorkItems({
    report: { new: [], changed: [], orphaned: ["auto.gone.dddddd", "nav.retired"] },
    enPhrases: ctx.enDoc.phrases,
    localePhrases: localePhrasesOf(ctx),
    basis: ctx.basisDoc.basis,
    digestFn: build.digestEnglish
  });
  assertEqual(
    orphanWork.orphanRemovals.join(","),
    "auto.gone.dddddd",
    "only auto.* orphans are removable"
  );
  assertEqual(
    orphanWork.orphanReported.join(","),
    "nav.retired",
    "a hand-authored orphan is reported, never deleted"
  );
}

// ---------------------------------------------------------------------------
// 4. Batching and response validation.
// ---------------------------------------------------------------------------
{
  const items = [1, 2, 3, 4, 5].map(function (n) {
    return { key: "k" + n, locales: n === 5 ? ["de"] : ["es", "de"] };
  });
  const groups = tool.chunk(items, 2);
  assertEqual(groups.length, 3, "items are cut into fixed-size groups");
  assertEqual(groups[0].length, 2, "a full group is the batch size");
  assertEqual(groups[2].length, 1, "the last group is the remainder");
  assertEqual(
    tool.localesForGroup(groups[2]).join(","),
    "de",
    "a group asks only for the locales it needs"
  );
  assertEqual(
    tool.localesForGroup(groups[0]).join(","),
    "es,de",
    "and lists them in the dictionary's own locale order"
  );

  const group = [
    { key: "a", en: "A" },
    { key: "b", en: "B" }
  ];
  assertEqual(
    tool.validateBatchResponse({ items: [] }, group).ok,
    false,
    "an empty answer is refused"
  );
  assertEqual(tool.validateBatchResponse(null, group).ok, false, "a null answer is refused");
  assertEqual(
    tool.validateBatchResponse({ items: [{ id: "a", text: "x" }] }, group).ok,
    false,
    "an answer that skips a key is refused"
  );
  assertEqual(
    tool.validateBatchResponse(
      {
        items: [
          { id: "b", text: "y" },
          { id: "a", text: "x" }
        ]
      },
      group
    ).ok,
    true,
    "an answer carrying every id is accepted, whatever order it used"
  );
  assertEqual(
    tool.validateBatchResponse(
      {
        items: [
          { id: "a", text: 5 },
          { id: "b", text: "y" }
        ]
      },
      group
    ).ok,
    false,
    "a non-string translation is refused"
  );

  const schema = tool.batchSchema();
  assertEqual(schema.additionalProperties, false, "the schema is strict at the top level");
  assertEqual(schema.required.join(","), "items", "the schema requires the items array");
}

// ---------------------------------------------------------------------------
// 5. The prompt is generated from the committed data, not typed out.
// ---------------------------------------------------------------------------
{
  const ctx = fixture();
  const de = tool.buildSystemPrompt("de", ctx);
  assert(
    de.indexOf("Y'allternative Living") !== -1,
    "the German prompt carries the protected terms"
  );
  assert(de.indexOf("SHORT") !== -1, "the German prompt asks for short button strings");
  assert(
    de.indexOf('"beruhigt"') !== -1,
    "the German prompt names the banned words from the shared table"
  );
  assert(
    de.indexOf('"calm"') !== -1,
    "and names the English that licenses them, so the prompt matches the gate"
  );
  const zh = tool.buildSystemPrompt("zh", ctx);
  assert(zh.indexOf("SIMPLIFIED") !== -1, "the Chinese prompt demands Simplified");
  const ja = tool.buildSystemPrompt("ja", ctx);
  assert(
    ja.indexOf("安心") === -1 || ja.indexOf("not permitted") !== -1,
    "安心 appears only as a prohibition"
  );
  assert(ja.indexOf("です・ます") !== -1, "the Japanese prompt names the register");

  const payload = JSON.parse(
    tool.buildUserPayload("es", [{ key: "k", en: "Hi", kind: "aria-label" }])
  );
  assertEqual(payload.locale, "es", "the payload names the locale");
  assertEqual(payload.items[0].kind, "aria-label", "the payload carries the surface kind");
}

// ---------------------------------------------------------------------------
// 6. Writing: order stability, byte-identical formatting, atomicity.
// ---------------------------------------------------------------------------
{
  const enRaw = fs.readFileSync(path.join(ROOT, "assets/data/locales/en.json"), "utf8");
  const enDoc = JSON.parse(enRaw);
  const basisRaw = fs.readFileSync(
    path.join(ROOT, "assets/data/i18n-translation-basis.json"),
    "utf8"
  );
  const basisDoc = JSON.parse(basisRaw);
  const localeDocs = {};
  tool.TARGET_LOCALES.forEach(function (code) {
    localeDocs[code] = JSON.parse(
      fs.readFileSync(path.join(ROOT, "assets/data/locales", code + ".json"), "utf8")
    );
  });

  const untouched = tool.applyResults({
    enDoc: enDoc,
    localeDocs: localeDocs,
    basisDoc: basisDoc,
    accepted: {},
    removedKeys: [],
    digestFn: build.digestEnglish
  });
  assertEqual(
    JSON.stringify(untouched.en, null, 2) + "\n",
    enRaw,
    "accepting nothing reproduces en.json byte for byte"
  );
  assertEqual(
    JSON.stringify(untouched.basis, null, 2) + "\n",
    basisRaw,
    "accepting nothing reproduces the basis byte for byte"
  );
  tool.TARGET_LOCALES.forEach(function (code) {
    assertEqual(
      JSON.stringify(untouched.locales[code], null, 2) + "\n",
      fs.readFileSync(path.join(ROOT, "assets/data/locales", code + ".json"), "utf8"),
      "accepting nothing reproduces " + code + ".json byte for byte"
    );
  });

  const firstKey = Object.keys(enDoc.phrases)[0];
  const appended = tool.applyResults({
    enDoc: enDoc,
    localeDocs: localeDocs,
    basisDoc: basisDoc,
    accepted: {
      "auto.brandNew.eeeeee": {
        en: "A brand new line.",
        translations: { es: "es", de: "de", fr: "fr", ja: "ja", zh: "zh" },
        isNew: true,
        reason: "new"
      }
    },
    removedKeys: [],
    digestFn: build.digestEnglish
  });
  const appendedKeys = Object.keys(appended.en.phrases);
  assertEqual(appendedKeys[0], firstKey, "an append does not disturb the first key");
  assertEqual(
    appendedKeys[appendedKeys.length - 1],
    "auto.brandNew.eeeeee",
    "a new key lands at the end of en.json"
  );
  tool.TARGET_LOCALES.forEach(function (code) {
    assertEqual(
      Object.keys(appended.locales[code].phrases).join(" "),
      appendedKeys.join(" "),
      "all six files share one key order after an append (" + code + ")"
    );
  });
  assertEqual(
    appended.basis.basis["auto.brandNew.eeeeee"],
    build.digestEnglish("A brand new line."),
    "the new key's digest is recorded"
  );

  const removedKey = Object.keys(enDoc.phrases)[3];
  const pruned = tool.applyResults({
    enDoc: enDoc,
    localeDocs: localeDocs,
    basisDoc: basisDoc,
    accepted: {},
    removedKeys: [removedKey],
    digestFn: build.digestEnglish
  });
  assert(!(removedKey in pruned.en.phrases), "a removed orphan leaves en.json");
  assert(!(removedKey in pruned.basis.basis), "a removed orphan leaves the basis");
  tool.TARGET_LOCALES.forEach(function (code) {
    assert(
      !(removedKey in pruned.locales[code].phrases),
      "a removed orphan leaves " + code + ".json"
    );
  });

  const rewritten = tool.applyResults({
    enDoc: enDoc,
    localeDocs: localeDocs,
    basisDoc: basisDoc,
    accepted: {
      [firstKey]: {
        en: "Edited English",
        translations: { es: "a", de: "b", fr: "c", ja: "d", zh: "e" },
        isNew: false,
        reason: "changed"
      }
    },
    removedKeys: [],
    digestFn: build.digestEnglish
  });
  assertEqual(
    rewritten.basis.basis[firstKey],
    build.digestEnglish("Edited English"),
    "a re-translated key gets a fresh basis digest"
  );
  assertEqual(
    Object.keys(rewritten.basis.basis)[0],
    Object.keys(basisDoc.basis)[0],
    "the basis keeps its own committed order"
  );
}

/**
 * A client with the scripts/lib/llm.js shape, answering from a function of
 * (payload, item). Hand-rolled rather than llm.createClient({provider:"mock"})
 * because these cases need a per-key answer -- one that fails German -- which
 * the shared mock deliberately cannot produce.
 */
function stubClient(answer, maxCalls) {
  const cap = maxCalls === undefined ? 100 : maxCalls;
  const client = {
    telemetry: { provider: "stub", model: "stub", calls: 0, retries: 0, modelFallbacks: [] },
    fallbackWarning: function () {
      return null;
    },
    callsRemaining: function () {
      return Math.max(0, cap - client.telemetry.calls);
    },
    completeJSON: async function (spec) {
      client.telemetry.calls++;
      const payload = JSON.parse(spec.user);
      return {
        items: payload.items.map(function (item) {
          return { id: item.id, text: answer(payload, item) };
        })
      };
    }
  };
  return client;
}

/**
 * A client whose provider refuses the key: the first call throws a 403 and
 * marks the client unavailable, every later call is refused by the client
 * itself with LLM_PROVIDER_UNAVAILABLE -- the shape scripts/lib/llm.js has
 * after a blocked key (dry run 2026-09-04: 51 calls, 990 identical drops).
 */
function deadKeyClient() {
  let dead = null;
  const client = {
    telemetry: { provider: "stub", model: "stub", calls: 0, retries: 0, modelFallbacks: [] },
    fallbackWarning: function () {
      return null;
    },
    callsRemaining: function () {
      return 100 - client.telemetry.calls;
    },
    unavailable: function () {
      return dead;
    },
    completeJSON: async function () {
      if (dead) {
        const e = new Error("provider unavailable: " + dead.message);
        e.code = "LLM_PROVIDER_UNAVAILABLE";
        throw e;
      }
      client.telemetry.calls++;
      dead = new Error("HTTP 403 from gemini/x: PERMISSION_DENIED (API_KEY_SERVICE_BLOCKED)");
      dead.status = 403;
      throw dead;
    }
  };
  return client;
}

async function deadKeyPins() {
  const ctx = fixture();
  const report = {
    new: [
      { key: "auto.one.111111", en: "One.", defer: null, kind: "text" },
      { key: "auto.two.222222", en: "Two.", defer: null, kind: "text" },
      { key: "auto.three.333333", en: "Three.", defer: null, kind: "text" }
    ],
    changed: [],
    orphaned: []
  };
  const client = deadKeyClient();
  const result = await tool.translateAll({
    ctx: ctx,
    report: report,
    client: client,
    batchSize: 1
  });
  assertEqual(client.telemetry.calls, 1, "a dead key costs exactly one call, not the whole budget");
  assert(
    result.providerUnavailable &&
      result.providerUnavailable.indexOf("API_KEY_SERVICE_BLOCKED") !== -1,
    "the run records why it stopped",
    result.providerUnavailable
  );
  /* The fixture carries work items of its own, so count from the work list:
     with batches of one, everything after the first item was never attempted. */
  assertEqual(
    result.deferredKeys,
    result.work.items.length - 1,
    "the groups never attempted are left for the next run"
  );
  assertEqual(
    result.failed.length,
    1,
    "only the string that actually received the refusal is a drop"
  );
  assert(
    Object.keys(result.accepted).length === 0 && !("auto.one.111111" in result.docs.en.phrases),
    "and nothing reached any dictionary"
  );
}

/** A provider in a 503 storm: every call is a retryable 503. */
function stormClient() {
  const client = {
    telemetry: { provider: "stub", model: "stub", calls: 0, retries: 0, modelFallbacks: [] },
    fallbackWarning: function () {
      return null;
    },
    callsRemaining: function () {
      return Infinity;
    },
    unavailable: function () {
      return null;
    },
    completeJSON: async function () {
      client.telemetry.calls++;
      const e = new Error("HTTP 503 from gemini/x: UNAVAILABLE: high demand");
      e.status = 503;
      e.retryable = true;
      throw e;
    }
  };
  return client;
}

async function stormPins() {
  const ctx = fixture();
  const report = {
    new: [
      { key: "auto.one.111111", en: "One.", defer: null, kind: "text" },
      { key: "auto.two.222222", en: "Two.", defer: null, kind: "text" },
      { key: "auto.three.333333", en: "Three.", defer: null, kind: "text" }
    ],
    changed: [],
    orphaned: []
  };
  const client = stormClient();
  const waits = [];
  const result = await tool.translateAll({
    ctx: ctx,
    report: report,
    client: client,
    batchSize: 1,
    sleep: async function (ms) {
      waits.push(ms);
    }
  });
  assertEqual(client.telemetry.calls, 4, "three failures, one pause, a fourth failure, then stop");
  assertEqual(waits.length, 1, "the pause happened once");
  assert(waits[0] >= 60000, "and it was a real pause, not a retry backoff");
  assert(
    result.providerDegraded && result.providerDegraded.indexOf("503") !== -1,
    "the run records the storm",
    result.providerDegraded
  );
  assertEqual(result.failed.length, 0, "a transient error drops nothing");
  assertEqual(result.deferredKeys, result.work.items.length, "every key is left for the next run");
  assert(!("auto.one.111111" in result.docs.en.phrases), "and nothing was written");
}

async function runAll() {
  await runPins();
  await deadKeyPins();
  await stormPins();
}

// ---------------------------------------------------------------------------
// 7. A whole run: atomicity, the call cap, and the failure list.
// ---------------------------------------------------------------------------
async function runPins() {
  const report = {
    new: [{ key: "auto.newOne.bbbbbb", en: "A brand new line.", defer: null, kind: "text" }],
    changed: [],
    orphaned: ["auto.gone.dddddd"]
  };

  /* Every locale answers well except German on one key, which comes back
     still in English. That key must appear in NO file -- including en.json. */
  {
    const ctx = fixture();
    ctx.enDoc.phrases["auto.gone.dddddd"] = "Retired copy.";
    tool.TARGET_LOCALES.forEach(function (code) {
      ctx.localeDocs[code].phrases["auto.gone.dddddd"] = "x" + code;
    });
    ctx.basisDoc.basis["auto.gone.dddddd"] = build.digestEnglish("Retired copy.");

    const client = stubClient(function (payload, item) {
      const bad = payload.locale === "de" && item.id === "auto.newOne.bbbbbb";
      return bad ? item.text : "[" + payload.locale + "] " + item.text;
    });

    const result = await tool.translateAll({ ctx: ctx, report: report, client: client });
    assert(
      !("auto.newOne.bbbbbb" in result.accepted),
      "a key that failed one locale is not accepted"
    );
    assert(!("auto.newOne.bbbbbb" in result.docs.en.phrases), "and never reaches en.json");
    tool.TARGET_LOCALES.forEach(function (code) {
      assert(
        !("auto.newOne.bbbbbb" in result.docs.locales[code].phrases),
        "and never reaches " + code + ".json"
      );
    });
    assert(!("auto.newOne.bbbbbb" in result.docs.basis.basis), "and never reaches the basis");
    const de = result.failed.filter(function (f) {
      return f.key === "auto.newOne.bbbbbb" && f.locale === "de";
    });
    assertEqual(de.length, 1, "the failure is listed once, with its locale");
    assert(
      de[0].reason.indexOf("passthrough") !== -1,
      "and names the rule that fired",
      de[0].reason
    );

    assert(
      "auto.aTinThatCalms.aaaaaa" in result.docs.en.phrases,
      "the keys that passed are still written"
    );
    assertEqual(
      result.docs.locales.fr.phrases["auto.aTinThatCalms.aaaaaa"],
      "[fr] A 2 oz tin that calms the itch underneath.",
      "with their translations in place"
    );
    assert(
      !("auto.gone.dddddd" in result.docs.en.phrases),
      "the auto.* orphan was removed from en.json"
    );
    assert(!("auto.gone.dddddd" in result.docs.locales.ja.phrases), "and from the locale files");
  }

  /* The call cap stops at a group boundary and leaves whole keys for the next
     run rather than half-translating any of them. */
  {
    const ctx = fixture();
    const client = stubClient(function (payload, item) {
      return "[" + payload.locale + "] " + item.text;
    }, 1);
    const result = await tool.translateAll({
      ctx: ctx,
      report: report,
      client: client,
      batchSize: 1
    });
    assert(result.deferredKeys > 0, "the cap leaves keys for the next run");
    assertEqual(
      Object.keys(result.accepted).length,
      0,
      "a cap that stops before the first group accepts nothing rather than half a key"
    );
    tool.TARGET_LOCALES.forEach(function (code) {
      assertEqual(
        result.docs.locales[code].phrases["auto.aTinThatCalms.aaaaaa"],
        "",
        "and leaves the untranslated key untouched in " + code + ".json"
      );
    });
    assertEqual(client.telemetry.calls, 0, "and makes no call it cannot finish");
  }

  /* End to end on the real mock provider, including the corruption hook: the
     glossary check drops exactly that key and lists it. */
  {
    const ctx = fixture();
    ctx.enDoc.phrases["auto.brandLine.ffffff"] = "Made by hand at Y'allternative Living.";
    tool.TARGET_LOCALES.forEach(function (code) {
      ctx.localeDocs[code].phrases["auto.brandLine.ffffff"] = "";
    });
    ctx.basisDoc.basis["auto.brandLine.ffffff"] = build.digestEnglish(
      "Made by hand at Y'allternative Living."
    );
    const client = llm.createClient({ provider: "mock" }, { LLM_MOCK_CORRUPT: "Made by hand" });
    const result = await tool.translateAll({
      ctx: ctx,
      report: { new: [], changed: [], orphaned: [] },
      client: client
    });
    assertEqual(
      result.docs.en.phrases["auto.brandLine.ffffff"],
      "Made by hand at Y'allternative Living.",
      "the English of a key whose translations were all rejected is left exactly as it was"
    );
    tool.TARGET_LOCALES.forEach(function (code) {
      assertEqual(
        result.docs.locales[code].phrases["auto.brandLine.ffffff"],
        "",
        "no corrupted translation was written for " + code
      );
    });
    const reasons = result.failed
      .filter(function (f) {
        return f.key === "auto.brandLine.ffffff";
      })
      .map(function (f) {
        return f.reason;
      });
    assertEqual(reasons.length, 5, "the corrupted key failed in all five locales");
    assert(
      reasons[0].indexOf("protected term") !== -1,
      "and the reason names the glossary rule",
      reasons[0]
    );
  }
}

// ---------------------------------------------------------------------------
// 8. Argument parsing.
// ---------------------------------------------------------------------------
{
  const parsed = tool.parseArgs([
    "--report",
    "r.json",
    "--provider",
    "mock",
    "--dry-run",
    "--max-calls",
    "5"
  ]);
  assertEqual(parsed.report, "r.json", "--report takes its path");
  assertEqual(parsed.provider, "mock", "--provider takes its id");
  assertEqual(parsed.dryRun, true, "--dry-run parses");
  assertEqual(parsed.maxCalls, 5, "--max-calls takes a number");
  const bare = tool.parseArgs([]);
  assertEqual(bare.dryRun, false, "a bare run is not a dry run");
  assertEqual(bare.report, null, "a bare run runs discovery itself");
  ["--nope", "--report", "--provider"].forEach(function (flag) {
    let threw = false;
    try {
      tool.parseArgs([flag]);
    } catch {
      threw = true;
    }
    assert(threw, "a bad flag is refused: " + flag);
  });
}

// ---------------------------------------------------------------------------
// 9. The claims table is shared, not copied.
// ---------------------------------------------------------------------------
{
  assert(
    typeof claimRules.claimOffenses === "function" &&
      typeof claimRules.claimPromptFragment === "function",
    "the claims module exports both the gate and the prompt fragment"
  );
  const fragment = claimRules.claimPromptFragment("zh");
  claimRules.CLAIM_WORDS.zh.forEach(function (word) {
    assert(fragment.indexOf(word) !== -1, "the zh prompt fragment names " + word);
  });
  assert(
    fragment.indexOf("安心") !== -1 && fragment.indexOf("not permitted") !== -1,
    "and marks the never-licensed terms as such"
  );
}

runAll()
  .then(function () {
    console.log("\n" + passed + " passed, " + failed + " failed");
    process.exit(failed ? 1 : 0);
  })
  .catch(function (err) {
    console.error("suite crashed: " + (err && err.stack ? err.stack : err));
    process.exit(1);
  });

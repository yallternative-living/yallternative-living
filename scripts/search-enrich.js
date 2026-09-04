#!/usr/bin/env node
/**
 * @fileoverview The search-vocabulary bot: writes the words a shopper types
 * that the owner would never think to write down, without ever touching her
 * products.json and without publishing anything that reads as a claim.
 *
 * WHY THIS EXISTS. The site's search is good at the words that are already in
 * the catalogue and helpless at the ones that are not. A shopper looking for
 * the bug spray types "that bug stuff"; a shopper buying in December types
 * "stocking stuffer"; a shopper who just came off the Palmetto Trail types
 * "post hike"; and a fair share of everyone types "lavendar". Those words have
 * to live somewhere, and the one place they must NOT live is
 * assets/data/products.json -- that file is the owner's, it is what the CMS
 * writes, and a bot editing it would put a machine's wording in the middle of
 * her copy and re-open the compliance review every time it ran.
 *
 * So they live in assets/data/search-enrichment.json, which is bot-owned, and
 * scripts/build-site-data.js merges them into the search index only. Her
 * keywords come first and win every tie. Nothing here is ever written back.
 *
 * THE TWO SURFACES THIS BOT WRITES are the whole design, and
 * scripts/lib/search-enrichment-rules.js is the policy:
 *
 *   keywords       PUBLISHED with the product in assets/js/search-data.js.
 *                  Full ban list -- no treatment word, no symptom, no
 *                  condition, no pesticide claim, no unsubstantiated "natural".
 *   querySynonyms  only ever rewrite what the shopper TYPED, and are rendered
 *                  nowhere. LAY symptom and sensory words are WANTED here: a
 *                  shopper who types "itchy skin" should reach the Dry, Rough
 *                  Skin products rather than an empty page.
 *
 * A named disease ("eczema", "psoriasis") and a treatment verb are neither. As
 * of the 2026-09-04 legal brief they belong to a THIRD surface this bot does
 * not write and cannot grow: MEDICAL_QUERY_TERMS, a fixed list in the rules
 * module that maps to no product at all and drives a non-claim note in the
 * client. The prompt tells the model to propose none of them, and the filter
 * refuses them on both surfaces if it does anyway.
 *
 * That asymmetry is the point, and it is enforced deterministically. There is
 * no second model reviewing the first: every failure mode that matters here is
 * lexical and enumerable, so a filter that names the word it refused beats a
 * reviewer that is right most of the time. Every drop is logged with its
 * reason, and the workflow files them on one issue.
 *
 * WHEN IT REGENERATES. Never, unless it has to. Each entry records a digest of
 * the product copy it was generated from (name, blurb, description,
 * ingredients, category) plus the policy version. A product is re-enriched when
 * it is new, when that copy changes, or when the policy changes; otherwise its
 * entry is carried through byte for byte, which is what makes two runs in a row
 * produce no diff. A product deleted from products.json drops out of the file
 * on the next run.
 *
 * THE BUILD HAS THE LAST WORD. After writing, this script runs
 * scripts/build-site-data.js. If the build refuses the file -- and it will, on
 * any query-side term SEARCH_SYNONYM_BANNED names -- the previous file is
 * restored, the build is re-run to put the generated files back, and the run
 * exits non-zero having changed nothing. The guard in the build is meant to be
 * able to veto the bot, so the bot is written to lose that argument.
 *
 * Run:
 *   node scripts/search-enrich.js                       # needs GEMINI_API_KEY
 *   node scripts/search-enrich.js --dry-run             # writes nothing
 *   node scripts/search-enrich.js --provider mock       # no key, no network
 *   node scripts/search-enrich.js --summary out.json
 *
 * Progress goes to stderr; stdout is nothing but the JSON summary.
 * Exit 0 when the run did what it could (dropped items are data, not a crash);
 * exit 2 on a real error -- no key, an unreadable catalogue, a build veto.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const build = require("./build-site-data.js");
const rules = require("./lib/search-enrichment-rules.js");
const llm = require("./lib/llm.js");

const ROOT = path.resolve(__dirname, "..");
const CATALOG_PATH = "assets/data/products.json";
const ENRICHMENT_PATH = "assets/data/search-enrichment.json";
const SEARCH_DATA_PATH = "assets/js/search-data.js";
const BUILD_SCRIPT = path.join(__dirname, "build-site-data.js");

/* One call covers the whole catalogue today (20 products). The chunking exists
   so that stays true at 200: a model asked to think about 200 products in one
   response starts writing the same eight words for all of them. */
const DEFAULT_BATCH_SIZE = 20;

/* ---------------------------------------------------------------------------
   Pure logic. Everything down to runCli() is offline and side-effect free, so
   scripts/search-enrich.test.js can drive every branch with no network and no
   temp directory.
   --------------------------------------------------------------------------- */

function readJson(rel) {
  const p = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * The document, serialised. Two-space indent, trailing newline, product ids in
 * alphabetical order and a fixed field order inside every entry -- so the file
 * is stable under a catalogue reorder and a diff only ever shows real work.
 */
function serializeDocument(doc) {
  const out = {};
  Object.keys(doc)
    .sort()
    .forEach(function (id) {
      const entry = doc[id] || {};
      out[id] = {
        keywords: entry.keywords || [],
        querySynonyms: entry.querySynonyms || [],
        source: {
          model: (entry.source || {}).model || "",
          digest: (entry.source || {}).digest || "",
          policy: (entry.source || {}).policy || "",
          date: (entry.source || {}).date || ""
        }
      };
    });
  return JSON.stringify(out, null, 2) + "\n";
}

/**
 * Write through a temp file in the same directory, then rename. A reader --
 * including scripts/build-site-data.js, which runs on every deploy -- can never
 * observe a half-written file, because rename within a directory is atomic.
 */
function writeAtomic(rel, text) {
  const full = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  const tmp = full + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, full);
}

/**
 * The copy an entry was generated from, hashed. Only the fields that change
 * what a sensible search word would be: a price edit or a stock change must not
 * cost an LLM call.
 */
function digestProduct(product) {
  const basis = JSON.stringify([
    String(product.name || ""),
    String(product.blurb || ""),
    String(product.description || ""),
    Array.isArray(product.ingredients) ? product.ingredients.map(String) : [],
    String(product.category || ""),
    Array.isArray(product.concerns) ? product.concerns.map(String) : []
  ]);
  return crypto.createHash("sha1").update(basis, "utf8").digest("hex").slice(0, 10);
}

/**
 * What this run has to do.
 *
 * @param {{products: !Array<!Object>, enrichment: !Object,
 *          policyVersion: (string|undefined)}} input
 * @return {{needed: !Array<!Object>, unchanged: !Array<string>, removed: !Array<string>,
 *           carried: !Object}}
 */
function planWork(input) {
  const products = input.products || [];
  const enrichment = input.enrichment || {};
  const policy = input.policyVersion || rules.POLICY_VERSION;

  const needed = [];
  const unchanged = [];
  const carried = {};
  const liveIds = new Set();

  products.forEach(function (product) {
    const id = String(product.id || "");
    if (!id) return;
    liveIds.add(id);
    const digest = digestProduct(product);
    const entry = enrichment[id];
    const source = (entry && entry.source) || {};
    const fresh = entry && source.digest === digest && source.policy === policy;
    if (fresh) {
      unchanged.push(id);
      carried[id] = entry;
      return;
    }
    needed.push({ id: id, product: product, digest: digest, reason: entry ? "changed" : "new" });
  });

  const removed = Object.keys(enrichment).filter(function (id) {
    return !liveIds.has(id);
  });

  return { needed: needed, unchanged: unchanged, removed: removed, carried: carried };
}

/** The synonym keys the shipped index already has, for the prompt. */
function shippedSynonymKeys(rel) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(ROOT, rel || SEARCH_DATA_PATH), "utf8");
  } catch {
    return [];
  }
  /* Anchor on the assignment, not on the first brace: the file opens with a
     JSDoc block containing "{!Object}", and starting there parses nothing. */
  const marker = "window.YL_SEARCH_INDEX = ";
  const at = raw.indexOf(marker);
  if (at === -1) return [];
  const start = at + marker.length;
  const end = raw.lastIndexOf("}");
  if (end <= start) return [];
  try {
    const index = JSON.parse(raw.slice(start, end + 1));
    return Object.keys(index.synonyms || {});
  } catch {
    return [];
  }
}

/** The JSON schema one batch comes back in. */
function batchSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["products"],
    properties: {
      products: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "keywords", "querySynonyms"],
          properties: {
            id: { type: "string" },
            keywords: { type: "array", items: { type: "string" } },
            querySynonyms: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["key", "terms"],
                properties: {
                  key: { type: "string" },
                  terms: { type: "array", items: { type: "string" } }
                }
              }
            }
          }
        }
      }
    }
  };
}

function buildSystemPrompt(ctx) {
  const keys = (ctx && ctx.synonymKeys) || [];
  return [
    "You write SEARCH VOCABULARY for Y'allternative Living, a small-batch Appalachian apothecary",
    "in Landrum, South Carolina. The voice is warm, dry and irreverent -- Southern gothic, queer,",
    "handmade, unfussy. You are not writing marketing copy. You are writing the words real people",
    "type into a search box when they are looking for one of these products and cannot remember",
    "what it is called: uses, occasions, gift contexts, ingredient names, plain-language",
    "descriptors ('that bug stuff', 'the sparkly oil'), and 2-4 realistic misspellings of the",
    "product name or its ingredients.",
    "",
    rules.promptFragment(),
    "",
    "REUSE THE EXISTING SYNONYM KEYS wherever one fits, so the table stays small and the groups",
    "keep one intent each. The keys that already exist:",
    "  " + keys.join(", "),
    "A key is lowercase with underscores for spaces. Terms are lowercase, at most " +
      rules.LIMITS.maxTermChars +
      " characters,",
    "and must be words a shopper would actually type.",
    "",
    "CAPS, per product: at most " +
      rules.LIMITS.maxKeywords +
      " keywords and at most " +
      rules.LIMITS.maxSynonymEntries +
      " querySynonyms entries.",
    "Do not repeat a word that is already in the product's name or in the keywords you are shown.",
    "Do not name another company's brand.",
    "",
    "Return exactly one item for every product you are given, with the same id. Output nothing but",
    "the JSON object the schema describes."
  ].join("\n");
}

function buildUserPayload(group, concerns, categories) {
  return JSON.stringify(
    {
      concernVocabulary: concerns || [],
      categories: categories || [],
      products: group.map(function (item) {
        const p = item.product;
        return {
          id: item.id,
          name: p.name || "",
          category: p.category || "",
          blurb: p.blurb || p.description || "",
          scent: p.scent || "",
          ingredients: Array.isArray(p.ingredients) ? p.ingredients : [],
          concerns: Array.isArray(p.concerns) ? p.concerns : [],
          existingKeywords: Array.isArray(p.keywords) ? p.keywords : []
        };
      })
    },
    null,
    2
  );
}

/**
 * The offline responder. Deliberately crude AND deliberately dirty: it emits
 * plausible items alongside five violations -- a condition word as a keyword, a
 * "cures ..." synonym term, a named disease proposed as a synonym, a string over
 * the character cap, and a duplicate of one of the owner's own keywords -- so a
 * proof run with no key exercises the drop paths for real instead of asserting
 * they exist.
 */
function mockResponder(spec) {
  const payload = JSON.parse(spec.user);
  return {
    products: (payload.products || []).map(function (p) {
      const nameWords = String(p.name || "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
      const stem = nameWords[nameWords.length - 1] || "salve";
      const misspelling = stem.length > 3 ? stem.slice(0, -1) + "e" : stem + "e";
      const ingredient = String((p.ingredients || [])[0] || "beeswax")
        .toLowerCase()
        .split(",")[0]
        .trim()
        .slice(0, 30);
      return {
        id: p.id,
        keywords: [
          "mock " + stem,
          misspelling,
          ingredient,
          "stocking stuffer",
          "gift for a friend",
          /* VIOLATION 1: a condition word on the published surface. */
          "eczema",
          /* VIOLATION 2: over the character cap. */
          "a mock keyword deliberately written far past the forty character cap",
          /* VIOLATION 3: a word the owner already wrote. */
          String((p.existingKeywords || [])[0] || "gift")
        ],
        querySynonyms: [
          { key: "gift", terms: ["secret santa", "white elephant gift"] },
          /* VIOLATIONS 4 and 5: a medicine word and two named diseases, beside a
             LAY symptom phrase. Only the lay phrase survives -- that asymmetry is
             the thing being proved, and since the 2026-09-04 brief the diseases
             fall on the router's side of it, not the synonym table's. */
          { key: "dry_skin", terms: ["itchy skin", "eczema", "cures itch", "psoriasis flare"] },
          {
            key: "mock_" + (p.category || "shop").replace(/[^a-z0-9]+/g, "_"),
            terms: ["mock " + stem]
          }
        ]
      };
    })
  };
}

/**
 * Turn one model response into entries, dropping everything the policy refuses
 * and recording why. Nothing here trusts the response: an item for a product
 * that was not asked about is ignored, a missing item leaves that product
 * un-enriched rather than half-enriched.
 *
 * @return {{entries: !Object, dropped: !Array<{id: string, item: string, reason: string}>,
 *           missing: !Array<string>}}
 */
function screenBatch(input) {
  const group = input.group || [];
  const response = input.response || {};
  const model = input.model || "";
  const date = input.date || new Date().toISOString().slice(0, 10);
  const policy = input.policyVersion || rules.POLICY_VERSION;

  const byId = new Map();
  (Array.isArray(response.products) ? response.products : []).forEach(function (item) {
    if (item && typeof item.id === "string" && !byId.has(item.id)) byId.set(item.id, item);
  });

  const entries = {};
  const dropped = [];
  const missing = [];

  group.forEach(function (work) {
    const item = byId.get(work.id);
    if (!item) {
      missing.push(work.id);
      return;
    }
    const ownerKeywords = Array.isArray(work.product.keywords) ? work.product.keywords : [];
    const nameTokens = rules.wordsOf(work.product.name || "");
    const taken = new Set();
    const keywords = [];
    (Array.isArray(item.keywords) ? item.keywords : []).forEach(function (raw) {
      if (keywords.length >= rules.LIMITS.maxKeywords) {
        dropped.push({
          id: work.id,
          item: String(raw),
          reason: "over the " + rules.LIMITS.maxKeywords + "-keyword cap"
        });
        return;
      }
      const screened = rules.screenKeyword({
        term: raw,
        ownerKeywords: ownerKeywords,
        nameTokens: nameTokens,
        taken: taken
      });
      if (!screened.ok) {
        dropped.push({ id: work.id, item: String(raw), reason: screened.reason });
        return;
      }
      taken.add(screened.value);
      keywords.push(screened.value);
    });

    const keysTaken = new Set();
    const querySynonyms = [];
    (Array.isArray(item.querySynonyms) ? item.querySynonyms : []).forEach(function (raw) {
      if (querySynonyms.length >= rules.LIMITS.maxSynonymEntries) {
        dropped.push({
          id: work.id,
          item: JSON.stringify(raw),
          reason: "over the " + rules.LIMITS.maxSynonymEntries + "-synonym cap"
        });
        return;
      }
      const screened = rules.screenSynonymEntry({ entry: raw, taken: keysTaken });
      (screened.dropped || []).forEach(function (d) {
        dropped.push({ id: work.id, item: d.item, reason: d.reason });
      });
      if (!screened.ok) {
        dropped.push({
          id: work.id,
          item: raw && raw.key ? String(raw.key) : JSON.stringify(raw),
          reason: screened.reason
        });
        return;
      }
      /* The build is the authority on what a synonym may contain. Run the
         candidate through the exact function the build will run, one entry at a
         time, so a word the policy missed becomes a logged drop here instead of
         a red deploy an hour later. */
      try {
        build.buildSearchSynonyms({}, [screened.value]);
      } catch (e) {
        dropped.push({
          id: work.id,
          item: screened.value.key,
          reason: "the build refuses it: " + e.message
        });
        return;
      }
      keysTaken.add(screened.value.key);
      querySynonyms.push(screened.value);
    });

    if (!keywords.length && !querySynonyms.length) {
      /* Nothing survived. Still record the entry: the digest is the claim "this
         copy was looked at", and without it every run would ask again. */
      dropped.push({ id: work.id, item: "(whole product)", reason: "nothing survived screening" });
    }
    entries[work.id] = {
      keywords: keywords,
      querySynonyms: querySynonyms,
      source: { model: model, digest: work.digest, policy: policy, date: date }
    };
  });

  return { entries: entries, dropped: dropped, missing: missing };
}

/** Fixed-size groups, preserving order. */
function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The run itself, with the client injected so the unit suite drives every
 * branch offline.
 *
 * @return {!Promise<!Object>}
 */
async function enrichAll(input) {
  const catalog = input.catalog;
  const enrichment = input.enrichment || {};
  const client = input.client;
  const batchSize = input.batchSize || DEFAULT_BATCH_SIZE;
  const log = input.log || function () {};

  const products = Array.isArray(catalog.products) ? catalog.products : [];
  const plan = planWork({ products: products, enrichment: enrichment });

  const concerns = (catalog.concerns || []).map(function (c) {
    return { id: c.id, name: c.name };
  });
  const categories = (catalog.categories || []).map(function (c) {
    return c.id || c;
  });
  const synonymKeys = input.synonymKeys || shippedSynonymKeys();

  const generated = {};
  const dropped = [];
  const missing = [];
  let deferred = 0;

  const groups = chunk(plan.needed, batchSize);
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    if (client.callsRemaining() < 1) {
      deferred += groups.slice(g).reduce(function (n, rest) {
        return n + rest.length;
      }, 0);
      log("Call cap reached: leaving " + deferred + " product(s) for the next run.");
      break;
    }
    log("batch " + (g + 1) + "/" + groups.length + ": " + group.length + " product(s)");
    let response = null;
    try {
      response = await client.completeJSON({
        system: buildSystemPrompt({ synonymKeys: synonymKeys }),
        user: buildUserPayload(group, concerns, categories),
        schema: batchSchema(),
        schemaName: "search_enrichment",
        temperature: 0.4
      });
    } catch (err) {
      /* A failed batch is not a failed run. The products in it keep whatever
         entry they already had and are picked up next time. */
      const reason = err && err.message ? err.message : String(err);
      log("batch " + (g + 1) + " failed: " + reason);
      group.forEach(function (work) {
        dropped.push({
          id: work.id,
          item: "(whole product)",
          reason: "model call failed: " + reason
        });
        missing.push(work.id);
      });
      continue;
    }
    const screened = screenBatch({
      group: group,
      response: response,
      model: client.telemetry.model,
      date: input.date
    });
    Object.keys(screened.entries).forEach(function (id) {
      generated[id] = screened.entries[id];
    });
    screened.dropped.forEach(function (d) {
      dropped.push(d);
    });
    screened.missing.forEach(function (id) {
      missing.push(id);
      dropped.push({
        id: id,
        item: "(whole product)",
        reason: "the model returned no item for it"
      });
    });
  }

  /* The new document: everything unchanged, carried verbatim, plus whatever
     this run generated. Products that left products.json are simply not
     copied, which is the whole cleanup mechanism. Entries whose product still
     needs work but whose batch failed keep their previous value. */
  const document = {};
  Object.keys(plan.carried).forEach(function (id) {
    document[id] = plan.carried[id];
  });
  plan.needed.forEach(function (work) {
    if (generated[work.id]) {
      document[work.id] = generated[work.id];
    } else if (enrichment[work.id]) {
      document[work.id] = enrichment[work.id];
    }
  });

  return {
    plan: plan,
    document: document,
    generated: Object.keys(generated),
    dropped: dropped,
    missing: missing,
    deferred: deferred
  };
}

function summarize(result, client, dryRun) {
  return {
    products: result.plan.unchanged.length + result.plan.needed.length,
    generated: result.generated.length,
    unchanged: result.plan.unchanged.length,
    removed: result.plan.removed,
    deferredToNextRun: result.deferred,
    dropped: result.dropped,
    modelUsed: client.telemetry.model,
    provider: client.telemetry.provider,
    calls: client.telemetry.calls,
    fallbackWarning: client.fallbackWarning(),
    dryRun: !!dryRun
  };
}

/**
 * Write, then let the build vote. On a veto the previous bytes go back and the
 * build is run again so the generated files match the restored source; the run
 * then fails, having changed nothing.
 *
 * @param {{text: string, previous: (string|null), runBuild: (!Function|undefined),
 *          enrichmentPath: (string|undefined)}} input
 * @return {{ok: boolean, restored: boolean, error: (string|undefined),
 *           restoreFailed: (string|undefined)}}
 */
function writeAndVerify(input) {
  const rel = input.enrichmentPath || ENRICHMENT_PATH;
  const full = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  const runBuild = input.runBuild || defaultRunBuild;

  writeAtomic(full, input.text);
  const first = runBuild();
  if (first.ok) return { ok: true, restored: false };

  if (input.previous === null || input.previous === undefined) {
    try {
      fs.unlinkSync(full);
    } catch {
      /* already gone */
    }
  } else {
    writeAtomic(full, input.previous);
  }
  const second = runBuild();
  return {
    ok: false,
    restored: true,
    error: first.error,
    restoreFailed: second.ok ? undefined : second.error
  };
}

function defaultRunBuild() {
  const res = spawnSync(process.execPath, [BUILD_SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (res.error) return { ok: false, error: res.error.message };
  if (res.status === 0) return { ok: true };
  /* Node prints the message first and then a stack. Keeping the LAST lines
     would keep the stack and throw away the sentence that says what was wrong,
     so drop the frames and keep the top of what is left. */
  const detail = String(res.stderr || res.stdout || "")
    .trim()
    .split("\n")
    .filter(function (line) {
      return !/^\s*at\s/.test(line) && !/^Node\.js v/.test(line);
    })
    .slice(0, 14)
    .join("\n");
  return { ok: false, error: "scripts/build-site-data.js exited " + res.status + "\n" + detail };
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    provider: null,
    models: null,
    summary: null,
    batchSize: null,
    maxCalls: null
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--provider") args.provider = argv[++i];
    else if (a === "--models") args.models = argv[++i];
    else if (a === "--summary") args.summary = argv[++i];
    else if (a === "--batch-size") args.batchSize = Number(argv[++i]);
    else if (a === "--max-calls") args.maxCalls = Number(argv[++i]);
    else throw new Error("Unknown argument: " + a);
  }
  ["provider", "models", "summary"].forEach(function (flag) {
    if (argv.indexOf("--" + flag) !== -1 && !args[flag]) {
      throw new Error("--" + flag + " needs a value");
    }
  });
  if (argv.indexOf("--batch-size") !== -1 && !(args.batchSize > 0)) {
    throw new Error("--batch-size needs a positive number");
  }
  if (argv.indexOf("--max-calls") !== -1 && !(args.maxCalls > 0)) {
    throw new Error("--max-calls needs a positive number");
  }
  return args;
}

function loadEnrichment(rel) {
  const full = path.join(ROOT, rel || ENRICHMENT_PATH);
  let raw;
  try {
    raw = fs.readFileSync(full, "utf8");
  } catch {
    return { doc: {}, raw: null };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      (rel || ENRICHMENT_PATH) +
        " is not valid JSON (" +
        e.message +
        "). It is generated -- delete it and re-run to rebuild it from scratch."
    );
  }
  return { doc: doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {}, raw: raw };
}

async function runCli(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(String(err.message));
    console.error(
      "Usage: node scripts/search-enrich.js [--provider gemini|groq|mock] [--models a,b]\n" +
        "       [--dry-run] [--summary <path>] [--batch-size N] [--max-calls N]"
    );
    return 2;
  }

  let catalog;
  let existing;
  let client;
  try {
    catalog = readJson(CATALOG_PATH);
    existing = loadEnrichment(ENRICHMENT_PATH);
    client = llm.createClient({
      provider: args.provider,
      models: args.models || process.env.SEARCH_ENRICH_MODELS,
      maxCalls: args.maxCalls || Number(process.env.SEARCH_ENRICH_MAX_CALLS) || undefined,
      mockResponder: mockResponder
    });
  } catch (err) {
    console.error("search-enrich could not start: " + (err && err.message ? err.message : err));
    return 2;
  }

  console.error(
    "search-enrich: provider " +
      client.telemetry.provider +
      ", model " +
      client.telemetry.model +
      ", policy " +
      rules.POLICY_VERSION +
      (args.dryRun ? " (dry run -- nothing will be written)" : "")
  );

  let result;
  try {
    result = await enrichAll({
      catalog: catalog,
      enrichment: existing.doc,
      client: client,
      batchSize: args.batchSize || Number(process.env.SEARCH_ENRICH_BATCH_SIZE) || undefined,
      log: function (line) {
        console.error("  " + line);
      }
    });
  } catch (err) {
    console.error("search-enrich failed: " + (err && err.message ? err.message : err));
    return 2;
  }

  const summary = summarize(result, client, args.dryRun);
  const text = serializeDocument(result.document);
  const unchangedFile = existing.raw !== null && existing.raw === text;

  let exitCode = 0;
  if (args.dryRun) {
    summary.wouldWrite = JSON.parse(text);
  } else if (unchangedFile) {
    console.error("  the enrichment file is already correct -- nothing written.");
  } else {
    const verdict = writeAndVerify({ text: text, previous: existing.raw });
    if (!verdict.ok) {
      summary.buildVeto = verdict.error;
      summary.restored = true;
      exitCode = 2;
      console.error(
        "\n!! the build refused this enrichment file, so it has been restored:\n" + verdict.error
      );
      if (verdict.restoreFailed) {
        console.error(
          "\n!! AND the restoring build also failed -- the tree may hold generated files from\n" +
            "   the refused run. Run `node scripts/build-site-data.js` and inspect:\n" +
            verdict.restoreFailed
        );
      }
    }
  }

  const json = JSON.stringify(summary, null, 2) + "\n";
  process.stdout.write(json);
  if (args.summary) fs.writeFileSync(args.summary, json);

  if (summary.fallbackWarning) console.error("\n!! " + summary.fallbackWarning);
  console.error(
    "\nsearch-enrich: " +
      summary.generated +
      " product(s) enriched, " +
      summary.unchanged +
      " left alone, " +
      summary.removed.length +
      " removed, " +
      summary.dropped.length +
      " item(s) dropped, " +
      summary.calls +
      " provider call(s)." +
      (args.dryRun ? "\nDry run: no file was written." : "")
  );
  if (summary.dropped.length) {
    console.error("Dropped items (they are in no file):");
    summary.dropped.slice(0, 30).forEach(function (d) {
      console.error("  [" + d.id + "] " + JSON.stringify(d.item) + " -- " + d.reason);
    });
    if (summary.dropped.length > 30) {
      console.error("  ...and " + (summary.dropped.length - 30) + " more.");
    }
  }
  return exitCode;
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then(function (code) {
    process.exit(code);
  });
}

module.exports = {
  ENRICHMENT_PATH: ENRICHMENT_PATH,
  DEFAULT_BATCH_SIZE: DEFAULT_BATCH_SIZE,
  digestProduct: digestProduct,
  planWork: planWork,
  serializeDocument: serializeDocument,
  writeAtomic: writeAtomic,
  shippedSynonymKeys: shippedSynonymKeys,
  batchSchema: batchSchema,
  buildSystemPrompt: buildSystemPrompt,
  buildUserPayload: buildUserPayload,
  mockResponder: mockResponder,
  screenBatch: screenBatch,
  chunk: chunk,
  enrichAll: enrichAll,
  summarize: summarize,
  writeAndVerify: writeAndVerify,
  loadEnrichment: loadEnrichment,
  parseArgs: parseArgs,
  runCli: runCli
};

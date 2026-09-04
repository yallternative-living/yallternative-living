/**
 * @fileoverview First half of the automatic translation pipeline: find the
 * English the runtime translator can reach that nobody has translated yet,
 * give it stable keys, and hand the next step a machine-readable list.
 *
 * Position in the pipeline (the other half is a separate, provider-specific
 * step -- nothing in this file talks to a translation engine or to a network):
 *
 *   1. node scripts/build-site-data.js      (build the site -- NOT done here)
 *   2. npm run i18n:new -- --write          (this file: discover + key + record)
 *   3. translate step                        (fills es/de/fr/ja/zh from the report)
 *   4. node scripts/i18n-claims.test.js      (claims-drift pins)
 *   5. node scripts/build-site-data.js       (the four-rule gate goes green)
 *   6. commit
 *
 * Between 2 and 3 the build gate is RED on purpose: validateDictionaryCoverage
 * rule 2 fails because the other five locales do not carry the new keys yet.
 * That is the intended state, and its message names the new keys.
 *
 * Three sets, all computed against assets/data/locales/en.json:
 *
 *   NEW       reachable in the rendered site, and its exact text is not an
 *             English value in the dictionary. Reachability comes from
 *             scripts/extract-i18n-strings.js, driven here with --json, because
 *             the translator's lookup is exact equality on a node's trimmed
 *             text and only a real browser knows what that text ends up being.
 *   CHANGED   a dictionary key whose English no longer matches the digest
 *             recorded in assets/data/i18n-translation-basis.json -- i.e. copy
 *             that was edited after it was translated, so its five
 *             translations are now stale. Same digest function the build gate
 *             uses (build-site-data.js digestEnglish), imported, not re-rolled.
 *   ORPHANED  a dictionary key whose English is reachable nowhere any more.
 *             Reported only. Nothing here ever deletes a key: a translation
 *             that took a human hour must never disappear because a tool ran.
 *
 * Why the other five locales are never written here: this step knows what
 * needs translating, not what the translation IS. Writing a placeholder into
 * es.json would satisfy rule 2 while shipping English-shaped Spanish, and rule
 * 3 (every locale value must differ from English) is the only thing standing
 * between the shop and exactly that. Leaving them empty keeps the build red
 * until a real translation lands, which is the point.
 *
 * KEYS. The extractor assigns none -- it reports text, kind, count and pages,
 * and every key in en.json was written by hand (`nav.openMenu`, `pdp.addToCart`).
 * There is no scheme here to copy, so this file uses a content-derived one:
 *
 *     auto.<first four words, camelCased>.<first 6 hex of the sha1 digest>
 *
 * Content-derived, not page- or position-derived, on purpose: the same string
 * gets the same key on every run, from any machine, no matter which page it
 * turns up on or what order the pages were crawled in, so two runs a month
 * apart agree and a human re-running the extractor sees no churn. Keys are for
 * humans and for the basis file anyway -- assets/js/translator.js looks
 * phrases up by TEXT, never by key -- so stability matters and beauty does
 * not. The `auto.` prefix marks a key a bot minted; a human is free to rename
 * one afterwards (rename it in all six locales and in the basis together).
 *
 * WHAT IS NOT NEW. A reachable string is only a translation candidate if
 * translating it is the right thing to do. Every exclusion below is derived
 * from committed data rather than a hand-kept ignore list, and every excluded
 * string is reported under `skipped` with its reason, so nothing disappears
 * quietly:
 *
 *   in-dictionary          already an English value in en.json
 *   tpl-template           a filled-in tpl.* template ("Enlarge photo of X")
 *   runtime-manifest       already declared in i18n-runtime-strings.json
 *   catalog-atom           a product/bundle/variant/scent/ingredient token out
 *                          of products.json -- product names and INCI
 *                          ingredients are never translated, and a locale
 *                          value identical to English fails gate rule 3
 *   catalog-composite      nothing but those atoms, numbers and connectives
 *                          ("Lavender for Hush Y'all ... Sleep Salve")
 *   review-verbatim        customer review text or author from
 *                          site-reviews.json -- Etsy verbatim, never rewritten
 *   brand-glossary         nothing but protected terms from brand-glossary.json
 *   email-or-url           addresses and links
 *   machine-code           gift-card/session-shaped identifiers
 *   no-translatable-words  prices, sizes, star runs, arrows, bare numbers
 *
 * WHAT IS NEW BUT DEFERRED (`defer` on the entry; --write skips these):
 *
 *   runtime-only     reachable only after JavaScript runs and not declared in
 *                    i18n-runtime-strings.json. Adding it to en.json would
 *                    fail gate rule 1 forever, and no amount of translating
 *                    would fix it -- a human has to add a manifest entry with
 *                    a `source` and `verify` fragments first.
 *   volatile-numeric a string carrying a loose number the build derives from
 *                    data ("Showing 20 of 20 goods", "Batch: Late October
 *                    2026", "2 reviews of this one"). Freezing today's number
 *                    into the dictionary makes a dead key the moment the
 *                    number moves, and a dead key fails gate rule 1 and breaks
 *                    the build. These want a tpl.* template written by hand,
 *                    not a translation. A number glued to a unit ("2 oz",
 *                    "100%") or inside a range ("1-3 business days") is part
 *                    of the copy and does not defer.
 *
 * Run (the site must already be built):
 *   node scripts/build-site-data.js
 *   npm run i18n:new                       # dry run; JSON report on stdout
 *   npm run i18n:new -- --json report.json # also write the report to a file
 *   npm run i18n:new -- --write            # append NEW keys + record the basis
 *   npm run i18n:new -- --base http://127.0.0.1:8080   # render a served copy
 *
 * Progress chatter goes to stderr; stdout is nothing but the JSON report, so
 * `node scripts/i18n-new-strings.js > report.json` is a valid way to run it.
 * Exit 0 whether or not there is work to do; exit 2 only on a real error.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

/* build-site-data.js is required, not copied: digestEnglish is the function
   the build gate compares against, and a second implementation of it that
   drifted by one character would make this tool and the gate disagree about
   which copy is stale. Requiring it is safe -- the module only builds when it
   is the main module. */
const build = require("./build-site-data.js");

const ROOT = path.resolve(__dirname, "..");
const EXTRACTOR = path.join(__dirname, "extract-i18n-strings.js");
const EN_PATH = "assets/data/locales/en.json";
const BASIS_PATH = "assets/data/i18n-translation-basis.json";
const MANIFEST_PATH = "assets/data/i18n-runtime-strings.json";

/* ---------------------------------------------------------------
   Pure logic. Everything below this line down to runCli() is browserless and
   side-effect free so scripts/i18n-new-strings.test.js can exercise it in the
   Node-only unit pool; the browser half is proved by the run recorded in
   TEST_INFRA.md instead.
   --------------------------------------------------------------- */

function readJsonIfPresent(rel) {
  const p = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** camelCase slug from the first four alphabetic words of a string. */
function slugFromText(text) {
  const words = (String(text).match(/[A-Za-z][A-Za-z']*/g) || [])
    .filter(function (w) {
      return w.replace(/'/g, "").length >= 2;
    })
    .slice(0, 4);
  if (!words.length) return "phrase";
  return words
    .map(function (w, i) {
      const lower = w.replace(/'/g, "").toLowerCase();
      return i === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("")
    .slice(0, 44);
}

/**
 * Stable key for one English string. `digestFn` is build-site-data's
 * digestEnglish; it is a parameter only so the unit test can prove the key
 * depends on nothing but the text.
 */
function keyForText(text, digestFn) {
  return "auto." + slugFromText(text) + "." + digestFn(text).slice(0, 6);
}

/**
 * Keys for a batch, refusing to reuse one that is already taken. A slug plus
 * six hex characters colliding on two different strings is a 1-in-16-million
 * event, but a collision that silently overwrote a translated key would be
 * unrecoverable, so it widens the digest instead and, failing that, counts.
 */
function assignKeys(texts, existingKeys, digestFn) {
  const taken = new Set(existingKeys);
  return texts.map(function (text) {
    let key = keyForText(text, digestFn);
    if (taken.has(key)) key = "auto." + slugFromText(text) + "." + digestFn(text);
    let n = 2;
    while (taken.has(key)) {
      key = "auto." + slugFromText(text) + "." + digestFn(text) + "-" + n;
      n++;
    }
    taken.add(key);
    return { key: key, text: text };
  });
}

/**
 * True when a tpl.* template has enough literal text of its own to be worth
 * matching against. See buildTemplateMatchers for why that matters.
 */
function templateIsSpecificEnough(template) {
  const literal = template.replace(/\{\w+\}/g, "");
  if (literal.replace(/\s+/g, " ").trim().length >= 8) return true;
  /* Anchored at both ends by literal text, so it cannot swallow a sentence
     that merely contains the connective. */
  return !/^\{\w+\}/.test(template) && !/\{\w+\}$/.test(template);
}

/**
 * Regexes for the tpl.* phrases. Same construction as the one in
 * scripts/extract-i18n-strings.js (which is a hand-run script with no exports
 * to import): escape the literal parts, turn each {placeholder} into a capture
 * group. Without it every finished template string -- one per product, per
 * gift-card amount -- looks like untranslated copy forever.
 */
function buildTemplateMatchers(enPhrases) {
  const matchers = [];
  Object.keys(enPhrases || {}).forEach(function (key) {
    if (key.indexOf("tpl.") !== 0) return;
    const template = enPhrases[key];
    if (typeof template !== "string" || template.indexOf("{") === -1) return;
    /* A template that is placeholders either side of a two-letter connective
       matches almost anything: tpl.variantFor ("{variant} for {product}")
       accepts "Aromatherapy mist for the threshold." and tpl.bundleVariantLabel
       ("{product} - {variant}") accepts any sentence with an em dash. Treating
       those as coverage hides real untranslated copy, which is the one failure
       mode this tool must not have, so they are not used as matchers. The
       strings they legitimately describe are labels built out of catalog atoms
       and get skipped by isCatalogComposite instead. */
    if (!templateIsSpecificEnough(template)) return;
    const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = escaped.replace(/\\\{(\w+)\\\}/g, "(.+?)");
    try {
      matchers.push({ key: key, regex: new RegExp("^" + pattern + "$", "u") });
    } catch {
      /* An unbuildable pattern just means this key cannot be recognised here.
         It still fails loud in validateDictionaryCoverage if it is truly dead. */
    }
  });
  return matchers;
}

function matchingTemplateKey(matchers, text) {
  for (let i = 0; i < matchers.length; i++) {
    if (matchers[i].regex.test(text)) return matchers[i].key;
  }
  return null;
}

/** Split "A, B (C, D), E" on top-level commas only, so an INCI list inside
    parentheses stays one token. */
function splitTopLevel(value) {
  const out = [];
  let depth = 0;
  let current = "";
  String(value)
    .split("")
    .forEach(function (ch) {
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
      if ((ch === "," || ch === ";") && depth === 0) {
        out.push(current);
        current = "";
        return;
      }
      current += ch;
    });
  out.push(current);
  return out
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);
}

/**
 * Every catalog string the shop renders as a label rather than as copy:
 * product and bundle names, variant options, scents and scent notes,
 * ingredient and material tokens. These are never translated -- the names are
 * brand, the ingredients are INCI -- and a locale value identical to English
 * fails gate rule 3, so they must not become dictionary keys.
 *
 * Deliberately NOT included: category labels (already translated by hand as
 * shop.*), blurbs, descriptions, ingredient notes and usage guides. Those are
 * copy, and copy is exactly what this tool is looking for.
 */
function collectCatalogAtoms(catalog) {
  const atoms = new Set();
  function add(value) {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed) atoms.add(trimmed);
  }
  function addList(value) {
    if (typeof value !== "string") return;
    add(value);
    splitTopLevel(value).forEach(add);
  }
  function addVariants(variants) {
    if (!variants) return;
    add(variants.name);
    (variants.options || []).forEach(function (o) {
      add(o && o.label);
    });
  }
  const products = (catalog && catalog.products) || [];
  products.forEach(function (p) {
    add(p.name);
    add(p.scent);
    add(p.ingredientsLabel);
    addVariants(p.variants);
    (p.ingredients || []).forEach(add);
    (p.tags || []).forEach(add);
    (p.keywords || []).forEach(add);
    if (p.scentProfile) {
      Object.keys(p.scentProfile).forEach(function (k) {
        addList(p.scentProfile[k]);
      });
    }
  });
  ((catalog && catalog.bundles) || []).forEach(function (b) {
    add(b.name);
    addVariants(b.variants);
    (b.tags || []).forEach(add);
  });
  return atoms;
}

/** Review bodies, authors and owner replies: Etsy verbatim, never translated. */
function collectReviewTexts(reviewsDoc) {
  const texts = new Set();
  const reviews = (reviewsDoc && reviewsDoc.reviews) || [];
  reviews.forEach(function (r) {
    ["name", "text", "title", "ownerReply"].forEach(function (field) {
      if (typeof r[field] === "string" && r[field].trim()) texts.add(r[field].trim());
    });
  });
  return texts;
}

/** Drop a leading list separator: a variant chip renders as ": Seduction". */
function stripLeadingSeparator(text) {
  return String(text)
    .replace(/^[:\u00b7\u2013\u2014|,-]+\s*/, "")
    .trim();
}

/** Strip the decorative quotes the review cards wrap a body in. */
function unquote(text) {
  return String(text)
    .replace(/^["'“”‘’\s]+/, "")
    .replace(/["'“”‘’\s]+$/, "");
}

function wordCount(text) {
  return (String(text).match(/[A-Za-zÀ-ɏ]{2,}/g) || []).length;
}

/** Anything left to translate once numbers, money, sizes and symbols are gone? */
function hasTranslatableWords(text) {
  const stripped = String(text).replace(
    /[$€£¥]?\d[\d.,–—-]*\s*(oz|ml|mL|l|g|kg|lb|in|cm|mm|%|\+|x)?/gi,
    " "
  );
  return (stripped.match(/[A-Za-zÀ-ɏ]{2,}/g) || []).length > 0;
}

function isEmailOrUrl(text) {
  return /(^|\s)\S+@\S+|https?:\/\/|www\./i.test(String(text));
}

/** Gift-card and payment-session shaped identifiers: YALL-XXXX-XXXX, cs_live_... */
function isMachineCode(text) {
  const t = String(text).trim();
  return /^[A-Z0-9]{2,}(-[A-Z0-9X]{2,}){1,}$/.test(t) || /^[a-z]{2,}_[a-z]{2,}_/.test(t);
}

/* Words that can glue catalog atoms together without making the result copy:
   "Lavender for Hush Y'all Magnesium Arnica Sleep Salve" is a variant button's
   accessible name, not a sentence anybody translates. */
const CONNECTIVES = ["a", "an", "and", "for", "in", "of", "or", "the", "to", "with", "x", "per"];

function residualAfterTerms(text, terms) {
  let rest = String(text);
  terms
    .slice()
    .sort(function (a, b) {
      return b.length - a.length;
    })
    .forEach(function (term) {
      if (term && rest.indexOf(term) !== -1) rest = rest.split(term).join(" ");
    });
  return rest;
}

/**
 * True when the string is nothing but catalog atoms, protected terms, numbers,
 * punctuation and connectives -- a label the shop assembled out of data rather
 * than copy somebody wrote. Product names and INCI ingredients are never
 * translated, so a label made only of them has nothing to translate either.
 */
function isCatalogComposite(text, atoms, protectedTerms) {
  const rest = residualAfterTerms(text, Array.from(atoms).concat(protectedTerms));
  const words = rest.match(/[A-Za-zÀ-ɏ']{1,}/g) || [];
  if (!words.length) return true;
  return words.every(function (w) {
    return CONNECTIVES.indexOf(w.replace(/'/g, "").toLowerCase()) !== -1;
  });
}

/** True when the string is nothing but protected brand terms and punctuation. */

/** True when the string is nothing but protected brand terms and punctuation. */
function isGlossaryOnly(text, protectedTerms) {
  let rest = String(text);
  protectedTerms.forEach(function (term) {
    if (term) rest = rest.split(term).join(" ");
  });
  return !/[A-Za-zÀ-ɏ]{2}/.test(rest);
}

/**
 * Why this reachable string is not a translation candidate, or null if it is.
 * Order matters only for which reason gets reported.
 */
function skipReason(text, ctx) {
  if (ctx.enValues.has(text)) return "in-dictionary";
  if (ctx.manifestTexts.has(text)) return "runtime-manifest";
  if (matchingTemplateKey(ctx.templateMatchers, text)) return "tpl-template";
  if (ctx.catalogAtoms.has(text) || ctx.catalogAtoms.has(stripLeadingSeparator(text)))
    return "catalog-atom";
  if (ctx.reviewTexts.has(unquote(text))) return "review-verbatim";
  if (isEmailOrUrl(text)) return "email-or-url";
  if (isMachineCode(text)) return "machine-code";
  if (!hasTranslatableWords(text)) return "no-translatable-words";
  if (isGlossaryOnly(text, ctx.protectedTerms)) return "brand-glossary";
  if (isCatalogComposite(text, ctx.catalogAtoms, ctx.protectedTerms)) return "catalog-composite";
  return null;
}

/**
 * True when the string carries a number the build derives from data rather
 * than a number that is part of the copy. The dictionary matches on exact
 * text, so "Showing 20 of 20 goods" becomes a dead key the day a 21st product
 * ships -- and a dead key fails gate rule 1 and breaks the build, which no
 * amount of translating can undo. A digit run is treated as stable only when
 * it is glued to a unit ("2 oz", "100%") or is part of a range ("1-3 business
 * days"); everything else -- counts, prices, years, order totals -- defers to
 * a human, who can write it as a tpl.* template instead.
 */
function hasVolatileNumber(text) {
  const t = String(text);
  const re = /\d+(?:[.,]\d+)?/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const after = t.slice(m.index + m[0].length);
    const before = t.slice(0, m.index);
    const gluedToUnit = /^\s?(%|oz|ml|mL|g|kg|lb|in\b|cm|mm|pt|px)/.test(after);
    const inRange = /[\u2013\u2014-]\s?$/.test(before) || /^\s?[\u2013\u2014-]\s?\d/.test(after);
    if (!gluedToUnit && !inRange) return true;
  }
  return false;
}

/**
 * Why a genuinely new string must not be written into en.json yet, or null.
 * Both cases would put a key in the dictionary that gate rule 1 can never be
 * satisfied by, so --write leaves them for a human and the report says so.
 */
function deferReason(text, info) {
  if (!info.inBuiltHtml && !info.inManifest) return "runtime-only";
  if (hasVolatileNumber(text)) return "volatile-numeric";
  return null;
}

/**
 * Split the extractor's reachable strings into candidates and skips.
 * `strings` is the `strings` array of `extract-i18n-strings.js --json`.
 */
function classifyReachable(strings, ctx) {
  const candidates = [];
  const skipped = [];
  strings.forEach(function (entry) {
    const text = entry.text;
    const reason = skipReason(text, ctx);
    if (reason) {
      skipped.push({ text: text, reason: reason });
      return;
    }
    candidates.push({
      text: text,
      kind: entry.kind || "text",
      pages: (entry.pages || []).slice().sort(),
      surfaces: (entry.surfaces || []).slice().sort()
    });
  });
  candidates.sort(function (a, b) {
    return a.text.localeCompare(b.text);
  });
  skipped.sort(function (a, b) {
    return a.reason === b.reason ? a.text.localeCompare(b.text) : a.reason.localeCompare(b.reason);
  });
  return { candidates: candidates, skipped: skipped };
}

/** Keys whose English drifted away from the digest recorded in the basis. */
function computeChanged(enPhrases, basisMap, digestFn) {
  const changed = [];
  Object.keys(enPhrases).forEach(function (key) {
    const recorded = basisMap ? basisMap[key] : undefined;
    const actual = digestFn(enPhrases[key]);
    if (recorded === undefined) {
      changed.push({ key: key, en: enPhrases[key], previousDigest: null });
    } else if (recorded !== actual) {
      changed.push({ key: key, en: enPhrases[key], previousDigest: recorded });
    }
  });
  return changed;
}

/**
 * Keys whose English is reachable nowhere. Three ways to be reachable, and a
 * key needs only one: the browser found it, the runtime manifest declares it,
 * or it is present verbatim in a built page. That last one is what the build
 * gate itself checks, and it is why the four legal pages and the review cards
 * -- whose bodies the extractor deliberately never walks -- are not reported
 * here as dead. A key already reported as CHANGED is not also orphaned: its
 * English moved, it did not disappear.
 */
function computeOrphaned(enPhrases, ctx, changedKeys) {
  const orphaned = [];
  Object.keys(enPhrases).forEach(function (key) {
    if (changedKeys.has(key)) return;
    const value = enPhrases[key];
    if (ctx.reachableTexts.has(value)) return;
    if (ctx.manifestTexts.has(value)) return;
    if (ctx.inBuiltHtml(value)) return;
    orphaned.push(key);
  });
  return orphaned;
}

/** en.json with the new keys appended after every existing key, in order. */
function appendPhrases(enDoc, entries) {
  const next = { meta: enDoc.meta, phrases: {} };
  Object.keys(enDoc.phrases).forEach(function (k) {
    next.phrases[k] = enDoc.phrases[k];
  });
  entries.forEach(function (e) {
    next.phrases[e.key] = e.text;
  });
  return next;
}

/**
 * The basis with the new digests appended. Existing entries keep their
 * committed order and their recorded digests: `--record-basis` in the
 * extractor rewrites the whole file sorted, and re-sorting here would turn a
 * two-line addition into a 515-line diff.
 */
function appendBasis(basisDoc, entries, digestFn) {
  const next = { note: basisDoc.note, basis: {} };
  Object.keys(basisDoc.basis).forEach(function (k) {
    next.basis[k] = basisDoc.basis[k];
  });
  entries.forEach(function (e) {
    next.basis[e.key] = digestFn(e.text);
  });
  return next;
}

function countBy(items, field) {
  const out = {};
  items.forEach(function (item) {
    const k = item[field] || "none";
    out[k] = (out[k] || 0) + 1;
  });
  return out;
}

/* ---------------------------------------------------------------
   CLI
   --------------------------------------------------------------- */

function parseArgs(argv) {
  const args = { write: false, json: null, base: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") args.write = true;
    else if (a === "--json") args.json = argv[++i];
    else if (a === "--base") args.base = argv[++i];
    else throw new Error("Unknown argument: " + a);
  }
  if (args.json === undefined || (argv.indexOf("--json") !== -1 && !args.json)) {
    throw new Error("--json needs a path");
  }
  if (argv.indexOf("--base") !== -1 && !args.base) throw new Error("--base needs a URL");
  return args;
}

/**
 * Runs the extractor as a child process and returns its --json payload.
 * Shelling out rather than importing: extract-i18n-strings.js is a top-level
 * async IIFE that launches a browser on load and exports nothing, so there is
 * no function in it to call. Its stdout is routed to our stderr so that our
 * own stdout stays parseable JSON.
 */
function runExtractor(baseUrl) {
  const out = path.join(os.tmpdir(), "yl-i18n-reachable-" + process.pid + ".json");
  const env = Object.assign({}, process.env);
  if (baseUrl) env.YL_I18N_BASE_URL = baseUrl;
  const res = spawnSync(process.execPath, [EXTRACTOR, "--json", out], {
    cwd: ROOT,
    stdio: ["ignore", 2, "inherit"],
    env: env
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error("scripts/extract-i18n-strings.js exited " + res.status);
  }
  if (!fs.existsSync(out)) {
    throw new Error("scripts/extract-i18n-strings.js wrote no JSON report");
  }
  const payload = JSON.parse(fs.readFileSync(out, "utf8"));
  fs.unlinkSync(out);
  if (!payload.strings || !payload.strings.length) {
    throw new Error("The extractor found no reachable strings at all -- is the site built?");
  }
  return payload;
}

function buildContext(payload) {
  const enDoc = readJsonIfPresent(EN_PATH);
  if (!enDoc || !enDoc.phrases) throw new Error(EN_PATH + " is missing or has no phrases.");
  const basisDoc = readJsonIfPresent(BASIS_PATH);
  if (!basisDoc || !basisDoc.basis) throw new Error(BASIS_PATH + " is missing or has no basis.");
  const manifest = readJsonIfPresent(MANIFEST_PATH) || { strings: [] };
  const catalog = readJsonIfPresent("assets/data/products.json") || {};
  const glossary = readJsonIfPresent("assets/data/brand-glossary.json") || { protectedTerms: [] };
  const reviews = readJsonIfPresent("assets/data/site-reviews.json") || { reviews: [] };

  const pages = build.collectBuiltHtml();
  if (!pages.length) {
    throw new Error("No built HTML pages found -- run `node scripts/build-site-data.js` first.");
  }
  const htmlCache = new Map();
  function inBuiltHtml(value) {
    if (!htmlCache.has(value)) {
      htmlCache.set(
        value,
        pages.some(function (page) {
          return page.text.indexOf(value) !== -1;
        })
      );
    }
    return htmlCache.get(value);
  }

  return {
    enDoc: enDoc,
    basisDoc: basisDoc,
    enValues: new Set(Object.values(enDoc.phrases)),
    manifestTexts: new Set(
      (manifest.strings || []).map(function (s) {
        return s.text;
      })
    ),
    templateMatchers: buildTemplateMatchers(enDoc.phrases),
    catalogAtoms: collectCatalogAtoms(catalog),
    reviewTexts: collectReviewTexts(reviews),
    protectedTerms: glossary.protectedTerms || [],
    reachableTexts: new Set(
      payload.strings.map(function (s) {
        return s.text;
      })
    ),
    inBuiltHtml: inBuiltHtml,
    pageCount: pages.length
  };
}

function buildReport(payload, ctx, digestFn) {
  const split = classifyReachable(payload.strings, ctx);
  const assigned = assignKeys(
    split.candidates.map(function (c) {
      return c.text;
    }),
    Object.keys(ctx.enDoc.phrases),
    digestFn
  );
  const byText = new Map();
  assigned.forEach(function (a) {
    byText.set(a.text, a.key);
  });

  const newEntries = split.candidates.map(function (c) {
    const defer = deferReason(c.text, {
      inBuiltHtml: ctx.inBuiltHtml(c.text),
      inManifest: ctx.manifestTexts.has(c.text)
    });
    return {
      key: byText.get(c.text),
      en: c.text,
      kind: c.kind,
      pages: c.pages,
      surfaces: c.surfaces,
      defer: defer
    };
  });

  const changed = computeChanged(ctx.enDoc.phrases, ctx.basisDoc.basis, digestFn);
  const changedKeys = new Set(
    changed.map(function (c) {
      return c.key;
    })
  );
  const orphaned = computeOrphaned(ctx.enDoc.phrases, ctx, changedKeys);
  const writable = newEntries.filter(function (e) {
    return !e.defer;
  });

  return {
    new: newEntries,
    changed: changed,
    orphaned: orphaned,
    skipped: split.skipped,
    counts: {
      reachable: payload.strings.length,
      dictionaryKeys: Object.keys(ctx.enDoc.phrases).length,
      new: newEntries.length,
      newWritable: writable.length,
      newDeferred: newEntries.length - writable.length,
      deferredByReason: countBy(
        newEntries.filter(function (e) {
          return e.defer;
        }),
        "defer"
      ),
      changed: changed.length,
      orphaned: orphaned.length,
      skipped: split.skipped.length,
      skippedByReason: countBy(split.skipped, "reason")
    }
  };
}

function writeJson(rel, doc) {
  const p = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
}

function applyWrite(report, ctx, digestFn) {
  const entries = report.new
    .filter(function (e) {
      return !e.defer;
    })
    .map(function (e) {
      return { key: e.key, text: e.en };
    });
  if (!entries.length) return 0;
  writeJson(EN_PATH, appendPhrases(ctx.enDoc, entries));
  writeJson(BASIS_PATH, appendBasis(ctx.basisDoc, entries, digestFn));
  return entries.length;
}

function runCli(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(String(err.message));
    console.error(
      "Usage: node scripts/i18n-new-strings.js [--write] [--json <path>] [--base <url>]"
    );
    return 2;
  }

  let report;
  let ctx;
  try {
    const payload = runExtractor(args.base);
    ctx = buildContext(payload);
    report = buildReport(payload, ctx, build.digestEnglish);
  } catch (err) {
    console.error("i18n-new-strings failed: " + (err && err.message ? err.message : err));
    return 2;
  }

  const json = JSON.stringify(report, null, 2) + "\n";
  process.stdout.write(json);
  if (args.json) {
    fs.writeFileSync(path.isAbsolute(args.json) ? args.json : path.join(ROOT, args.json), json);
    console.error("Wrote report to " + args.json);
  }

  console.error(
    "\ni18n-new-strings: " +
      report.counts.new +
      " new (" +
      report.counts.newWritable +
      " writable, " +
      report.counts.newDeferred +
      " deferred), " +
      report.counts.changed +
      " changed, " +
      report.counts.orphaned +
      " orphaned, " +
      report.counts.skipped +
      " skipped as not-for-translation."
  );

  if (args.write) {
    let written = 0;
    try {
      written = applyWrite(report, ctx, build.digestEnglish);
    } catch (err) {
      console.error("i18n-new-strings could not write: " + err.message);
      return 2;
    }
    if (written) {
      console.error(
        "Appended " +
          written +
          " key(s) to " +
          EN_PATH +
          " and recorded their basis in " +
          BASIS_PATH +
          ".\nThe other five locales were NOT touched, so `node scripts/build-site-data.js`\n" +
          "will now fail rule 2 naming those keys until the translation step fills them in."
      );
    } else {
      console.error("Nothing writable -- no files changed.");
    }
  } else {
    console.error("Dry run: nothing was written. Re-run with --write to append the new keys.");
  }
  return 0;
}

if (require.main === module) {
  process.exit(runCli(process.argv.slice(2)));
}

module.exports = {
  slugFromText,
  templateIsSpecificEnough,
  isCatalogComposite,
  hasVolatileNumber,
  stripLeadingSeparator,
  buildContext,
  keyForText,
  assignKeys,
  buildTemplateMatchers,
  matchingTemplateKey,
  splitTopLevel,
  collectCatalogAtoms,
  collectReviewTexts,
  unquote,
  wordCount,
  hasTranslatableWords,
  isEmailOrUrl,
  isMachineCode,
  isGlossaryOnly,
  skipReason,
  deferReason,
  classifyReachable,
  computeChanged,
  computeOrphaned,
  appendPhrases,
  appendBasis,
  parseArgs,
  buildReport,
  runCli
};

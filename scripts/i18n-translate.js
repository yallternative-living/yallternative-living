/**
 * @fileoverview Step 3 of the translation pipeline: fill es/de/fr/ja/zh for
 * every English string that needs it, refuse anything that fails a
 * deterministic check, and write the six dictionaries plus the basis.
 *
 *   1. node scripts/build-site-data.js      build the site
 *   2. npm run i18n:new -- --json r.json    discover, key (writes nothing)
 *   3. npm run i18n:translate -- --report r.json     <- this file
 *   4. node scripts/build-site-data.js      the four-rule gate goes green
 *   5. npm test
 *   6. commit
 *
 * Note where the en.json write happens: HERE, not in step 2. `i18n:new
 * --write` exists and still works, but it appends English keys the five
 * locales cannot yet satisfy, which leaves the build red between the two
 * steps. Running discovery in report mode and letting this file write all
 * seven files at once means a key reaches en.json only when its five
 * translations are in hand -- the atomicity rule below, applied to English as
 * well. A string whose German fails is not "translated into four languages";
 * it is not translated, and the site keeps showing the English, which the
 * runtime translator does by falling back on any text it cannot match.
 *
 * WHAT COUNTS AS WORK
 *
 *   NEW       a writable entry in the i18n-new-strings report: reachable
 *             English that is not in the dictionary. All five locales.
 *   MISSING   a key already in en.json whose value in some locale is absent or
 *             empty. Only the locales that are actually missing, so a
 *             hand-tuned translation somebody wrote is never overwritten.
 *   CHANGED   a key whose English drifted from its digest in
 *             i18n-translation-basis.json. All five are re-translated and the
 *             basis re-recorded, because the digest is the claim "these five
 *             were authored against THIS English" and once the English moves
 *             the claim is void. A hand-tuned translation of superseded
 *             English is worse than a fresh machine one -- but say so in the
 *             commit message, because it is somebody's work.
 *   ORPHANED  reachable nowhere any more. `auto.*` keys -- the ones a bot
 *             minted -- are removed from all six locales and the basis.
 *             Hand-authored keys are REPORTED AND NEVER DELETED: a translation
 *             that cost a human an hour does not disappear because a tool ran.
 *
 * ATOMICITY, which is the rule everything else serves. A key is written to all
 * seven files or to none of them. Not "English plus the four that worked":
 * that state passes gate rule 2 only by accident and would ship an English
 * string wearing a Spanish label. Failed keys are listed in the summary with
 * the locale and the rule that fired, and the workflow files them on one
 * tracking issue.
 *
 * THE CHECKS ARE DETERMINISTIC ON PURPOSE. There is no second model reviewing
 * the first. The failure modes that matter here are lexical and enumerable --
 * an invented health claim, a mangled {placeholder}, a brand name that grew a
 * translation, a passthrough that is still English -- and a grep that fails
 * loudly beats a reviewer that passes 99% of the time and teaches the
 * maintainer to trust it. Every check below runs per string, costs nothing,
 * and names the rule it enforced.
 *
 * PROVIDERS AND KEYS. scripts/lib/llm.js holds the whole network layer -- it
 * is the repo's shared LLM client, not this bot's private one: one
 * OpenAI-shaped `/chat/completions` call with JSON-schema structured output,
 * so Gemini and Groq differ by a base URL and a model id, and the retries, the
 * pinned-to-alias model fallback and the per-run call cap live there.
 * `--provider mock` needs no key at all and returns obviously-fake
 * "[es] ..." strings; it is how the pipeline is proved offline and how the CI
 * dry run works.
 *
 * Run:
 *   npm run i18n:translate -- --report report.json           # needs a key
 *   npm run i18n:translate -- --report report.json --dry-run
 *   npm run i18n:translate -- --report report.json --provider mock
 *   npm run i18n:translate                                   # runs i18n:new itself
 *
 * Progress goes to stderr; stdout is nothing but the JSON summary.
 * Exit 0 when the run did what it could (failed strings are data, not a crash);
 * exit 2 on a real error -- no provider key, an unreadable report, a bad flag.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const build = require("./build-site-data.js");
const discovery = require("./i18n-new-strings.js");
const claimRules = require("./lib/i18n-claims-rules.js");
const llm = require("./lib/llm.js");

const ROOT = path.resolve(__dirname, "..");
const DISCOVERY_SCRIPT = path.join(__dirname, "i18n-new-strings.js");
const EN_PATH = "assets/data/locales/en.json";
const BASIS_PATH = "assets/data/i18n-translation-basis.json";
const GLOSSARY_PATH = "assets/data/brand-glossary.json";
const LOCALE_DIR = "assets/data/locales";

/** The five targets, in the order build-site-data.js lists them. */
const TARGET_LOCALES = ["es", "de", "fr", "ja", "zh"];

/* 198 backlog keys x 5 locales / 20 per call = 50 calls, which is what the
   shared client's default cap (llm.DEFAULT_MAX_CALLS) leaves room for, retries
   included. A run that hits the cap stops cleanly at a batch boundary and
   leaves the rest for the next run, because every key it did finish is already
   atomic. The cap is enforced inside scripts/lib/llm.js; this file only
   decides where the boundary falls. */
const DEFAULT_BATCH_SIZE = 20;

/* Characters that exist only in Traditional Chinese. zh.json is Simplified,
   and the one hard measurement available found a model ranked first on
   automated metrics returning 76% of segments in the wrong script -- with
   COMET and MetricX scoring them identically, because neither has any
   mechanism to notice. A 116-character set costs nothing and catches it.
   scripts/i18n-translate.test.js asserts none of these appears in the
   shipped zh.json, so the list cannot quietly start rejecting good copy. */
const TRADITIONAL_ONLY =
  "東專產齊樂護靈膚髮體適舊們個為與從來時這樣會後點沒說對開關發實動經過還記憶種類價錢買賣單雙數幾鐘頭質廣國語謝請問選願愛書畫氣讓給" +
  "購車網訊話讀寫圖團區醫藥節費準條該場顯標檢驗證認識應務銷訂貨運稅練習題論議報導傳統計劃屬歡變態總結構層級";

/* ---------------------------------------------------------------
   Pure logic. Everything down to runCli() is offline and side-effect free so
   scripts/i18n-translate.test.js can drive every branch in the Node-only pool.
   --------------------------------------------------------------- */

function readJson(rel) {
  const p = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(rel, doc) {
  const p = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
}

/** Every {placeholder} in a string, in order. */
function placeholdersIn(text) {
  return String(text).match(/\{[A-Za-z0-9_]+\}/g) || [];
}

function sameMultiset(a, b) {
  if (a.length !== b.length) return false;
  const left = a.slice().sort();
  const right = b.slice().sort();
  return left.every(function (v, i) {
    return v === right[i];
  });
}

function hasTraditionalChinese(text) {
  const value = String(text);
  for (let i = 0; i < value.length; i++) {
    if (TRADITIONAL_ONLY.indexOf(value[i]) !== -1) return value[i];
  }
  return null;
}

/**
 * Every deterministic check one translated string has to pass, in the order
 * that gives the most useful failure message. Returns null on a pass, or the
 * reason string that goes into the summary and the tracking issue.
 */
function checkTranslation(input) {
  const en = String(input.en);
  const value = String(
    input.translated === undefined || input.translated === null ? "" : input.translated
  );
  const locale = input.locale;
  const protectedTerms = input.protectedTerms || [];

  if (!value.trim()) return "empty translation";

  /* Literal parity first: a mangled {product} breaks the runtime silently, and
     29 tpl.* keys depend on it. */
  const wanted = placeholdersIn(en);
  const got = placeholdersIn(value);
  if (!sameMultiset(wanted, got)) {
    return (
      "placeholder mismatch: English has " +
      (wanted.length ? wanted.join(" ") : "none") +
      ", translation has " +
      (got.length ? got.join(" ") : "none")
    );
  }

  /* Protected terms: reproduced character-for-character where the English uses
     them. build-site-data.js's validateLocalesAndGlossary throws on this at
     build time, so a miss here would be a failed deploy rather than a bad
     string -- catch it before it is ever written. */
  const droppedTerms = protectedTerms.filter(function (term) {
    return term && en.indexOf(term) !== -1 && value.indexOf(term) === -1;
  });
  if (droppedTerms.length) {
    return "protected term(s) not preserved verbatim: " + droppedTerms.join(", ");
  }

  /* Identical to English is a passthrough, and gate rule 3 rejects it. The
     exception is a string with nothing translatable in it, which should not
     have reached here at all -- discovery skips those -- but if one does, the
     honest translation is the English. */
  if (value.trim() === en.trim() && discovery.hasTranslatableWords(en)) {
    return "translation is identical to the English (passthrough)";
  }

  /* Length ratio. Sources under 10 characters legitimately expand 200-300% in
     German (IBM's figures, via W3C), so the ceiling is generous; the floor is
     what catches a truncated rewrite that dropped half the sentence. */
  if (en.length > 0) {
    const ratio = value.length / en.length;
    if (ratio < 0.3 || ratio > 3.5) {
      return (
        "length ratio " +
        ratio.toFixed(2) +
        "x is outside 0.3x-3.5x (" +
        en.length +
        " chars of English, " +
        value.length +
        " of " +
        locale +
        ")"
      );
    }
  }

  if (locale === "zh") {
    const traditional = hasTraditionalChinese(value);
    if (traditional) {
      return (
        "Traditional Chinese character " + JSON.stringify(traditional) + " in a Simplified locale"
      );
    }
  }

  const offenses = claimRules.claimOffenses({
    key: input.key,
    code: locale,
    english: en,
    translated: value,
    protectedTerms: protectedTerms
  });
  if (offenses.length) {
    return (
      "claim vocabulary the English does not license: " +
      offenses
        .map(function (o) {
          return JSON.stringify(o.word);
        })
        .join(", ")
    );
  }

  return null;
}

/**
 * The work list, in the order it will be written.
 *
 * Existing keys first, in en.json's own key order, then new keys in report
 * order -- so the diff is an append at the end of each file, which is what
 * makes a bot commit reviewable by a human.
 */
function buildWorkItems(input) {
  const report = input.report || { new: [], changed: [], orphaned: [] };
  const enPhrases = input.enPhrases;
  const localePhrases = input.localePhrases;
  const digestFn = input.digestFn;
  const basis = input.basis || {};

  const items = [];
  const seen = new Set();

  const changedKeys = new Set(
    (report.changed || []).map(function (c) {
      return c.key;
    })
  );

  Object.keys(enPhrases).forEach(function (key) {
    const en = enPhrases[key];
    if (changedKeys.has(key)) {
      items.push({
        key: key,
        en: en,
        reason: "changed",
        isNew: false,
        locales: TARGET_LOCALES.slice()
      });
      seen.add(key);
      return;
    }
    const missing = TARGET_LOCALES.filter(function (code) {
      const value = localePhrases[code] ? localePhrases[code][key] : undefined;
      return typeof value !== "string" || !value.trim();
    });
    if (missing.length) {
      items.push({ key: key, en: en, reason: "missing", isNew: false, locales: missing });
      seen.add(key);
    }
  });

  /* A key that changed but whose basis is also absent is still "changed" --
     computeChanged in discovery reports both as the same set, and the digest
     is rewritten either way. Kept explicit so the reason in the summary is
     truthful. */
  (report.changed || []).forEach(function (entry) {
    if (!Object.prototype.hasOwnProperty.call(enPhrases, entry.key)) return;
    if (seen.has(entry.key)) return;
    items.push({
      key: entry.key,
      en: enPhrases[entry.key],
      reason: "changed",
      isNew: false,
      locales: TARGET_LOCALES.slice()
    });
    seen.add(entry.key);
  });

  (report.new || []).forEach(function (entry) {
    if (entry.defer) return;
    if (seen.has(entry.key)) return;
    if (Object.prototype.hasOwnProperty.call(enPhrases, entry.key)) return;
    items.push({
      key: entry.key,
      en: entry.en,
      kind: entry.kind || "text",
      reason: "new",
      isNew: true,
      locales: TARGET_LOCALES.slice()
    });
    seen.add(entry.key);
  });

  /* Only auto.* orphans are removable. A hand-authored key that has gone
     unreachable is a human decision -- maybe the copy is coming back. */
  const orphanRemovals = [];
  const orphanReported = [];
  (report.orphaned || []).forEach(function (key) {
    if (String(key).indexOf("auto.") === 0) orphanRemovals.push(key);
    else orphanReported.push(key);
  });

  /* Keys whose basis digest is simply absent get one recorded on the way past,
     but only if they are otherwise complete -- a key being translated already
     records its own. */
  const basisGaps = Object.keys(enPhrases).filter(function (key) {
    return basis[key] === undefined && !seen.has(key) && digestFn;
  });

  return {
    items: items,
    orphanRemovals: orphanRemovals,
    orphanReported: orphanReported,
    basisGaps: basisGaps
  };
}

/** Fixed-size groups, preserving order. */
function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The locales one group of items needs, in TARGET_LOCALES order. */
function localesForGroup(group) {
  return TARGET_LOCALES.filter(function (code) {
    return group.some(function (item) {
      return item.locales.indexOf(code) !== -1;
    });
  });
}

const LOCALE_GUIDANCE = {
  es: "Neutral international Spanish. No regional slang, no voseo.",
  de: "Standard German, du-form to match the brand's voice. Button, nav and label strings must stay SHORT -- German compounds do not wrap, and an over-long button breaks the layout.",
  fr: "Neutral French, tutoiement to match the brand's voice. Keep typographic spacing conventions.",
  ja: "Polite e-commerce Japanese (です・ます). Natural shop register, not a literal gloss. Do not add reassurance words the English does not contain.",
  zh: "SIMPLIFIED Chinese (mainland). Never Traditional characters."
};

/**
 * The system prompt for one locale. Built from committed data -- the glossary
 * file and the shared claims table -- rather than typed out, so the
 * instruction the model gets and the gate that judges its answer are generated
 * from the same arrays and cannot drift.
 */
function buildSystemPrompt(locale, ctx) {
  const glossary = ctx.glossary || {};
  const terms = glossary.protectedTerms || [];
  const notes = (glossary.rules && glossary.rules.notes) || {};
  const noteLines = Object.keys(notes).map(function (k) {
    return "  - " + notes[k];
  });
  return [
    "You translate user-interface and product copy for Y'allternative Living, a small-batch",
    "Appalachian apothecary in Landrum, South Carolina, from English into " + locale + ".",
    "The voice is warm, dry and irreverent. Keep the joke when there is one; do not make the copy",
    "corporate.",
    "",
    "LOCALE: " + (LOCALE_GUIDANCE[locale] || ""),
    "",
    "DO NOT TRANSLATE these terms. Reproduce each one character-for-character wherever the English",
    "uses it, and never introduce one the English does not use:",
    terms
      .map(function (t) {
        return "  - " + t;
      })
      .join("\n"),
    "",
    noteLines.length ? "GLOSSARY NOTES:\n" + noteLines.join("\n") + "\n" : "",
    "CLAIMS. This is a cosmetics shop, not a pharmacy. Translate what the English SAYS, not what it",
    "implies. Never add a health, medical, safety or efficacy claim the English does not make, and",
    "never drop one it does. EU Reg. 1223/2009, Japan's 薬機法 and China's 化妆品监督管理条例 Art. 43",
    "all apply, and a safety assurance is a violation in Japan even when it is true. Specifically:",
    claimRules.claimPromptFragment(locale),
    "",
    "PRESERVE VERBATIM: every {placeholder} exactly as written, every number, every currency amount,",
    "every unit (oz, ml), every line break, and every HTML entity. Do not add or remove punctuation",
    "that carries meaning -- if the English puts an aside in parentheses, keep it in parentheses.",
    "",
    "Return exactly one item for every input item, in the same order, with the same id. Translate",
    "the `text` field only. Output nothing but the JSON object the schema describes."
  ]
    .filter(function (line) {
      return line !== "";
    })
    .join("\n");
}

/** The strict JSON schema both providers are asked to conform to. */
function batchSchema() {
  return {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            text: { type: "string" }
          },
          required: ["id", "text"],
          additionalProperties: false
        }
      }
    },
    required: ["items"],
    additionalProperties: false
  };
}

function buildUserPayload(locale, group) {
  return JSON.stringify({
    locale: locale,
    items: group.map(function (item) {
      return { id: item.key, kind: item.kind || "text", text: item.en };
    })
  });
}

/**
 * The model's answer, validated as a shape before anything is looked at as a
 * translation. A schema-conformant hallucination -- right shape, wrong or
 * missing ids -- is the realistic failure mode, not a 500.
 */
function validateBatchResponse(response, group) {
  if (!response || !Array.isArray(response.items))
    return { ok: false, error: "response has no items array" };
  const byId = new Map();
  response.items.forEach(function (item) {
    if (item && typeof item.id === "string" && typeof item.text === "string")
      byId.set(item.id, item.text);
  });
  const missing = group
    .filter(function (item) {
      return !byId.has(item.key);
    })
    .map(function (item) {
      return item.key;
    });
  if (missing.length) {
    return {
      ok: false,
      error: "response omitted " + missing.length + " key(s): " + missing.slice(0, 5).join(", ")
    };
  }
  return { ok: true, byId: byId };
}

/**
 * The six locale documents and the basis, rebuilt from the accepted results.
 *
 * Key order is one order for all six files forever: en.json's existing order,
 * minus removed orphans, plus accepted new keys appended at the end in report
 * order. Nothing is ever re-serialised sorted -- that would turn a two-key
 * addition into a 515-key diff and make every bot commit unreviewable.
 */
function applyResults(input) {
  const enDoc = input.enDoc;
  const localeDocs = input.localeDocs;
  const basisDoc = input.basisDoc;
  const accepted = input.accepted;
  const removed = new Set(input.removedKeys || []);
  const digestFn = input.digestFn;

  const acceptedKeys = Object.keys(accepted);
  const newKeys = acceptedKeys.filter(function (key) {
    return !Object.prototype.hasOwnProperty.call(enDoc.phrases, key);
  });

  const order = Object.keys(enDoc.phrases)
    .filter(function (key) {
      return !removed.has(key);
    })
    .concat(newKeys);

  const nextEn = { meta: enDoc.meta, phrases: {} };
  order.forEach(function (key) {
    nextEn.phrases[key] =
      accepted[key] && accepted[key].en !== undefined ? accepted[key].en : enDoc.phrases[key];
  });

  const nextLocales = {};
  TARGET_LOCALES.forEach(function (code) {
    const doc = localeDocs[code];
    const next = { meta: doc.meta, phrases: {} };
    order.forEach(function (key) {
      const fresh = accepted[key] && accepted[key].translations && accepted[key].translations[code];
      next.phrases[key] = fresh !== undefined ? fresh : doc.phrases[key];
    });
    nextLocales[code] = next;
  });

  /* The basis keeps its own committed order (the extractor's --record-basis
     writes it sorted, en.json is grouped by namespace; they are different
     orderings on purpose). Existing entries keep their position and get a new
     digest only when their key was re-translated. */
  const nextBasis = { note: basisDoc.note, basis: {} };
  Object.keys(basisDoc.basis).forEach(function (key) {
    if (removed.has(key)) return;
    nextBasis.basis[key] =
      accepted[key] && accepted[key].en !== undefined
        ? digestFn(accepted[key].en)
        : basisDoc.basis[key];
  });
  order.forEach(function (key) {
    if (nextBasis.basis[key] !== undefined) return;
    const value = nextEn.phrases[key];
    if (value !== undefined) nextBasis.basis[key] = digestFn(value);
  });

  return { en: nextEn, locales: nextLocales, basis: nextBasis, order: order };
}

/* ---------------------------------------------------------------
   CLI
   --------------------------------------------------------------- */

function parseArgs(argv) {
  const args = {
    report: null,
    provider: null,
    models: null,
    dryRun: false,
    base: null,
    summary: null,
    batchSize: null,
    maxCalls: null
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--report") args.report = argv[++i];
    else if (a === "--provider") args.provider = argv[++i];
    else if (a === "--models") args.models = argv[++i];
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--summary") args.summary = argv[++i];
    else if (a === "--batch-size") args.batchSize = Number(argv[++i]);
    else if (a === "--max-calls") args.maxCalls = Number(argv[++i]);
    else throw new Error("Unknown argument: " + a);
  }
  ["report", "provider", "models", "base", "summary"].forEach(function (flag) {
    if (argv.indexOf("--" + flag) !== -1 && !args[flag])
      throw new Error("--" + flag + " needs a value");
  });
  if (argv.indexOf("--batch-size") !== -1 && !(args.batchSize > 0)) {
    throw new Error("--batch-size needs a positive number");
  }
  if (argv.indexOf("--max-calls") !== -1 && !(args.maxCalls > 0)) {
    throw new Error("--max-calls needs a positive number");
  }
  return args;
}

/**
 * Runs scripts/i18n-new-strings.js when no --report was given. That drives a
 * real Chromium, so the workflow passes --report instead and this path is for
 * a maintainer running the whole thing by hand.
 */
function runDiscovery(baseUrl) {
  const out = path.join(os.tmpdir(), "yl-i18n-report-" + process.pid + ".json");
  const argv = [DISCOVERY_SCRIPT, "--json", out];
  if (baseUrl) argv.push("--base", baseUrl);
  const res = spawnSync(process.execPath, argv, {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"]
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error("scripts/i18n-new-strings.js exited " + res.status);
  const report = JSON.parse(fs.readFileSync(out, "utf8"));
  fs.unlinkSync(out);
  return report;
}

function loadContext() {
  const enDoc = readJson(EN_PATH);
  if (!enDoc || !enDoc.phrases) throw new Error(EN_PATH + " is missing or has no phrases.");
  const basisDoc = readJson(BASIS_PATH);
  if (!basisDoc || !basisDoc.basis) throw new Error(BASIS_PATH + " is missing or has no basis.");
  const glossary = readJson(GLOSSARY_PATH);
  const localeDocs = {};
  TARGET_LOCALES.forEach(function (code) {
    localeDocs[code] = readJson(path.join(LOCALE_DIR, code + ".json"));
    if (!localeDocs[code].phrases) throw new Error(code + ".json has no phrases.");
  });
  return { enDoc: enDoc, basisDoc: basisDoc, glossary: glossary, localeDocs: localeDocs };
}

/**
 * The run itself. Split out of runCli so the unit suite can drive it with an
 * injected client and in-memory documents. `client` is anything with the
 * scripts/lib/llm.js shape: completeJSON(), callsRemaining(), telemetry.
 */
async function translateAll(input) {
  const ctx = input.ctx;
  const client = input.client;
  const batchSize = input.batchSize || DEFAULT_BATCH_SIZE;
  const protectedTerms = (ctx.glossary && ctx.glossary.protectedTerms) || [];
  const log = input.log || function () {};

  const localePhrases = {};
  TARGET_LOCALES.forEach(function (code) {
    localePhrases[code] = ctx.localeDocs[code].phrases;
  });

  const work = buildWorkItems({
    report: input.report,
    enPhrases: ctx.enDoc.phrases,
    localePhrases: localePhrases,
    basis: ctx.basisDoc.basis,
    digestFn: build.digestEnglish
  });

  const groups = chunk(work.items, batchSize);
  /* key -> {en, translations:{code:text}, needed:Set} while it is still in
     flight; promoted into `accepted` only when every needed locale passed. */
  const pending = new Map();
  const failed = [];
  const failedKeys = new Set();
  let deferredKeys = 0;

  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    const codes = localesForGroup(group);
    /* Stop at a GROUP boundary, never inside one. A group whose Spanish landed
       and whose German never got a call would leave keys half-done for no
       benefit -- they would be dropped by the atomicity rule anyway. Asking
       the client how much budget is left, rather than counting here, keeps one
       definition of the cap. */
    if (client.callsRemaining() < codes.length) {
      deferredKeys += groups.slice(g).reduce(function (n, rest) {
        return n + rest.length;
      }, 0);
      log(
        "Call cap reached after " +
          client.telemetry.calls +
          " call(s): leaving " +
          deferredKeys +
          " key(s) for the next run."
      );
      break;
    }

    for (let c = 0; c < codes.length; c++) {
      const code = codes[c];
      const forLocale = group.filter(function (item) {
        return item.locales.indexOf(code) !== -1;
      });
      if (!forLocale.length) continue;
      log(
        "batch " +
          (g + 1) +
          "/" +
          groups.length +
          " [" +
          code +
          "] " +
          forLocale.length +
          " string(s)"
      );

      let response = null;
      let error = null;
      try {
        response = await client.completeJSON({
          system: buildSystemPrompt(code, ctx),
          user: buildUserPayload(code, forLocale),
          schema: batchSchema(),
          schemaName: "translations_" + code,
          protectedTerms: protectedTerms
        });
      } catch (err) {
        error = err && err.message ? err.message : String(err);
      }

      const validated = error
        ? { ok: false, error: error }
        : validateBatchResponse(response, forLocale);
      forLocale.forEach(function (item) {
        if (!validated.ok) {
          failed.push({ key: item.key, en: item.en, locale: code, reason: validated.error });
          failedKeys.add(item.key);
          return;
        }
        const translated = validated.byId.get(item.key);
        const reason = checkTranslation({
          key: item.key,
          en: item.en,
          translated: translated,
          locale: code,
          protectedTerms: protectedTerms
        });
        if (reason) {
          failed.push({ key: item.key, en: item.en, locale: code, reason: reason });
          failedKeys.add(item.key);
          return;
        }
        if (!pending.has(item.key)) {
          pending.set(item.key, {
            en: item.en,
            isNew: item.isNew,
            reason: item.reason,
            needed: item.locales.slice(),
            translations: {}
          });
        }
        pending.get(item.key).translations[code] = translated;
      });
    }
  }

  /* Atomic promotion. A key that failed anywhere is dropped entirely -- not
     written to en.json either, so the dictionary stays complete and the site
     keeps showing that string in English. */
  const accepted = {};
  pending.forEach(function (entry, key) {
    if (failedKeys.has(key)) return;
    const complete = entry.needed.every(function (code) {
      return typeof entry.translations[code] === "string";
    });
    if (!complete) return;
    accepted[key] = {
      en: entry.en,
      translations: entry.translations,
      isNew: entry.isNew,
      reason: entry.reason
    };
  });

  const written = applyResults({
    enDoc: ctx.enDoc,
    localeDocs: ctx.localeDocs,
    basisDoc: ctx.basisDoc,
    accepted: accepted,
    removedKeys: work.orphanRemovals,
    digestFn: build.digestEnglish
  });

  return {
    work: work,
    accepted: accepted,
    failed: failed,
    deferredKeys: deferredKeys,
    docs: written
  };
}

function summarize(result, client, dryRun) {
  const acceptedKeys = Object.keys(result.accepted);
  return {
    translated: acceptedKeys.length,
    keys: acceptedKeys,
    newKeys: acceptedKeys.filter(function (k) {
      return result.accepted[k].isNew;
    }).length,
    retranslatedKeys: acceptedKeys.filter(function (k) {
      return result.accepted[k].reason === "changed";
    }).length,
    failed: result.failed,
    removedOrphans: result.work.orphanRemovals,
    reportedOrphans: result.work.orphanReported,
    deferredToNextRun: result.deferredKeys,
    calls: client.telemetry.calls,
    retries: client.telemetry.retries,
    provider: client.telemetry.provider,
    model: client.telemetry.model,
    modelFallbacks: client.telemetry.modelFallbacks,
    modelWarning: client.fallbackWarning(),
    dryRun: !!dryRun
  };
}

function writeAll(docs) {
  writeJson(EN_PATH, docs.en);
  TARGET_LOCALES.forEach(function (code) {
    writeJson(path.join(LOCALE_DIR, code + ".json"), docs.locales[code]);
  });
  writeJson(BASIS_PATH, docs.basis);
}

async function runCli(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(String(err.message));
    console.error(
      "Usage: node scripts/i18n-translate.js [--report <path>] [--provider gemini|groq|mock]\n" +
        "       [--models a,b] [--dry-run] [--base <url>] [--summary <path>]\n" +
        "       [--batch-size N] [--max-calls N]"
    );
    return 2;
  }

  const batchSize = args.batchSize || Number(process.env.I18N_BATCH_SIZE) || DEFAULT_BATCH_SIZE;
  /* This bot's own environment names win over the shared LLM_* ones, so the
     workflow reads as an i18n workflow; scripts/lib/llm.js falls back to
     LLM_MODELS / LLM_MAX_CALLS for the bots that come later. */
  const maxCalls = args.maxCalls || Number(process.env.I18N_MAX_CALLS) || undefined;

  let ctx;
  let report;
  let client;
  try {
    ctx = loadContext();
    report = args.report
      ? JSON.parse(fs.readFileSync(args.report, "utf8"))
      : runDiscovery(args.base);
    client = llm.createClient({
      provider: args.provider,
      models: args.models || process.env.I18N_MODELS,
      maxCalls: maxCalls
    });
  } catch (err) {
    console.error("i18n-translate could not start: " + (err && err.message ? err.message : err));
    return 2;
  }

  console.error(
    "i18n-translate: provider " +
      client.telemetry.provider +
      ", model " +
      client.telemetry.model +
      ", batches of " +
      batchSize +
      ", call cap " +
      client.config.maxCalls +
      (args.dryRun ? " (dry run -- nothing will be written)" : "")
  );

  let result;
  try {
    result = await translateAll({
      ctx: ctx,
      report: report,
      client: client,
      batchSize: batchSize,
      log: function (line) {
        console.error("  " + line);
      }
    });
  } catch (err) {
    console.error("i18n-translate failed: " + (err && err.message ? err.message : err));
    return 2;
  }

  const summary = summarize(result, client, args.dryRun);
  const json = JSON.stringify(summary, null, 2) + "\n";
  process.stdout.write(json);
  if (args.summary) fs.writeFileSync(args.summary, json);

  if (!args.dryRun) {
    const hasWork =
      summary.translated > 0 ||
      summary.removedOrphans.length > 0 ||
      result.work.basisGaps.length > 0;
    if (hasWork) writeAll(result.docs);
  }

  if (summary.modelWarning) {
    console.error("\n!! " + summary.modelWarning);
  }
  console.error(
    "\ni18n-translate: " +
      summary.translated +
      " key(s) translated (" +
      summary.newKeys +
      " new, " +
      summary.retranslatedKeys +
      " re-translated), " +
      summary.failed.length +
      " string(s) dropped, " +
      summary.removedOrphans.length +
      " orphan(s) removed, " +
      summary.deferredToNextRun +
      " left for the next run, " +
      summary.calls +
      " provider call(s)." +
      (args.dryRun ? "\nDry run: no file was written." : "")
  );
  if (summary.failed.length) {
    console.error("Dropped strings (written nowhere, not even to en.json):");
    summary.failed.slice(0, 20).forEach(function (f) {
      console.error("  " + f.key + " [" + f.locale + "] " + f.reason);
    });
  }
  return 0;
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then(function (code) {
    process.exit(code);
  });
}

module.exports = {
  TARGET_LOCALES: TARGET_LOCALES,
  TRADITIONAL_ONLY: TRADITIONAL_ONLY,
  placeholdersIn: placeholdersIn,
  hasTraditionalChinese: hasTraditionalChinese,
  checkTranslation: checkTranslation,
  buildWorkItems: buildWorkItems,
  chunk: chunk,
  localesForGroup: localesForGroup,
  buildSystemPrompt: buildSystemPrompt,
  buildUserPayload: buildUserPayload,
  batchSchema: batchSchema,
  validateBatchResponse: validateBatchResponse,
  applyResults: applyResults,
  parseArgs: parseArgs,
  loadContext: loadContext,
  translateAll: translateAll,
  summarize: summarize,
  writeAll: writeAll,
  runCli: runCli
};

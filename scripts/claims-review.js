/**
 * @fileoverview The copy reviewer: reads ONLY the wording that changed in a
 * commit, decides whether any of it reads as a regulated claim, and reports.
 *
 * It never edits her copy and it never blocks a deploy. Those are not
 * implementation details, they are the reason it is allowed to exist: the
 * owner writes product copy alone at eleven at night, and the thing that would
 * actually cost her money is a sentence like "brings the itch right down" --
 * which no regex sees, and which a bot that rewrote her voice would replace
 * with something she would never say. So this file reports and stops.
 *
 * WHY TWO PASSES.
 *
 *   1. The rule table (scripts/lib/copy-claims-rules.js) is deterministic and
 *      owns every hard term the 1-2 September 2026 compliance review named:
 *      "heal", "repel", "eczema", "all natural". A hit is a DEFINITE finding
 *      and does not depend on a model being reachable, in a good mood, or paid
 *      for. If the second pass fails, the run still reports these and says the
 *      second pass was skipped.
 *   2. ONE batched call through scripts/lib/llm.js asks for the implied claims
 *      the table cannot express. The model is given the table (so it does not
 *      re-report what pass 1 has), the brand's voice, and the standing
 *      instruction that puffery -- "Miracle", "the good stuff" -- is not a
 *      claim. Its findings are LIKELY or POSSIBLE, never DEFINITE: it did not
 *      read the statute, it guessed well.
 *
 * WHAT IS REVIEWED. Only strings that were added or edited between two refs of
 * the five CMS-written data files plus the journal entries. An unchanged blurb
 * is not reviewed, on any run, ever -- otherwise every commit re-reports the
 * whole catalogue and the report becomes wallpaper.
 *
 * WHAT IS NEVER A FINDING. The wording the owner already knows about and has
 * not decided on -- "Y'all Heal Now", "Sleep Salve", "Backroad Recovery", the
 * bug spray's name and blurb -- is masked out of the scan and listed
 * separately as "known, pending your decision". Those phrases are read from
 * the live assets/data/products.json, so the day she renames a product the
 * entry disappears without anybody editing this file.
 *
 * HOW SHE ACTUALLY HEARS ABOUT IT. She will never open a GitHub issue, so a
 * run with findings also renders an email -- same words, same tone -- for the
 * workflow to send through Resend, the provider the site already uses
 * (workers/submit-form.js). Rendering and the send/skip decision live here and
 * are unit-tested; the network call is a separate CLI mode so the workflow can
 * keep RESEND_API_KEY on one step and nowhere else.
 *
 * Run:
 *   node scripts/claims-review.js                        # HEAD^ .. HEAD
 *   node scripts/claims-review.js --base <ref> --head <ref>
 *   node scripts/claims-review.js --provider mock        # no key, offline
 *   node scripts/claims-review.js --dry-run              # rule table only
 *   node scripts/claims-review.js --json out.json --markdown out.md
 *   node scripts/claims-review.js --head-dir /tmp/head   # head from a directory
 *   node scripts/claims-review.js --email-preview mail.json
 *   node scripts/claims-review.js --send-email mail.json # the only network mode
 *
 * stdout is the Markdown report; the JSON summary goes to --json (and to
 * stdout instead when --format json is given). Progress goes to stderr.
 * Exit 0 always, findings or not. Exit 2 only on a real error: a bad flag, an
 * unreadable ref, malformed JSON in a data file.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rules = require("./lib/copy-claims-rules.js");
const llm = require("./lib/llm.js");

const ROOT = path.resolve(__dirname, "..");

/** git's constant for the empty tree -- the base when HEAD has no parent. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/* One call, plus the shared client's retries. The second pass is one batch by
   design: a per-string call would cost 200 requests for a catalogue import and
   would still not see the whole change at once. */
const DEFAULT_MAX_CALLS = 6;
/* Guard rails on that single call. A bulk import can change hundreds of
   strings; the deterministic pass still reads every one of them. */
const MAX_MODEL_ITEMS = 120;
const MAX_MODEL_CHARS = 1200;

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/* ---------------------------------------------------------------
   Which fields carry copy.

   Patterns are dotted paths where an array segment ends in `[]`, `*` matches
   one segment and `**` matches any depth. Everything matched is filtered again
   by looksLikeCopy(), which is what keeps image paths, URLs, ids and hex
   analytics keys out of a report about wording.
   --------------------------------------------------------------- */

const FILE_SOURCES = [
  {
    file: "assets/data/products.json",
    fields: [
      { pattern: "products[].name", kind: "product name" },
      { pattern: "products[].blurb", kind: "blurb" },
      { pattern: "products[].description", kind: "description" },
      { pattern: "products[].ingredientsLabel", kind: "ingredients" },
      { pattern: "products[].ingredientsNote", kind: "ingredients note" },
      { pattern: "products[].ingredients[]", kind: "ingredient" },
      { pattern: "products[].scent", kind: "scent" },
      { pattern: "products[].scentProfile.*", kind: "scent note" },
      { pattern: "products[].ritualTitle", kind: "ritual title" },
      { pattern: "products[].usageGuide.*", kind: "how to use" },
      { pattern: "products[].tags[]", kind: "tag" },
      { pattern: "products[].keywords[]", kind: "search keyword" },
      { pattern: "products[].variants.name", kind: "variant label" },
      { pattern: "products[].variants.options[].label", kind: "variant option" },
      { pattern: "products[].estimatedBatchDate", kind: "batch note" },
      { pattern: "bundles[].name", kind: "gift set name" },
      { pattern: "bundles[].blurb", kind: "gift set copy" },
      { pattern: "sales[].**", kind: "deal copy" },
      { pattern: "volumePricing[].name", kind: "deal name" },
      { pattern: "volumePricing[].label", kind: "deal copy" },
      { pattern: "faq[].question", kind: "FAQ question" },
      { pattern: "faq[].answer", kind: "FAQ answer" },
      { pattern: "concerns[].name", kind: "filter label" },
      { pattern: "categories[].label", kind: "category label" },
      { pattern: "shop.**", kind: "shop setting" }
    ]
  },
  {
    file: "assets/data/content.json",
    fields: [
      { pattern: "site.footerTagline", kind: "footer" },
      { pattern: "site.announcement.text", kind: "announcement" },
      { pattern: "site.seasonalNotice.text", kind: "notice" },
      { pattern: "site.ritualDefaults.*", kind: "pairing copy" },
      { pattern: "site.newsletterTitle", kind: "newsletter" },
      { pattern: "site.newsletterSubtext", kind: "newsletter" },
      { pattern: "site.birthdayTitle", kind: "birthday club" },
      { pattern: "site.birthdaySubtext", kind: "birthday club" },
      { pattern: "site.loyaltyPointsName", kind: "loyalty" },
      { pattern: "site.loyaltyPointsSingular", kind: "loyalty" },
      { pattern: "site.automations.*", kind: "automated email" },
      { pattern: "home.**", kind: "home page" },
      { pattern: "about.**", kind: "about page" },
      { pattern: "shop.**", kind: "shop page" },
      { pattern: "events.**", kind: "events page" },
      { pattern: "contact.**", kind: "contact page" },
      { pattern: "faq.**", kind: "FAQ page" },
      { pattern: "legal.**", kind: "legal page" },
      { pattern: "journal.**", kind: "journal page" },
      { pattern: "search.**", kind: "search page" }
    ]
  },
  {
    file: "assets/data/events.json",
    fields: [
      { pattern: "*[].name", kind: "event name" },
      { pattern: "*[].type", kind: "event type" },
      { pattern: "*[].note", kind: "event note" }
    ]
  },
  {
    file: "assets/data/quiz.json",
    fields: [
      { pattern: "eyebrow", kind: "quiz copy" },
      { pattern: "title", kind: "quiz copy" },
      { pattern: "subtitle", kind: "quiz copy" },
      { pattern: "buttonText", kind: "quiz copy" },
      { pattern: "modalTitle", kind: "quiz copy" },
      { pattern: "modalSubtitle", kind: "quiz copy" },
      { pattern: "questions[].title", kind: "quiz question" },
      { pattern: "questions[].options[].label", kind: "quiz answer" },
      { pattern: "questions[].options[].description", kind: "quiz answer" }
    ]
  },
  {
    file: "assets/data/site-reviews.json",
    fields: [
      { pattern: "reviews[].text", kind: "customer review", isReview: true },
      { pattern: "reviews[].ownerReply", kind: "your reply" }
    ]
  }
];

/** The journal is a directory of entries, so its files are listed at run time. */
const JOURNAL_SOURCE = {
  dir: "assets/data/journal",
  fields: [
    { pattern: "title", kind: "journal title" },
    { pattern: "excerpt", kind: "journal excerpt" },
    { pattern: "content", kind: "journal post" },
    { pattern: "tags[]", kind: "journal tag" }
  ]
};

const ALL_FILES = FILE_SOURCES.map(function (s) {
  return s.file;
});

/* ---------------------------------------------------------------
   Pure logic. Everything down to runCli() is offline and side-effect free so
   scripts/claims-review.test.js can drive every branch.
   --------------------------------------------------------------- */

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value) {
  return String(value)
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;")
    .split('"')
    .join("&quot;");
}

/** `products[].usageGuide.*` / `home.**` against a concrete pattern path. */
function matchPattern(pattern, patternPath) {
  const rx =
    "^" +
    pattern
      .split("**")
      .map(function (chunk) {
        return chunk.split("*").map(escapeRegExp).join("[^.]*");
      })
      .join(".*") +
    "$";
  return new RegExp(rx).test(patternPath);
}

/**
 * Strings that are wording rather than plumbing. Applied to every match, so a
 * broad `home.**` cannot drag an image path or an analytics id into a report
 * about copy.
 */
function looksLikeCopy(value) {
  const v = String(value === undefined || value === null ? "" : value).trim();
  if (v.length < 2) return false;
  if (!/[A-Za-z]/.test(v)) return false;
  if (/^(https?:|mailto:|tel:|\/\/)/i.test(v)) return false;
  if (/^\/?[\w.-]+\/[\w./-]+$/.test(v)) return false;
  if (/^[\w-]+\.(html?|json|jpe?g|png|webp|avif|svg|css|js|xml|txt)$/i.test(v)) return false;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return false;
  if (/^[0-9a-f]{16,}$/i.test(v)) return false;
  if (/^[A-Z0-9_]{4,}$/.test(v)) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return true;
}

/**
 * Every copy string in one parsed document, keyed by a path that survives
 * reordering: an array of objects with ids is keyed by id, so moving a product
 * up the list is not "twenty edited strings".
 *
 * @return {!Map<string, {file, key, patternPath, kind, isReview, text}>}
 */
function extractStrings(doc, fields, file) {
  const out = new Map();
  function visit(node, patternPath, keyPath) {
    if (typeof node === "string") {
      const field = fields.filter(function (f) {
        return matchPattern(f.pattern, patternPath);
      })[0];
      if (!field || !looksLikeCopy(node)) return;
      out.set(keyPath, {
        file: file,
        key: keyPath,
        patternPath: patternPath,
        kind: field.kind,
        isReview: !!field.isReview,
        text: node
      });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(function (item, i) {
        const label = item && typeof item === "object" && item.id ? String(item.id) : String(i);
        visit(item, patternPath + "[]", keyPath + "[" + label + "]");
      });
      return;
    }
    if (node && typeof node === "object") {
      Object.keys(node).forEach(function (k) {
        visit(node[k], patternPath ? patternPath + "." + k : k, keyPath ? keyPath + "." + k : k);
      });
    }
  }
  visit(doc, "", "");
  return out;
}

/**
 * The strings that are new or edited between two versions of one file.
 * Deleted strings are not returned: copy that no longer exists cannot claim
 * anything.
 */
function changedStrings(baseMap, headMap) {
  const changed = [];
  headMap.forEach(function (entry, key) {
    const before = baseMap.get(key);
    if (before === undefined) {
      changed.push(Object.assign({ change: "added", previous: null }, entry));
      return;
    }
    if (before.text !== entry.text) {
      changed.push(Object.assign({ change: "edited", previous: before.text }, entry));
    }
  });
  return changed;
}

/* ---------------------------------------------------------------
   Pass 1: the rule table.
   --------------------------------------------------------------- */

/** "bug-spray - blurb", for a human reading a report. */
function describeWhere(entry) {
  const m = /^([A-Za-z]+)\[([^\]]+)\]\.(.+)$/.exec(entry.key);
  if (m) return m[2] + " - " + entry.kind;
  return entry.key ? entry.key + " - " + entry.kind : entry.kind;
}

function deterministicFindings(entries, table, allowlist) {
  const terms = rules.flattenTerms(table);
  const findings = [];
  const pendingSeen = new Set();
  entries.forEach(function (entry) {
    const scan = rules.scanText(entry.text, {
      terms: terms,
      allowlist: allowlist,
      isReview: entry.isReview
    });
    scan.pendingHits.forEach(function (id) {
      pendingSeen.add(id);
    });
    scan.matches.forEach(function (match) {
      findings.push({
        source: "rule table",
        severity: match.severity,
        file: entry.file,
        key: entry.key,
        where: describeWhere(entry),
        kind: entry.kind,
        change: entry.change,
        term: match.term,
        category: match.category,
        categoryLabel: match.categoryLabel,
        citation: match.citation,
        quote: match.quote,
        why: match.reason,
        suggestions: rules.suggestionsFor(match.term, match.ruleCategory, table)
      });
    });
  });
  return { findings: findings, pendingSeen: Array.from(pendingSeen) };
}

/* ---------------------------------------------------------------
   Pass 2: one batched model call.
   --------------------------------------------------------------- */

const BRAND_VOICE =
  "Southern, queer-owned, small-batch. Warm, dry, a little irreverent, never clinical and never " +
  "corporate. It says 'y'all'. It talks about rituals, porches, long days and hardworking hands.";

function buildSystemPrompt(table) {
  return [
    "You are reviewing the product copy of a small South Carolina cosmetics shop for wording that",
    "a regulator would read as a claim. You are NOT rewriting anything and you are NOT a lawyer;",
    "you are flagging sentences a careful person would want a second look at.",
    "",
    "BRAND VOICE: " + BRAND_VOICE,
    "",
    "A DETERMINISTIC RULE TABLE HAS ALREADY RUN over these strings and has already reported every",
    "occurrence of the terms below. Do NOT report them again. Your entire job is the wording the",
    "table CANNOT see: implied claims, euphemisms and paraphrases that mean the same thing.",
    "",
    rules.promptRules(table),
    "",
    "WHAT COUNTS AS A CLAIM (US law, cosmetics):",
    "  drug        -- any wording that says the product acts on the body, a symptom or a named",
    "                 condition. 'brings the itch right down', 'takes the ache out of your knees',",
    "                 'knocks out a headache', 'you will sleep like a rock' are all drug claims",
    "                 even though none of them uses a banned word.",
    "  pesticide   -- any wording that promises insects will stay away, however folksy:",
    "                 'they will leave you alone', 'sit on the porch in peace'.",
    "  marketing   -- an absolute or unverifiable promise about the formula: purity, safety,",
    "                 gentleness, 'nothing you cannot pronounce' framed as a guarantee.",
    "  testimonial -- a republished customer review that makes any of the above on the shop's",
    "                 behalf.",
    "",
    "WHAT IS NOT A CLAIM, and must never be reported:",
    "  - Puffery. 'Miracle', 'the good stuff', 'the one y'all keep re-ordering', 'best in the",
    "    Upstate'. A word like 'Miracle' in a product name is puffery, not a claim.",
    "  - Sensory description. How it smells, how it feels going on, what is in it.",
    "  - Ritual and mood framing. 'wind-down ritual', 'built for night owls', 'for the end of a",
    "    long day' are the APPROVED rewrites; do not flag them.",
    "  - Ingredient names, scent notes, sizes, prices, shipping and event details.",
    "",
    "For each finding give: the exact quote from the string (copy it verbatim, do not paraphrase),",
    "one plain sentence on why it reads as a claim, the category, your confidence, and ONE",
    "rewording that a Southern small-batch shop owner would actually say. Keep the voice.",
    "",
    "Report nothing rather than something you are unsure of. An empty findings array is a good",
    "answer and is expected most of the time."
  ].join("\n");
}

function buildUserPayload(entries) {
  return JSON.stringify({
    items: entries.map(function (entry) {
      return {
        id: entry.key,
        where: describeWhere(entry),
        text: String(entry.text).slice(0, MAX_MODEL_CHARS)
      };
    })
  });
}

function findingsSchema() {
  return {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            quote: { type: "string" },
            why: { type: "string" },
            category: {
              type: "string",
              enum: ["drug", "pesticide", "marketing", "testimonial"]
            },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            suggestion: { type: "string" }
          },
          required: ["id", "quote", "why", "category", "confidence", "suggestion"],
          additionalProperties: false
        }
      }
    },
    required: ["findings"],
    additionalProperties: false
  };
}

/**
 * The offline responder. It is not a stub that returns nothing: it runs the
 * whole second pass, merge and report path with no key and no network, which
 * is how the proof runs and the CI dry run work. Every `why` it writes starts
 * with "[mock]" for the same reason scripts/lib/llm.js prefixes "[es] " --
 * a mock finding must be impossible to mistake for a real one in a report.
 */
const MOCK_IMPLIED = [
  {
    pattern: /brings? (?:the )?[a-z ]{0,20}right down/i,
    category: "drug",
    why: "says the product acts on a symptom, which is what makes a cosmetic a drug",
    suggestion: "conditions the skin underneath"
  },
  {
    pattern: /keeps? (?:the )?(?:bugs?|bites|mosquitoes|skeeters)[a-z ]{0,12}away/i,
    category: "pesticide",
    why: "promises insects will stay away, which is a repellency claim under FIFRA",
    suggestion: "a porch mist for evenings outside"
  },
  {
    pattern: /(?:takes?|knocks?) the (?:ache|edge|pain|soreness) (?:out|off)/i,
    category: "drug",
    why: "says the product acts on an ache, which reads as a treatment claim",
    suggestion: "for tired legs and the end of a long day"
  },
  {
    pattern: /sleep like a (?:rock|baby|log)/i,
    category: "drug",
    why: "promises a sleep effect, which the FDA's aromatherapy guidance treats as a drug claim",
    suggestion: "part of your wind-down ritual"
  }
];

function mockResponder(spec) {
  const payload = JSON.parse(spec.user);
  const findings = [];
  (payload.items || []).forEach(function (item) {
    MOCK_IMPLIED.forEach(function (rule) {
      const hit = rule.pattern.exec(item.text);
      if (!hit) return;
      findings.push({
        id: item.id,
        quote: rules.sentenceAround(item.text, hit.index, hit[0].length),
        why: "[mock] " + rule.why,
        category: rule.category,
        confidence: "high",
        suggestion: rule.suggestion
      });
    });
  });
  return { findings: findings };
}

/** high -> likely, anything else -> possible. A model never says "definite". */
function severityForConfidence(confidence) {
  return String(confidence).toLowerCase() === "high" ? "likely" : "possible";
}

function categoryLabel(id, table) {
  if (id === rules.TESTIMONIAL_CATEGORY.id) return rules.TESTIMONIAL_CATEGORY.label;
  const hit = (table.categories || []).filter(function (c) {
    return c.id === id;
  })[0];
  return hit ? hit.label : id;
}

function citationFor(id, table) {
  if (id === rules.TESTIMONIAL_CATEGORY.id) return rules.TESTIMONIAL_CATEGORY.citation;
  const hit = (table.categories || []).filter(function (c) {
    return c.id === id;
  })[0];
  return hit ? hit.citation : "";
}

/**
 * The second pass. Returns model findings plus the reason it was skipped, if
 * it was. It NEVER throws: a model that is down must cost the run its second
 * pass and nothing else.
 */
async function modelPass(entries, table, client, log) {
  const say = log || function () {};
  if (!entries.length) return { findings: [], skipped: "nothing changed", truncated: 0 };
  if (!client) return { findings: [], skipped: "no model configured", truncated: 0 };
  const batch = entries.slice(0, MAX_MODEL_ITEMS);
  const truncated = entries.length - batch.length;
  const byKey = new Map();
  batch.forEach(function (entry) {
    byKey.set(entry.key, entry);
  });

  let response;
  try {
    response = await client.completeJSON({
      system: buildSystemPrompt(table),
      user: buildUserPayload(batch),
      schema: findingsSchema(),
      schemaName: "copy_claim_findings"
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    say("second pass skipped: " + message);
    return { findings: [], skipped: message, truncated: truncated };
  }

  const raw = response && Array.isArray(response.findings) ? response.findings : null;
  if (!raw) {
    return { findings: [], skipped: "the model returned no findings array", truncated: truncated };
  }

  const findings = [];
  raw.forEach(function (item) {
    const entry = byKey.get(item && item.id);
    /* A schema-conformant hallucination -- right shape, an id that was never
       sent, or a quote that is not in the string -- is the realistic failure
       mode, not a 500. Drop it rather than report copy she never wrote. */
    if (!entry) return;
    const quote = String((item && item.quote) || "").trim();
    if (!quote || entry.text.toLowerCase().indexOf(quote.toLowerCase()) === -1) return;
    const category = entry.isReview ? "testimonial" : String(item.category || "drug");
    findings.push({
      source: "second pass",
      severity: severityForConfidence(item.confidence),
      file: entry.file,
      key: entry.key,
      where: describeWhere(entry),
      kind: entry.kind,
      change: entry.change,
      term: null,
      category: category,
      categoryLabel: categoryLabel(category, table),
      citation: citationFor(category, table),
      quote: quote,
      why: String(item.why || "").trim(),
      suggestions: item.suggestion ? [String(item.suggestion).trim()] : []
    });
  });
  return { findings: findings, skipped: null, truncated: truncated };
}

/* ---------------------------------------------------------------
   Merge, dedupe, rank.
   --------------------------------------------------------------- */

function normalizeQuote(value) {
  return String(value).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Deterministic findings win every collision: they cite a rule, the model
 * cites itself. A model finding is dropped when the rule table already
 * reported a term for the same string and category and that term is inside the
 * model's quote -- otherwise one sentence with "all natural" in it gets
 * reported twice in two different voices.
 */
function mergeFindings(deterministic, model) {
  const out = [];
  const seen = new Set();
  deterministic.forEach(function (f) {
    const key = [f.file, f.key, f.category, String(f.term).toLowerCase()].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  });
  model.forEach(function (f) {
    const covered = deterministic.some(function (d) {
      return (
        d.file === f.file &&
        d.key === f.key &&
        d.category === f.category &&
        normalizeQuote(f.quote).indexOf(String(d.term).toLowerCase()) !== -1
      );
    });
    if (covered) return;
    const key = [f.file, f.key, f.category, normalizeQuote(f.quote)].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  });
  return out.sort(function (a, b) {
    const bySeverity = rules.severityRank(a.severity) - rules.severityRank(b.severity);
    if (bySeverity) return bySeverity;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return String(a.term || a.quote) < String(b.term || b.quote) ? -1 : 1;
  });
}

/* ---------------------------------------------------------------
   The report.
   --------------------------------------------------------------- */

const SEVERITY_WORDS = {
  definite: "This one is on the list by name",
  likely: "Worth a look",
  possible: "Maybe, your call"
};

const CITATION_TEXT = {
  S1: "compliance review, section 1 (cosmetic or drug?)",
  S3: "compliance review, section 3 (labels)",
  S4: "compliance review, section 4 (bug spray)",
  S4B: "compliance review, section 4b (republished reviews)"
};

function citationText(tag) {
  return CITATION_TEXT[tag] || "compliance review";
}

function quoted(value) {
  return '"' + String(value).replace(/\n+/g, " ") + '"';
}

/**
 * One finding as the three plain lines it becomes everywhere: the report, the
 * issue and the email all render THIS, so the wording cannot drift between the
 * place she reads it and the place Steven does.
 */
function findingLines(finding) {
  const lines = [
    (SEVERITY_WORDS[finding.severity] || finding.severity) +
      ": " +
      finding.why +
      (finding.term ? " (the word is " + quoted(finding.term) + ")" : "") +
      " -- " +
      citationText(finding.citation) +
      "."
  ];
  if (finding.suggestions && finding.suggestions.length) {
    lines.push("Try instead: " + finding.suggestions.map(quoted).join(", or "));
  }
  if (finding.category === rules.TESTIMONIAL_CATEGORY.id) {
    lines.push(rules.TESTIMONIAL_CATEGORY.note);
  }
  return lines;
}

/**
 * Findings that quote the same sentence, collapsed into one block.
 *
 * "brings the itch right down and keeps bites away, all natural" trips four
 * rules. Quoting her own sentence back at her four times is how a report stops
 * being read, so the sentence is printed once and the reasons stack under it.
 */
function groupFindings(findings) {
  const order = [];
  const groups = new Map();
  findings.forEach(function (f) {
    const key = [f.file, f.key, normalizeQuote(f.quote)].join("|");
    if (!groups.has(key)) {
      groups.set(key, { where: f.where, quote: f.quote, findings: [] });
      order.push(key);
    }
    groups.get(key).findings.push(f);
  });
  return order.map(function (key) {
    return groups.get(key);
  });
}

/**
 * The lines under one quoted sentence, with repeats removed: two marketing
 * terms in the same sentence share a rewording, and printing it twice makes
 * the report look automated in the bad way.
 */
function groupBullets(group) {
  const bullets = [];
  group.findings.forEach(function (f) {
    findingLines(f).forEach(function (line) {
      if (bullets.indexOf(line) === -1) bullets.push(line);
    });
  });
  return bullets;
}

function reviewedSentence(summary) {
  return (
    "A check read the " +
    summary.reviewed +
    " piece" +
    (summary.reviewed === 1 ? "" : "s") +
    " of wording that changed in this save" +
    (summary.files.length ? " (" + summary.files.join(", ") + ")" : "") +
    ". Nothing was changed for you -- this is a note, not an edit."
  );
}

/**
 * The issue body. Plain, non-alarming, the same register as the review that
 * was sent to the owner: quote the sentence, name the rule in one line, offer
 * one or two rewordings, and say plainly that nothing was changed.
 *
 * @param {Object} summary
 * @param {{date: (string|undefined), mention: (string|undefined)}=} options
 *     `mention` is the owner's GitHub login, when the repo sets one: an
 *     @-mention is the only way a GitHub issue reaches somebody who does not
 *     open GitHub.
 */
function renderMarkdown(summary, options) {
  const opts = options || {};
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push("## Copy review - " + date);
  lines.push("");
  if (opts.mention) lines.push("@" + String(opts.mention).replace(/^@/, "") + " -- for you.");
  if (opts.mention) lines.push("");
  lines.push(reviewedSentence(summary));
  lines.push("");

  if (!summary.findings.length) {
    lines.push("Nothing in what you changed reads as a health or bug-repellent promise. Carry on.");
  } else {
    const groups = groupFindings(summary.findings);
    lines.push(
      "There " +
        (groups.length === 1 ? "is one sentence" : "are " + groups.length + " sentences") +
        " here worth a second look."
    );
    lines.push("");
    groups.forEach(function (group, i) {
      lines.push("**" + (i + 1) + ". " + group.where + "**");
      lines.push("");
      lines.push("> " + String(group.quote).replace(/\n+/g, " "));
      lines.push("");
      groupBullets(group).forEach(function (line) {
        lines.push("- " + line);
      });
      lines.push("");
    });
  }

  if (summary.knownPending.length) {
    lines.push("");
    lines.push("### Already on your list");
    lines.push("");
    lines.push(
      "These are the wordings the September review put in front of you and you have not decided " +
        "on yet. They are not new, and nothing here needs doing today."
    );
    lines.push("");
    summary.knownPending.forEach(function (p) {
      lines.push("- " + pendingLine(p));
    });
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  if (summary.secondPassSkipped && summary.reviewed) {
    lines.push(
      "_The second read-through (the one that catches wording the word list cannot see) did not " +
        "run this time: " +
        summary.secondPassSkipped +
        ". Everything above still holds; there may be more it would have caught._"
    );
  } else if (summary.modelUsed) {
    lines.push(
      "_Two passes ran: a fixed word list, then a second read-through for wording that means the " +
        "same thing without using those words._"
    );
  }
  if (summary.fallbackWarning) {
    lines.push("");
    lines.push("_Note for Steven: " + summary.fallbackWarning + "_");
  }
  lines.push("");
  lines.push("_General guidance, not legal advice. This check never edits your words._");
  return lines.join("\n") + "\n";
}

function pendingLine(p) {
  return (
    quoted(p.phrase.length > 90 ? p.phrase.slice(0, 90).trim() + "..." : p.phrase) +
    " - " +
    p.why +
    (p.suggested && p.suggested.length
      ? " Options: " + p.suggested.map(quoted).join(", ") + "."
      : "") +
    (p.touchedThisChange ? " (You edited this one in this save.)" : "")
  );
}

/* ---------------------------------------------------------------
   The email.

   She will not open a GitHub issue. Resend is the provider the site already
   uses (workers/submit-form.js), the sender is whatever address that account
   has verified, and the recipient is the shop mailbox in content.json -- read
   at run time, never typed in here, so changing it in the CMS changes it here.
   --------------------------------------------------------------- */

/** The shop mailbox as content.json currently states it. */
function ownerEmail(contentDoc) {
  const value = contentDoc && contentDoc.contact && contentDoc.contact.email;
  return typeof value === "string" && value.indexOf("@") !== -1 ? value.trim() : null;
}

/** Product ids named by the findings, in report order. */
function findingProductIds(summary) {
  const ids = [];
  summary.findings.forEach(function (f) {
    if (f.file !== "assets/data/products.json") return;
    const m = /^products\[([^\]]+)\]/.exec(f.key);
    if (m && ids.indexOf(m[1]) === -1) ids.push(m[1]);
  });
  return ids;
}

/**
 * "A note about your wording on Bourbon Beard Salve" when one product is
 * involved, "on 3 products" when several, and a neutral line when the wording
 * was somewhere other than a product.
 */
function emailSubject(summary, productsDoc) {
  const ids = findingProductIds(summary);
  const byId = {};
  ((productsDoc && productsDoc.products) || []).forEach(function (p) {
    if (p && p.id) byId[p.id] = p.name || p.id;
  });
  if (ids.length === 1) return "A note about your wording on " + (byId[ids[0]] || ids[0]);
  if (ids.length > 1) return "A note about your wording on " + ids.length + " products";
  return "A note about some wording you just saved";
}

/**
 * The email in both parts. Built from the same findingLines() the issue uses,
 * so the two can never say different things.
 *
 * @return {{subject: string, to: string, html: string, text: string}}
 */
function renderEmail(summary, options) {
  const opts = options || {};
  const to = opts.to || null;
  const subject = opts.subject || emailSubject(summary, opts.productsDoc);
  const text = [];
  const html = [];

  text.push("Hey Savanna,");
  text.push("");
  text.push(reviewedSentence(summary));
  text.push("");
  html.push("<p>Hey Savanna,</p>");
  html.push("<p>" + escapeHtml(reviewedSentence(summary)) + "</p>");

  groupFindings(summary.findings).forEach(function (group, i) {
    text.push(i + 1 + ". " + group.where);
    text.push("   " + quoted(String(group.quote).replace(/\n+/g, " ")));
    html.push("<p><strong>" + (i + 1) + ". " + escapeHtml(group.where) + "</strong></p>");
    html.push(
      '<blockquote style="margin:0 0 8px 12px;padding-left:10px;border-left:3px solid #ccc">' +
        escapeHtml(String(group.quote).replace(/\n+/g, " ")) +
        "</blockquote>"
    );
    const bullets = groupBullets(group);
    bullets.forEach(function (line) {
      text.push("   - " + line);
    });
    html.push(
      "<ul>" +
        bullets
          .map(function (line) {
            return "<li>" + escapeHtml(line) + "</li>";
          })
          .join("") +
        "</ul>"
    );
    text.push("");
  });

  const closing =
    "Nothing on the site was changed -- your words are exactly as you saved them. This is " +
    "general guidance, not legal advice.";
  text.push(closing);
  html.push("<p>" + escapeHtml(closing) + "</p>");

  return { to: to, subject: subject, text: text.join("\n") + "\n", html: html.join("\n") };
}

/**
 * Whether this run has anything to email her about. CONTENT ONLY -- the
 * credentials are a separate question, answered in the step that holds them
 * (see sendBlockedReason). Deciding both here would mean the review step, which
 * deliberately has no RESEND_API_KEY, always concluding "do not send".
 *
 * Findings only. A run with nothing but knownPending found nothing new, and an
 * email that says "still those same four names" every time she edits a price is
 * an email she filters.
 */
function shouldSendEmail(summary) {
  if (!summary.findings.length) {
    return { send: false, reason: "no findings -- nothing to tell her about" };
  }
  if (!summary.emailTo) {
    return { send: false, reason: "no contact.email in assets/data/content.json" };
  }
  return { send: true, reason: null };
}

/**
 * Why the send cannot happen, or null. Separate from shouldSendEmail because
 * it is asked in a different step, by the only step that holds the key.
 */
function sendBlockedReason(env) {
  const e = env || {};
  if (!e.RESEND_API_KEY) return "RESEND_API_KEY is not set on this repository";
  if (!e.FROM_EMAIL) return "FROM_EMAIL is not set on this repository";
  return null;
}

/**
 * The one network call in this file, isolated so the workflow can hold
 * RESEND_API_KEY on a single step. Never throws: a provider outage costs the
 * email and nothing else -- the issue is still filed and the run is still
 * green.
 *
 * @return {!Promise<{sent: boolean, reason: (string|null), status: (number|null)}>}
 */
async function sendEmail(payload, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const doFetch = opts.fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return { sent: false, reason: "no fetch available", status: null };
  try {
    const res = await doFetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        /* The key rides in a header, never a URL, and is never echoed into a
           log line -- GitHub's masking is best-effort and a Resend key is not
           on its auto-redaction list. */
        Authorization: "Bearer " + env.RESEND_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: env.FROM_EMAIL,
        to: [payload.to],
        subject: payload.subject,
        html: payload.html,
        text: payload.text
      })
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = String(await res.text()).slice(0, 300);
      } catch {
        detail = "";
      }
      return {
        sent: false,
        reason: "Resend returned HTTP " + res.status + (detail ? ": " + detail : ""),
        status: res.status
      };
    }
    return { sent: true, reason: null, status: res.status };
  } catch (err) {
    return {
      sent: false,
      reason: "Resend request failed: " + (err && err.message ? err.message : String(err)),
      status: null
    };
  }
}

/* ---------------------------------------------------------------
   Reading a version of a file: from a git ref, or from a directory.
   --------------------------------------------------------------- */

function git(args, options) {
  const res = spawnSync("git", args, {
    cwd: (options && options.cwd) || ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

function refExists(ref) {
  if (!ref) return false;
  if (/^0{40}$/.test(ref)) return false;
  return git(["rev-parse", "--verify", "--quiet", ref + "^{object}"]).status === 0;
}

/**
 * The base ref actually used, with the fallbacks written down rather than
 * improvised in YAML: the pushed `before` sha is not always fetched (the
 * workflow clones with fetch-depth 2), and a branch's first push sends the
 * all-zero sha. In both cases HEAD^ is the honest answer, and when HEAD has no
 * parent the empty tree is -- every string is then "added", which is correct.
 */
function resolveBase(requested) {
  const tried = [];
  const candidates = [requested, "HEAD^", EMPTY_TREE].filter(Boolean);
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i] === EMPTY_TREE || refExists(candidates[i])) {
      return { ref: candidates[i], fellBackFrom: tried };
    }
    tried.push(candidates[i]);
  }
  return { ref: EMPTY_TREE, fellBackFrom: tried };
}

/** One file at one location. Returns null when the file did not exist there. */
function readAt(location, rel) {
  if (location.dir) {
    const p = path.join(location.dir, rel);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf8");
  }
  if (location.worktree) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf8");
  }
  const res = git(["show", location.ref + ":" + rel]);
  return res.status === 0 ? res.stdout : null;
}

function listJournalAt(location) {
  if (location.dir || location.worktree) {
    const base = path.join(location.dir || ROOT, JOURNAL_SOURCE.dir);
    if (!fs.existsSync(base)) return [];
    return fs
      .readdirSync(base)
      .filter(function (f) {
        return f.endsWith(".json");
      })
      .map(function (f) {
        return JOURNAL_SOURCE.dir + "/" + f;
      })
      .sort();
  }
  const res = git(["ls-tree", "--name-only", location.ref, JOURNAL_SOURCE.dir + "/"]);
  if (res.status !== 0) return [];
  return res.stdout
    .split("\n")
    .map(function (l) {
      return l.trim();
    })
    .filter(function (l) {
      return l.endsWith(".json");
    })
    .sort();
}

function parseJson(text, rel) {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    const e = new Error(rel + " is not valid JSON: " + (err && err.message ? err.message : err));
    e.code = "BAD_JSON";
    throw e;
  }
}

/**
 * Every changed copy string between two locations, across every source file.
 * A file that is absent on both sides, or byte-identical, costs one read and
 * produces nothing.
 */
function collectChanges(baseLocation, headLocation, onlyFiles) {
  const sources = FILE_SOURCES.filter(function (s) {
    return !onlyFiles || onlyFiles.indexOf(s.file) !== -1;
  }).slice();

  listJournalAt(headLocation).forEach(function (rel) {
    if (onlyFiles && onlyFiles.indexOf(rel) === -1) return;
    sources.push({ file: rel, fields: JOURNAL_SOURCE.fields });
  });

  const changed = [];
  const filesTouched = [];
  sources.forEach(function (source) {
    const headText = readAt(headLocation, source.file);
    if (headText === null) return;
    const baseText = readAt(baseLocation, source.file);
    if (baseText === headText) return;
    const headMap = extractStrings(parseJson(headText, source.file), source.fields, source.file);
    const baseDoc = parseJson(baseText, source.file);
    const baseMap = baseDoc ? extractStrings(baseDoc, source.fields, source.file) : new Map();
    const delta = changedStrings(baseMap, headMap);
    if (delta.length) {
      filesTouched.push(source.file);
      delta.forEach(function (d) {
        changed.push(d);
      });
    }
  });
  return { changed: changed, files: filesTouched };
}

/* ---------------------------------------------------------------
   The run.
   --------------------------------------------------------------- */

/**
 * @param {{changed: !Array, productsDoc: Object, table: Object,
 *          client: (Object|undefined), log: (Function|undefined)}} input
 */
async function review(input) {
  const log = input.log || function () {};
  const table = input.table;
  const allowlist = rules.buildAllowlist(input.productsDoc);
  const pass1 = deterministicFindings(input.changed, table, allowlist);
  log(
    "rule table: " +
      pass1.findings.length +
      " finding(s) over " +
      input.changed.length +
      " string(s)"
  );

  const pass2 = await modelPass(input.changed, table, input.client, log);
  const findings = mergeFindings(pass1.findings, pass2.findings);

  const knownPending = allowlist.map(function (entry) {
    return {
      id: entry.id,
      phrase: entry.phrase,
      why: entry.why,
      citation: entry.citation,
      suggested: entry.suggested,
      touchedThisChange: pass1.pendingSeen.indexOf(entry.id) !== -1
    };
  });

  return {
    findings: findings,
    knownPending: knownPending,
    secondPassSkipped: pass2.skipped || null,
    secondPassTruncated: pass2.truncated || 0
  };
}

function parseArgs(argv) {
  const args = {
    base: null,
    head: null,
    headDir: null,
    baseDir: null,
    files: null,
    provider: null,
    json: null,
    markdown: null,
    emailPreview: null,
    sendEmail: null,
    format: "markdown",
    dryRun: false
  };
  const needsValue = [
    "base",
    "head",
    "head-dir",
    "base-dir",
    "provider",
    "json",
    "markdown",
    "email-preview",
    "send-email",
    "format"
  ];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--head") args.head = argv[++i];
    else if (a === "--head-dir") args.headDir = argv[++i];
    else if (a === "--base-dir") args.baseDir = argv[++i];
    else if (a === "--provider") args.provider = argv[++i];
    else if (a === "--json") args.json = argv[++i];
    else if (a === "--markdown") args.markdown = argv[++i];
    else if (a === "--email-preview") args.emailPreview = argv[++i];
    else if (a === "--send-email") args.sendEmail = argv[++i];
    else if (a === "--format") args.format = argv[++i];
    else if (a === "--files") {
      args.files = [];
      while (i + 1 < argv.length && String(argv[i + 1]).indexOf("--") !== 0) {
        args.files.push(argv[++i]);
      }
      if (!args.files.length) throw new Error("--files needs at least one path");
    } else throw new Error("Unknown argument: " + a);
  }
  needsValue.forEach(function (flag) {
    const key = flag.replace(/-([a-z])/g, function (m, c) {
      return c.toUpperCase();
    });
    if (argv.indexOf("--" + flag) !== -1 && !args[key]) {
      throw new Error("--" + flag + " needs a value");
    }
  });
  if (["markdown", "json", "both"].indexOf(args.format) === -1) {
    throw new Error("--format must be markdown, json or both");
  }
  return args;
}

function locationsFor(args) {
  const head = args.headDir
    ? { dir: path.resolve(args.headDir), label: args.headDir }
    : args.head === "worktree"
      ? { worktree: true, label: "working tree" }
      : { ref: args.head || "HEAD", label: args.head || "HEAD" };
  if (args.baseDir) {
    return { base: { dir: path.resolve(args.baseDir), label: args.baseDir }, head: head };
  }
  const resolved = resolveBase(args.base);
  return {
    base: {
      ref: resolved.ref,
      label: resolved.ref === EMPTY_TREE ? "an empty tree (no earlier version)" : resolved.ref,
      fellBackFrom: resolved.fellBackFrom
    },
    head: head
  };
}

/** `--send-email <payload.json>`: the only mode that touches the network. */
async function runSendMode(payloadPath) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
  } catch (err) {
    console.error("claims-review: cannot read " + payloadPath + " -- no email sent.");
    console.error("  " + (err && err.message ? err.message : err));
    return 0;
  }
  if (!doc.send || !doc.payload) {
    console.error(
      "claims-review: no email to send (" + (doc.reason || "no reason recorded") + ")."
    );
    return 0;
  }
  const blocked = sendBlockedReason(process.env);
  if (blocked) {
    console.error(
      "claims-review: " +
        blocked +
        " -- the note was NOT emailed. Add both RESEND_API_KEY (secret) and FROM_EMAIL " +
        "(variable) to send it; the issue has the same text either way."
    );
    return 0;
  }
  const result = await sendEmail(doc.payload, {});
  if (result.sent) {
    console.error("claims-review: emailed the note to " + doc.payload.to + ".");
  } else {
    console.error("claims-review: the email did not go out -- " + result.reason);
    console.error("  The issue still has the same text; nothing else is affected.");
  }
  return 0;
}

async function runCli(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(String(err.message));
    console.error(
      "Usage: node scripts/claims-review.js [--base <ref>] [--head <ref>|worktree]\n" +
        "       [--base-dir <dir>] [--head-dir <dir>] [--files <path>...]\n" +
        "       [--provider gemini|groq|mock] [--json <path>] [--markdown <path>]\n" +
        "       [--email-preview <path>] [--format markdown|json|both] [--dry-run]\n" +
        "       node scripts/claims-review.js --send-email <path>"
    );
    return 2;
  }

  if (args.sendEmail) return runSendMode(args.sendEmail);

  const log = function (line) {
    console.error("  " + line);
  };

  let locations;
  let collected;
  let productsDoc;
  let contentDoc;
  let table;
  try {
    locations = locationsFor(args);
    if (locations.base.fellBackFrom && locations.base.fellBackFrom.length) {
      log(
        "base ref " +
          locations.base.fellBackFrom.join(", ") +
          " is not in this clone -- comparing against " +
          locations.base.label
      );
    }
    table = rules.loadTable();
    collected = collectChanges(locations.base, locations.head, args.files);
    const productsText = readAt(locations.head, "assets/data/products.json");
    productsDoc = productsText ? JSON.parse(productsText) : { products: [] };
    const contentText = readAt(locations.head, "assets/data/content.json");
    contentDoc = contentText ? JSON.parse(contentText) : {};
  } catch (err) {
    console.error("claims-review could not start: " + (err && err.message ? err.message : err));
    return 2;
  }

  console.error(
    "claims-review: " +
      locations.base.label +
      " -> " +
      locations.head.label +
      ", " +
      collected.changed.length +
      " changed string(s) in " +
      collected.files.length +
      " file(s)"
  );

  let client = null;
  let clientError = null;
  if (args.dryRun) {
    clientError = "the run was asked for the word list only (--dry-run)";
  } else if (collected.changed.length) {
    try {
      client = llm.createClient({
        provider: args.provider,
        models: process.env.CLAIMS_MODELS,
        maxCalls: Number(process.env.CLAIMS_MAX_CALLS) || DEFAULT_MAX_CALLS,
        mockResponder: mockResponder
      });
    } catch (err) {
      /* No key on the machine is the NORMAL case for a fork, a local run and
         any CI run without the secret. It costs the second pass and nothing
         else -- never the run. */
      clientError = err && err.message ? err.message : String(err);
      log("no second pass: " + clientError);
    }
  }

  let result;
  try {
    result = await review({
      changed: collected.changed,
      productsDoc: productsDoc,
      table: table,
      client: client,
      log: log
    });
  } catch (err) {
    console.error("claims-review failed: " + (err && err.message ? err.message : err));
    return 2;
  }

  const summary = {
    base: locations.base.label,
    head: locations.head.label,
    files: collected.files,
    reviewed: collected.changed.length,
    findings: result.findings,
    knownPending: result.knownPending,
    modelUsed: !!client && !result.secondPassSkipped,
    provider: client ? client.telemetry.provider : null,
    model: client ? client.telemetry.model : null,
    calls: client ? client.telemetry.calls : 0,
    /* The client error is the more useful sentence when there is one: "no key"
       and "--dry-run" say WHY, where modelPass can only say there was nothing
       to call. */
    secondPassSkipped: clientError || result.secondPassSkipped || null,
    secondPassTruncated: result.secondPassTruncated,
    fallbackWarning: client ? client.fallbackWarning() : null,
    emailTo: ownerEmail(contentDoc)
  };

  const markdown = renderMarkdown(summary, { mention: process.env.OWNER_GITHUB_LOGIN || null });
  const json = JSON.stringify(summary, null, 2) + "\n";
  if (args.json) fs.writeFileSync(args.json, json);
  if (args.markdown) fs.writeFileSync(args.markdown, markdown);

  if (args.emailPreview) {
    const decision = shouldSendEmail(summary);
    const envelope = {
      send: decision.send,
      reason: decision.reason,
      payload: summary.findings.length
        ? renderEmail(summary, { to: summary.emailTo, productsDoc: productsDoc })
        : null
    };
    fs.writeFileSync(args.emailPreview, JSON.stringify(envelope, null, 2) + "\n");
    log(
      decision.send ? "an email is queued for " + summary.emailTo : "no email: " + decision.reason
    );
  }

  if (args.format === "json") process.stdout.write(json);
  else if (args.format === "both") process.stdout.write(json + "\n" + markdown);
  else process.stdout.write(markdown);

  console.error(
    "\nclaims-review: " +
      summary.findings.length +
      " finding(s), " +
      summary.knownPending.length +
      " known pending decision(s)" +
      (summary.secondPassSkipped ? ", second pass skipped" : "") +
      "."
  );
  return 0;
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then(function (code) {
    process.exit(code);
  });
}

module.exports = {
  FILE_SOURCES: FILE_SOURCES,
  JOURNAL_SOURCE: JOURNAL_SOURCE,
  ALL_FILES: ALL_FILES,
  EMPTY_TREE: EMPTY_TREE,
  RESEND_ENDPOINT: RESEND_ENDPOINT,
  matchPattern: matchPattern,
  looksLikeCopy: looksLikeCopy,
  extractStrings: extractStrings,
  changedStrings: changedStrings,
  describeWhere: describeWhere,
  deterministicFindings: deterministicFindings,
  buildSystemPrompt: buildSystemPrompt,
  buildUserPayload: buildUserPayload,
  findingsSchema: findingsSchema,
  mockResponder: mockResponder,
  severityForConfidence: severityForConfidence,
  modelPass: modelPass,
  mergeFindings: mergeFindings,
  findingLines: findingLines,
  groupFindings: groupFindings,
  renderMarkdown: renderMarkdown,
  ownerEmail: ownerEmail,
  emailSubject: emailSubject,
  renderEmail: renderEmail,
  shouldSendEmail: shouldSendEmail,
  sendBlockedReason: sendBlockedReason,
  sendEmail: sendEmail,
  resolveBase: resolveBase,
  readAt: readAt,
  collectChanges: collectChanges,
  review: review,
  parseArgs: parseArgs,
  locationsFor: locationsFor,
  runCli: runCli
};

/**
 * @fileoverview The English claims vocabulary for the owner's OWN copy, as data.
 *
 * scripts/lib/i18n-claims-rules.js is the sibling of this file and answers a
 * different question: "did the translation invent a claim the English does not
 * make?". This one answers "does the English make one?" -- which is the
 * question that matters, because the English is what the FDA, the FTC and the
 * EPA would read, and because a translation gate cannot catch a sentence the
 * owner wrote in English at 11pm.
 *
 * THE RULEBOOK. Every term, reason and citation tag below comes from the
 * compliance review delivered to the owner on 1-2 September 2026. The citation
 * tags are that document's own section numbers so a finding can be traced back
 * to the paragraph that justifies it rather than to somebody's opinion:
 *
 *   S1   Cosmetic or drug? -- intended use is read from the label, the site
 *        and the advertising, PRODUCT NAMES INCLUDED.
 *   S3   Labels -- "all natural" / "preservative-free" are untrue for formulas
 *        carrying Optiphen or Germall Plus; "organic" needs USDA; FTC's 2016
 *        consent orders are about exactly this.
 *   S4   Bug spray -- a repellent claim makes the product a pesticide under
 *        FIFRA, and the formula very likely fails the 25(b) exemption.
 *   S4B  Republished reviews -- a testimonial the shop republishes is treated
 *        as the shop's own claim.
 *
 * THREE PARTS, and the reason they are separate:
 *
 *   (a) CLAIM_TABLE   hard terms. A hit is a DEFINITE finding: no judgement
 *                     was involved, so none is claimed.
 *   (b) PENDING_DECISIONS  the wording the owner already knows about and has
 *                     not decided on. These are reported as "known, pending
 *                     your decision" and NEVER as new findings, because a
 *                     reviewer that re-reports "Y'all Heal Now" on every
 *                     commit is a reviewer she stops reading. The phrases are
 *                     read from assets/data/products.json at run time, so the
 *                     day she renames a product the entry disappears on its
 *                     own instead of going stale.
 *   (c) REWORDINGS    the "try instead" patterns from the review, in her voice.
 *                     A finding without a rewording is a complaint.
 *
 * CHANGING THE WORD LISTS WITHOUT TOUCHING THIS FILE. A later research brief
 * will move terms in and out. `loadTable()` merges a JSON overlay -- passed as
 * an option, or named by the COPY_CLAIMS_TABLE environment variable -- over
 * CLAIM_TABLE:
 *
 *   {
 *     "categories": {
 *       "drug":      { "add": [{ "term": "detox", "reason": "..." }],
 *                      "remove": ["pain"] },
 *       "marketing": { "add": ["clean"] }
 *     },
 *     "rewordings": [{ "when": ["detox"], "try": ["a long soak, nothing more"] }]
 *   }
 *
 * An overlay entry may be a bare string (it inherits the category's default
 * reason) or an object. Nothing in the merge is clever: add appends, remove
 * filters, and an unknown category id is an error rather than a silent no-op,
 * because a typo in a research brief must not quietly disable a rule.
 */

/* ---------------------------------------------------------------
   (a) The hard terms.
   --------------------------------------------------------------- */

/* Reasons that several terms share, written once so they cannot drift. */
const R_CONDITION =
  "naming a condition the product acts on states an intended use, which is what makes a " +
  "cosmetic a drug";
const R_SYMPTOM =
  "acting on a symptom is a drug claim -- FDA warning letters to small makers cite exactly " +
  "this wording";
const R_ACTION =
  "an -inflammatory/-bacterial/-septic/-fungal action is a drug claim, whatever the ingredient";
const R_REPELLENT =
  "promising to keep insects away makes the product a pesticide under FIFRA, and this formula " +
  "very likely fails the 25(b) minimum-risk exemption";
const R_UNSUPPORTED =
  "an absolute product promise the formula cannot support -- the FTC treats these as express " +
  "efficacy claims";

/**
 * Hard terms by category. Order matters only for readability; matching sorts
 * by length so "all natural" wins over "natural" on the same span.
 *
 * `severity` is per category and may be overridden per term. Everything here
 * is "definite" on purpose: a hard term is a term nobody had to interpret.
 */
const CLAIM_TABLE = {
  categories: [
    {
      id: "drug",
      label: "Reads as a drug or treatment claim",
      citation: "S1",
      severity: "definite",
      defaultReason: R_CONDITION,
      terms: [
        {
          term: "heal",
          reason:
            "'heal' describes acting on the body, and the FDA reads product names as evidence of intended use"
        },
        {
          term: "heals",
          reason: "'heals' describes acting on the body, not on how skin looks or feels"
        },
        {
          term: "healing",
          reason: "'healing' describes acting on the body, not on how skin looks or feels"
        },
        {
          term: "cure",
          reason: "'cure' is the textbook drug claim; it is in the FDA's own disclaimer wording"
        },
        {
          term: "cures",
          reason: "'cures' is the textbook drug claim; it is in the FDA's own disclaimer wording"
        },
        { term: "treat", reason: "to treat a condition is the statutory definition of a drug" },
        { term: "treats", reason: "to treat a condition is the statutory definition of a drug" },
        {
          term: "treatment",
          reason: "'treatment' names a medical purpose rather than a cosmetic one"
        },
        { term: "relief", reason: R_SYMPTOM },
        { term: "relieve", reason: R_SYMPTOM },
        { term: "relieves", reason: R_SYMPTOM },
        { term: "anti-inflammatory", reason: R_ACTION },
        { term: "antibacterial", reason: R_ACTION },
        { term: "antiseptic", reason: R_ACTION },
        { term: "antifungal", reason: R_ACTION },
        { term: "pain", reason: R_SYMPTOM },
        { term: "inflammation", reason: R_SYMPTOM },
        { term: "eczema", reason: R_CONDITION },
        { term: "psoriasis", reason: R_CONDITION },
        { term: "dermatitis", reason: R_CONDITION },
        { term: "rosacea", reason: R_CONDITION },
        { term: "acne", reason: R_CONDITION },
        { term: "wound", reason: "wound care is drug territory, not cosmetics" },
        { term: "infection", reason: "preventing or clearing an infection is a drug claim" },
        { term: "arthritis", reason: R_CONDITION },
        { term: "migraine", reason: R_CONDITION },
        { term: "insomnia", reason: R_CONDITION },
        { term: "anxiety", reason: R_CONDITION },
        {
          term: "helps you sleep",
          reason: "the FDA's aromatherapy guidance names this exact phrase as a drug claim"
        }
      ]
    },
    {
      id: "pesticide",
      label: "Reads as an insect-repellent (pesticide) claim",
      citation: "S4",
      severity: "definite",
      defaultReason: R_REPELLENT,
      terms: [
        { term: "repel", reason: R_REPELLENT },
        { term: "repels", reason: R_REPELLENT },
        { term: "repellent", reason: R_REPELLENT },
        { term: "mosquito", reason: R_REPELLENT },
        { term: "mosquitoes", reason: R_REPELLENT },
        { term: "tick", reason: R_REPELLENT },
        { term: "ticks", reason: R_REPELLENT },
        {
          term: "bites",
          reason: "promising fewer bites is a repellency claim even without the word 'repel'"
        },
        {
          term: "bug spray",
          reason: "'spray' for bugs names the product as a pesticide rather than a scented mist"
        },
        {
          term: "buzz off",
          reason:
            "the FTC reads 'buzz off' as an unsupported efficacy claim, and the EPA reads it as repellency"
        }
      ]
    },
    {
      id: "marketing",
      label: "Reads as an unsubstantiated marketing claim",
      citation: "S3",
      severity: "definite",
      defaultReason: R_UNSUPPORTED,
      terms: [
        {
          term: "natural",
          reason:
            "'natural' beside a synthetic preservative (Optiphen, Germall Plus) is the claim the FTC's 2016 consent orders were about"
        },
        {
          term: "all natural",
          reason: "'all natural' is untrue for any formula carrying a synthetic preservative"
        },
        {
          term: "chemical-free",
          reason: "nothing is chemical-free, and the FTC has said so"
        },
        { term: "non-toxic", reason: R_UNSUPPORTED },
        {
          term: "preservative-free",
          reason: "untrue for the formulas that carry Optiphen or Germall Plus"
        },
        {
          term: "hypoallergenic",
          reason: "the FDA has no standard for it, so it is an unsupportable promise"
        },
        {
          term: "dermatologist tested",
          reason: "only usable with a real test on file, and there is none"
        },
        { term: "organic", reason: "'organic' on a cosmetic needs USDA certification" },
        {
          term: "safe",
          reason: "an unqualified safety promise is not supportable for any cosmetic"
        }
      ]
    }
  ]
};

/**
 * The extra tag a finding carries when the sentence is a republished customer
 * review rather than the shop's own copy. Prior review S4b: a testimonial the
 * shop republishes is treated as the shop's own claim, so the same terms apply
 * -- but the fix is different (leave it on Etsy, or move it off the product
 * page), which is why it is reported as its own category.
 */
const TESTIMONIAL_CATEGORY = {
  id: "testimonial",
  label: "Republished review that makes a claim on the shop's behalf",
  citation: "S4B",
  severity: "definite",
  note:
    "A review you republish reads as your own claim. Options: leave it on Etsy only, move it " +
    "off the product page to the reviews page under the disclosure, or keep it and accept a " +
    "small risk."
};

/* ---------------------------------------------------------------
   (b) The owner's pending decisions.
   --------------------------------------------------------------- */

/**
 * Wording the review already put in front of the owner and that she has not
 * decided on. Keyed by product id and field so the live phrase is read from
 * assets/data/products.json rather than retyped here -- rename the product and
 * the entry vanishes by itself.
 */
const PENDING_DECISIONS = [
  {
    id: "frankincense-salve-name",
    productId: "frankincense-salve",
    field: "name",
    citation: "S1",
    why: "'Heal' in a product name is a treatment claim, and the FDA cites product names in warning letters.",
    suggested: ["Y'all Be Well Frankincense Salve", "Frankincense Comfort Salve"]
  },
  {
    id: "sleep-salve-name",
    productId: "sleep-salve",
    field: "name",
    citation: "S1",
    why: "The FDA's aromatherapy guidance names a sleep effect as a drug claim.",
    suggested: ["Hush Y'all Magnesium Arnica Night Salve", "Hush Y'all Bedtime Salve"]
  },
  {
    id: "backroad-soak-name",
    productId: "backroad-soak",
    field: "name",
    citation: "S1",
    why: "'Recovery' is a claim about what the soak does to the body, and the Etsy title adds 'muscle soak'.",
    suggested: ["Backroad Reset Epsom Salt Soak", "Backroad Wind-Down Soak"]
  },
  {
    id: "bug-spray-name",
    productId: "bug-spray",
    field: "name",
    citation: "S4",
    why: "Selling it as a bug spray is the repellent claim itself, which makes it a pesticide under FIFRA.",
    suggested: ["Bug Off B*tch Porch Mist", "Bug Off B*tch Outdoor Mist"]
  },
  {
    id: "bug-spray-blurb",
    productId: "bug-spray",
    field: "blurb",
    citation: "S4",
    why: "The blurb carries the repellent promise and the word 'natural' beside a synthetic preservative.",
    suggested: [
      "a porch mist for evenings outside -- citronella, lemongrass and peppermint, for the scent",
      "an outdoor mist you spray on before you sit down; no promises about what the bugs do"
    ]
  }
];

/* ---------------------------------------------------------------
   (c) The rewordings, straight out of the review.
   --------------------------------------------------------------- */

const REWORDINGS = [
  {
    when: ["pain", "inflammation", "arthritis", "relief", "relieve", "relieves", "treatment"],
    try: [
      "tired legs, hardworking hands, worked-hard joints",
      "the ache of a long day, without saying what it does about it"
    ]
  },
  {
    when: ["eczema", "psoriasis", "dermatitis", "rosacea", "acne", "wound", "infection"],
    try: ["rough, dry patches", "thirsty skin that has had a week of it"]
  },
  {
    when: ["insomnia", "anxiety", "helps you sleep"],
    try: ["your wind-down ritual", "built for night owls and overthinkers"]
  },
  {
    when: [
      "heal",
      "heals",
      "healing",
      "cure",
      "cures",
      "treat",
      "treats",
      "anti-inflammatory",
      "antibacterial",
      "antiseptic",
      "antifungal"
    ],
    try: [
      "softens, smooths, conditions",
      "pampers and comforts -- what it feels like, not what it fixes"
    ]
  },
  {
    when: [
      "repel",
      "repels",
      "repellent",
      "mosquito",
      "mosquitoes",
      "tick",
      "ticks",
      "bites",
      "bug spray",
      "buzz off"
    ],
    try: [
      "a porch mist for evenings outside",
      "an outdoor mist -- lean on the scent, promise nothing about the bugs"
    ]
  },
  {
    when: [
      "natural",
      "all natural",
      "chemical-free",
      "non-toxic",
      "preservative-free",
      "hypoallergenic",
      "dermatologist tested",
      "organic",
      "safe"
    ],
    try: [
      "simple ingredients you can pronounce",
      "plant oils and butters, mixed in small batches -- then list them"
    ]
  },
  {
    when: ["itch", "itchy", "calms", "soothe", "soothes"],
    try: ["tames the scratch", "conditions the skin underneath"]
  }
];

/** Ranked worst-first. Nothing outside this list is a valid severity. */
const SEVERITY_ORDER = ["definite", "likely", "possible"];

function severityRank(value) {
  const i = SEVERITY_ORDER.indexOf(String(value));
  return i === -1 ? SEVERITY_ORDER.length : i;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ---------------------------------------------------------------
   The overlay merge.
   --------------------------------------------------------------- */

function normalizeTerm(entry, category) {
  if (typeof entry === "string") return { term: entry, reason: category.defaultReason };
  if (!entry || typeof entry.term !== "string" || !entry.term.trim()) {
    throw new Error("A claim term needs a non-empty `term` string");
  }
  return {
    term: entry.term,
    reason: entry.reason || category.defaultReason,
    severity: entry.severity || undefined
  };
}

/**
 * CLAIM_TABLE with an optional JSON overlay applied.
 *
 * @param {{overlay: (Object|undefined), overlayPath: (string|undefined),
 *          env: (Object|undefined), readFile: (Function|undefined)}=} options
 * @return {!Object} a deep copy; the module constant is never mutated.
 */
function loadTable(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const base = {
    categories: CLAIM_TABLE.categories.map(function (c) {
      return {
        id: c.id,
        label: c.label,
        citation: c.citation,
        severity: c.severity,
        defaultReason: c.defaultReason,
        terms: c.terms.map(function (t) {
          return normalizeTerm(t, c);
        })
      };
    }),
    rewordings: REWORDINGS.map(function (r) {
      return { when: r.when.slice(), try: r.try.slice() };
    })
  };

  let overlay = opts.overlay || null;
  const overlayPath = opts.overlayPath || env.COPY_CLAIMS_TABLE || null;
  if (!overlay && overlayPath) {
    const read = opts.readFile || require("fs").readFileSync;
    overlay = JSON.parse(read(overlayPath, "utf8"));
  }
  if (!overlay) return base;

  Object.keys(overlay.categories || {}).forEach(function (id) {
    const target = base.categories.filter(function (c) {
      return c.id === id;
    })[0];
    if (!target) {
      /* A typo in a research brief must not silently disable a rule. */
      throw new Error(
        "Claims overlay names unknown category " +
          JSON.stringify(id) +
          " -- known ids are " +
          base.categories
            .map(function (c) {
              return c.id;
            })
            .join(", ")
      );
    }
    const patch = overlay.categories[id] || {};
    const removed = (patch.remove || []).map(function (t) {
      return String(t).toLowerCase();
    });
    target.terms = target.terms
      .filter(function (t) {
        return removed.indexOf(t.term.toLowerCase()) === -1;
      })
      .concat(
        (patch.add || []).map(function (t) {
          return normalizeTerm(t, target);
        })
      );
  });
  (overlay.rewordings || []).forEach(function (r) {
    base.rewordings.push({ when: (r.when || []).slice(), try: (r.try || []).slice() });
  });
  return base;
}

/** Every term in the table, flattened, longest first so phrases win. */
function flattenTerms(table) {
  const out = [];
  (table.categories || []).forEach(function (category) {
    category.terms.forEach(function (t) {
      out.push({
        term: t.term,
        lower: t.term.toLowerCase(),
        reason: t.reason || category.defaultReason,
        severity: t.severity || category.severity,
        category: category.id,
        categoryLabel: category.label,
        citation: category.citation
      });
    });
  });
  return out.sort(function (a, b) {
    return b.lower.length - a.lower.length;
  });
}

/* ---------------------------------------------------------------
   The allowlist: phrases that are the owner's decision, not a finding.
   --------------------------------------------------------------- */

/**
 * The pending-decision phrases as they read in the live catalogue right now.
 *
 * @param {Object} productsDoc parsed assets/data/products.json.
 * @return {!Array<{id, productId, field, phrase, why, citation, suggested}>}
 */
function buildAllowlist(productsDoc) {
  const products = (productsDoc && productsDoc.products) || [];
  const byId = {};
  products.forEach(function (p) {
    if (p && p.id) byId[p.id] = p;
  });
  return PENDING_DECISIONS.map(function (entry) {
    const product = byId[entry.productId];
    const phrase = product && typeof product[entry.field] === "string" ? product[entry.field] : "";
    if (!phrase.trim()) return null;
    return {
      id: entry.id,
      productId: entry.productId,
      field: entry.field,
      phrase: phrase,
      why: entry.why,
      citation: entry.citation,
      suggested: entry.suggested.slice()
    };
  }).filter(Boolean);
}

/**
 * Blank out every allowlisted phrase in `text`, so a product NAME cannot
 * license a finding the way it cannot license a translation in
 * scripts/lib/i18n-claims-rules.js. Replacement is spaces, not removal, so
 * every surviving index still points at the original string.
 *
 * @return {{masked: string, hits: !Array<string>}} hits are allowlist ids.
 */
function maskAllowlisted(text, allowlist) {
  let masked = String(text);
  const hits = [];
  (allowlist || [])
    .slice()
    .sort(function (a, b) {
      return b.phrase.length - a.phrase.length;
    })
    .forEach(function (entry) {
      const needle = entry.phrase;
      if (!needle) return;
      let index = masked.toLowerCase().indexOf(needle.toLowerCase());
      let seen = false;
      while (index !== -1) {
        seen = true;
        masked =
          masked.slice(0, index) + " ".repeat(needle.length) + masked.slice(index + needle.length);
        index = masked.toLowerCase().indexOf(needle.toLowerCase());
      }
      if (seen) hits.push(entry.id);
    });
  return { masked: masked, hits: hits };
}

/* ---------------------------------------------------------------
   Matching.
   --------------------------------------------------------------- */

/**
 * The sentence around a match, so a finding quotes something a person can
 * recognise rather than a word. Short fields (a name, a tag) are quoted whole.
 */
function sentenceAround(text, index, length) {
  const value = String(text);
  if (value.length <= 140) return value.trim();
  let start = 0;
  let end = value.length;
  const before = value.slice(0, index);
  const boundary = before.search(/[.!?\n][^.!?\n]*$/);
  if (boundary !== -1) start = boundary + 1;
  const after = value.slice(index + length);
  const stop = after.search(/[.!?\n]/);
  if (stop !== -1) end = index + length + stop + 1;
  return value.slice(start, end).trim();
}

/**
 * Every hard term in one string that the allowlist does not cover.
 *
 * Overlapping matches collapse to the longest term: "all natural" reports
 * once, not twice, because the matched span is consumed.
 *
 * @param {string} text
 * @param {{terms: !Array, allowlist: (Array|undefined),
 *          isReview: (boolean|undefined)}} options
 * @return {{matches: !Array, pendingHits: !Array<string>}}
 */
function scanText(text, options) {
  const opts = options || {};
  const masked = maskAllowlisted(text, opts.allowlist);
  let haystack = masked.masked;
  const matches = [];
  (opts.terms || []).forEach(function (rule) {
    const re = new RegExp("\\b" + escapeRegExp(rule.lower) + "\\b", "gi");
    let m;
    const spans = [];
    while ((m = re.exec(haystack)) !== null) {
      spans.push({ index: m.index, length: m[0].length });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    if (!spans.length) return;
    /* Consume the span so a shorter term cannot report the same words. */
    spans.forEach(function (span) {
      haystack =
        haystack.slice(0, span.index) +
        " ".repeat(span.length) +
        haystack.slice(span.index + span.length);
    });
    const span = spans[0];
    matches.push({
      term: rule.term,
      category: opts.isReview ? TESTIMONIAL_CATEGORY.id : rule.category,
      categoryLabel: opts.isReview ? TESTIMONIAL_CATEGORY.label : rule.categoryLabel,
      citation: opts.isReview ? TESTIMONIAL_CATEGORY.citation : rule.citation,
      ruleCategory: rule.category,
      severity: rule.severity || "definite",
      reason: rule.reason,
      occurrences: spans.length,
      quote: sentenceAround(text, span.index, span.length)
    });
  });
  return { matches: matches, pendingHits: masked.hits };
}

/**
 * Up to two rewordings for a term. Falls back to the category's own pattern so
 * a term a research brief adds is never left without a suggestion.
 */
function suggestionsFor(term, categoryId, table) {
  const t = String(term || "").toLowerCase();
  const rewordings = (table && table.rewordings) || REWORDINGS;
  const direct = rewordings.filter(function (r) {
    return r.when.some(function (w) {
      return String(w).toLowerCase() === t;
    });
  })[0];
  if (direct) return direct.try.slice(0, 2);
  const fallback = {
    drug: ["softens, smooths, conditions", "say how it feels, not what it does to a condition"],
    pesticide: ["a porch mist for evenings outside", "lean on the scent, promise nothing"],
    marketing: [
      "simple ingredients you can pronounce",
      "name the ingredients instead of the promise"
    ],
    testimonial: [
      "leave this one on Etsy",
      "move it to the reviews page under the disclosure rather than onto the product"
    ]
  };
  return (fallback[categoryId] || []).slice(0, 2);
}

/**
 * The rule table rendered for a model prompt, generated rather than retyped so
 * the instruction the model gets and the table that judges it cannot drift --
 * the same discipline as claimPromptFragment() in i18n-claims-rules.js.
 */
function promptRules(table) {
  return (table.categories || [])
    .map(function (c) {
      return (
        c.label +
        " [" +
        c.id +
        ", " +
        c.citation +
        "]:\n  " +
        c.terms
          .map(function (t) {
            return t.term;
          })
          .join(", ")
      );
    })
    .join("\n");
}

module.exports = {
  CLAIM_TABLE: CLAIM_TABLE,
  TESTIMONIAL_CATEGORY: TESTIMONIAL_CATEGORY,
  PENDING_DECISIONS: PENDING_DECISIONS,
  REWORDINGS: REWORDINGS,
  SEVERITY_ORDER: SEVERITY_ORDER,
  severityRank: severityRank,
  loadTable: loadTable,
  flattenTerms: flattenTerms,
  buildAllowlist: buildAllowlist,
  maskAllowlisted: maskAllowlisted,
  sentenceAround: sentenceAround,
  scanText: scanText,
  suggestionsFor: suggestionsFor,
  promptRules: promptRules
};

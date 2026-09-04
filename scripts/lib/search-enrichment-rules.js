/**
 * @fileoverview The word policy for bot-generated SEARCH vocabulary, as data.
 *
 * scripts/search-enrich.js asks a model for the words a shopper types that the
 * owner would never think to write down -- "that bug stuff", "stocking
 * stuffer", "post hike", ingredient names, misspellings -- and then throws away
 * everything the policy below refuses. This file is the policy. It is DATA on
 * purpose: a legal brief on exactly this line is in progress, and updating it
 * must be an edit to an array, not a patch to a filter.
 *
 * THE SURFACES, AND WHY THEY ARE NOT SYMMETRIC. There are three different
 * places a search word can land, and they carry different risk:
 *
 *   PRODUCT SIDE -- `keywords`, which are PUBLISHED with the product in
 *   assets/js/search-data.js. They ship to every visitor, they are readable in
 *   the source of the page, and a regulator reading them is reading our
 *   marketing. FDA reads intended use off "the label, the website and
 *   advertising"; a product name alone has been cited as evidence in warning
 *   letters. So the product side gets the FULL list: every treatment, symptom,
 *   condition, pesticide-claim and unsubstantiated-"natural" word from the
 *   2026-09-01 compliance review.
 *
 *   QUERY SIDE -- `querySynonyms`, which are merged into the same table
 *   content.json's `search.extraSynonyms` feeds. They only ever rewrite what
 *   the SHOPPER typed before matching, and are never rendered anywhere. What
 *   makes them defensible is NOT that they "live in the code" -- metatags live
 *   in the code and FDA cites them routinely, and the CJEU has held that
 *   invisibility to the shopper is "irrelevant" (C-657/11 para 58). It is that
 *   a synonym table supplements and explains the SHOPPER, not the article:
 *   under Kordel v. United States, 335 U.S. 345, 348-351, the test is textual
 *   and functional, and this table makes no representation about any product.
 *   So the query side gets a much smaller list -- and LAY symptom and sensory
 *   vocabulary ("itchy skin", "dry patches", "sore feet", "can't sleep") is
 *   explicitly ALLOWED there, because that is what shoppers actually type.
 *
 *   ROUTER -- `MEDICAL_QUERY_TERMS`, added 2026-09-04. Named diseases and
 *   treatment/structure-function words are NOT synonyms for anything: they map
 *   to NO product. They are recognised so the site can answer with a fixed
 *   non-claim note and a cosmetically-named shelf, which is an affirmative
 *   denial of intended use rather than evidence of one. See the note on that
 *   array below for the constraint that keeps it lawful.
 *
 * WHAT THE BUILD ENFORCES. scripts/build-site-data.js keeps
 * SEARCH_SYNONYM_BANNED and THROWS on any query-side term containing one of
 * those words. It is imported here rather than copied, because a policy that
 * disagreed with the gate would produce a bot whose output fails the deploy.
 *
 * The TODO that used to sit here proposed releasing "wound", "infection" and
 * "psoriasis" onto the query side to match the build. The legal brief of
 * 2026-09-04 closed it the OTHER way (brief section 7(b)): SEARCH_SYNONYM_BANNED
 * stays exactly as it is, and those three words moved into MEDICAL_QUERY_TERMS
 * instead -- together with "eczema" and "insomnia", which this policy used to
 * allow on the query side while the build refused "psoriasis", an asymmetry
 * with no principle behind it. QUERY_SIDE_BLOCKED_BY_BUILD_ONLY is still
 * computed rather than typed, and is now empty; its test asserts that.
 *
 * NOTHING IN THIS FILE JUDGES THE OWNER'S OWN WORDS. products.json is hers.
 * Her `keywords` are never filtered, never rewritten and never removed; this
 * policy applies only to words a bot proposes.
 */

"use strict";

/* The gate the deploy actually runs. Imported, never re-typed: see the header.
   Requiring the build script is free -- it only executes when run directly. */
const { SEARCH_SYNONYM_BANNED } = require("../build-site-data.js");

/** Bumped when a list below changes, so a regenerated entry is explainable. */
const POLICY_VERSION = "2026-09-04";

/* ---------------------------------------------------------------------------
   QUERY SIDE. Small by design. Each of these would read as us calling a
   product a medicine even in metadata nobody sees rendered.
   --------------------------------------------------------------------------- */
const QUERY_SIDE_BANNED = [
  { term: "cure", why: "asserts a medical outcome" },
  { term: "cures", why: "asserts a medical outcome" },
  { term: "treat", why: "a drug verb; 'intended to treat' is the statutory line" },
  { term: "treats", why: "a drug verb" },
  { term: "treatment", why: "a drug noun" },
  { term: "prescription", why: "asserts a regulated dispensing category" },
  { term: "medicine", why: "asserts the product is a medicine" },
  { term: "medical", why: "asserts a medical category" },
  { term: "diagnose", why: "diagnosis is a drug/device intended use" },
  { term: "fda approved", why: "a cosmetic is never FDA-approved; the phrase is false on its face" }
];

/* LAY symptom, sensory and pest words that ARE allowed on the query side, and
   the concern vocabulary each is meant to route to. This list is not consulted
   as an allow-list by the filter -- the filter allows anything the banned lists
   do not name -- it exists so the intent is written down, so the prompt can
   show the model what good looks like, and so scripts/search-enrich.test.js can
   pin the asymmetry ("itchy skin" is a legal synonym and an illegal keyword).

   What is NOT here any more: eczema, psoriasis, insomnia, wound, infection and
   pain. A named disease and a structure-function word are router business now
   (MEDICAL_QUERY_TERMS below); brief section 7(b) and the matrix in 7(g).
   "rash" and "itch" stay, because they are what a person says about their own
   skin rather than a diagnosis, and they carry real traffic. */
const QUERY_SIDE_ALLOWED = [
  { term: "itchy skin", routesTo: "dry-skin" },
  { term: "itch", routesTo: "dry-skin" },
  { term: "rash", routesTo: "dry-skin" },
  { term: "dry patches", routesTo: "dry-skin" },
  { term: "flaky", routesTo: "dry-skin" },
  { term: "rough hands", routesTo: "dry-skin" },
  { term: "sore feet", routesTo: "sore-muscles" },
  { term: "sore legs", routesTo: "sore-muscles" },
  { term: "tired legs", routesTo: "sore-muscles" },
  { term: "sore muscles", routesTo: "sore-muscles" },
  { term: "can't sleep", routesTo: "sleep-relaxation" },
  { term: "bites", routesTo: "outdoor-defense" },
  { term: "mosquito", routesTo: "outdoor-defense" }
];

/* ---------------------------------------------------------------------------
   THE ROUTER (surface 4). Named diseases and treatment / structure-function
   words. Every one of these maps to NO PRODUCT: the client recognises the word,
   strips it out of the matching query, and renders a fixed note saying we make
   comfort products and not medicines, above whatever the shopper's remaining
   ordinary words found on their own. That output is an explicit DENIAL of
   intended use -- evidence for the seller under 21 CFR 201.128, not against.

   That is also why this list is exempt from SEARCH_SYNONYM_BANNED: the gate
   exists to stop a word being wired to a product, and nothing here is wired to
   a product.

   THE ONE CONSTRAINT THAT MATTERS (brief section 7(c)(5), the strongest
   sentence in the brief): this list must NEVER be rendered as a browsable list,
   a chip row, a "popular searches" module, a suggestion dropdown, a sitemap
   entry or a static page. The moment the site PRESENTS these conditions rather
   than RECOGNISING them, it becomes MHRA Appendix 9's "lists of adverse medical
   conditions which take a consumer to a page displaying a product". It is
   sourced from this file and never from content.json for exactly that reason:
   the CMS must not be able to grow it into a feature.

   `why` is the reason the word is here; `brief` is the section that put it
   there. Sections cited are of the 2026-09-04 research brief. */
const MEDICAL_QUERY_TERMS = [
  {
    term: "eczema",
    why: "named disease; 21 CFR 347 reserves the indication to colloidal oatmeal",
    brief: "7(b), 7(g)"
  },
  {
    term: "psoriasis",
    why: "named disease; 21 CFR 358 subpart H reserves it to coal tar / salicylic acid",
    brief: "7(b), 7(g)"
  },
  { term: "dermatitis", why: "named disease; 21 CFR 358 subpart H", brief: "7(g)" },
  { term: "rosacea", why: "named disease, with no OTC monograph in existence", brief: "7(g)" },
  { term: "acne", why: "named disease; 21 CFR 333 subpart D", brief: "7(g)" },
  {
    term: "insomnia",
    why: "named disease; FDA's aromatherapy guidance reads sleep claims as drug claims",
    brief: "7(b), 7(g)"
  },
  {
    term: "anxiety",
    why: 'disease/structure-function; FDA quoted a product\'s "Tags: anxiety" as a claim',
    brief: "7(g)"
  },
  { term: "migraine", why: "named disease", brief: "7(g)" },
  {
    term: "arthritis",
    why: "named disease; FTC took a civil penalty on this exact word (Gravity Defyer)",
    brief: "7(g)"
  },
  {
    term: "wound",
    why: "21 USC 321(g)(1)(B); wound care is a 21 CFR 347 skin-protectant indication",
    brief: "7(b), 7(g)"
  },
  {
    term: "infection",
    why: "disease; antimicrobial territory, and on Amazon's disease list",
    brief: "7(b), 7(g)"
  },
  { term: "pain", why: "an external-analgesic drug indication", brief: "7(g)" },
  { term: "inflammation", why: "structure-function claim", brief: "7(g)" },
  { term: "anti-inflammatory", why: "a drug claim on its face", brief: "7(g)" },
  {
    term: "antibacterial",
    why: "drug or pesticide claim; on Amazon's disease list",
    brief: "7(g)"
  },
  { term: "antiseptic", why: "drug claim", brief: "7(g)" },
  { term: "antifungal", why: "drug claim; on Amazon's disease list", brief: "7(g)" },
  {
    term: "heal",
    why: "21 USC 321(g)(1)(B) concept, in the statute's own vocabulary",
    brief: "7(g)"
  },
  { term: "healing", why: "same as heal", brief: "7(g)" },
  { term: "cure", why: "statutory verb, 21 USC 321(g)(1)(B)", brief: "7(b), 7(g)" },
  { term: "cures", why: "statutory verb", brief: "7(b), 7(g)" },
  {
    term: "treat",
    why: 'statutory verb; "intended to treat" is the line itself',
    brief: "7(b), 7(g)"
  },
  { term: "treats", why: "statutory verb", brief: "7(b), 7(g)" },
  { term: "treatment", why: "statutory noun", brief: "7(b), 7(g)" },
  { term: "relief", why: "a 21 CFR 347 / 358 monograph verb", brief: "7(g)" },
  { term: "relieve", why: "monograph verb", brief: "7(g)" },
  { term: "relieves", why: "monograph verb", brief: "7(g)" },
  { term: "diagnose", why: "diagnosis is a drug/device intended use", brief: "7(b), 7(g)" },
  { term: "prescription", why: "asserts a regulated dispensing category", brief: "7(b), 7(g)" },
  { term: "medicine", why: "positions the product as a medicine", brief: "7(b), 7(g)" },
  { term: "medical", why: "asserts a medical category", brief: "7(b), 7(g)" },
  {
    term: "repel",
    why: "7 USC 136(u): a repellency claim makes the article a pesticide",
    brief: "7(g)"
  },
  {
    term: "repellent",
    why: '7 USC 136(u); 40 CFR 152.15 reaches claims made "by labeling or otherwise"',
    brief: "7(g)"
  }
];

/**
 * The router's words as a plain array of strings, in declaration order.
 *
 * This is what scripts/build-site-data.js emits into the search index bundle,
 * and it is deliberately the only shape that leaves this file: the client needs
 * to RECOGNISE these words, and it needs nothing else -- no reasons, no
 * citations, and above all no product ids. A list with no destinations attached
 * cannot become a browsable index of conditions by accident.
 *
 * @return {!Array<string>}
 */
function medicalQueryTermList() {
  return MEDICAL_QUERY_TERMS.map(function (entry) {
    return entry.term;
  });
}

/* ---------------------------------------------------------------------------
   PRODUCT SIDE. The full list, grouped by the reason it is on it. Every group
   traces to the 2026-09-01 compliance review sent to the owner.
   --------------------------------------------------------------------------- */

/** Drug verbs and nouns: intended use is read off these directly. */
const TREATMENT_WORDS = [
  "heal",
  "heals",
  "healed",
  "healing",
  "cure",
  "cures",
  "cured",
  "curing",
  "treat",
  "treats",
  "treated",
  "treating",
  "treatment",
  "remedy",
  "remedies",
  "relief",
  "relieve",
  "relieves",
  "relieved",
  "relieving",
  "soothe",
  "soothes",
  "soothed",
  "soothing",
  "calm",
  "calms",
  "calmed",
  "calming",
  "medicine",
  "medical",
  "medicinal",
  "therapeutic",
  "therapy",
  "prescription",
  "diagnose",
  "analgesic",
  "antibacterial",
  "antimicrobial",
  "antifungal",
  "antiseptic",
  "antibiotic",
  "anti-inflammatory",
  "anti inflammatory",
  "detox",
  "detoxify",
  "toxins",
  "immune",
  "immunity",
  "hormone",
  "hormonal",
  "recovery",
  "restorative"
];

/** Conditions and symptoms. Legal to type, illegal to publish next to a salve. */
const CONDITION_WORDS = [
  "eczema",
  "psoriasis",
  "dermatitis",
  "rosacea",
  "acne",
  "rash",
  "rashes",
  "hives",
  "insomnia",
  "anxiety",
  "anxious",
  "depression",
  "stress",
  "arthritis",
  "arthritic",
  "migraine",
  "migraines",
  "headache",
  "headaches",
  "cramps",
  "menopause",
  "fibromyalgia",
  "neuropathy",
  "diabetes",
  "inflammation",
  "inflamed",
  "swelling",
  "bruise",
  "bruises",
  "bruising",
  "sprain",
  "strain",
  "pain",
  "painful",
  "ache",
  "aches",
  "aching",
  "sore",
  "soreness",
  "sore muscles",
  "muscle pain",
  "joint pain",
  "itch",
  "itchy",
  "itching",
  "wound",
  "wounds",
  "infection",
  "infected",
  "fungus",
  "fungal",
  "dandruff",
  "sunburn",
  "burn",
  "burns",
  "razor burn",
  "scar",
  "scars",
  "stretch marks",
  "cellulite",
  "insomniac",
  "sleep aid",
  "helps you sleep"
];

/* Pesticide claims. The bug spray is the review's one live compliance problem:
   a repellent claim makes it a pesticide under FIFRA, and the formula very
   likely fails the 25(b) minimum-risk exemption. The owner's own keywords still
   carry some of these words -- that is her decision to make on her own copy;
   the bot must not add more. */
const PESTICIDE_WORDS = [
  "repel",
  "repels",
  "repellent",
  "repellant",
  "insect repellent",
  "bug repellent",
  "mosquito",
  "mosquitos",
  "mosquitoes",
  "tick",
  "ticks",
  "bite",
  "bites",
  "bug bites",
  "pesticide",
  "insecticide",
  "deet",
  "buzz off"
];

/* Substantiation claims. "Natural" beside a synthetic preservative is an FTC
   problem (2016 consent orders), "organic" needs USDA certification, and the
   rest are claims nobody here has tested. */
const SUBSTANTIATION_WORDS = [
  "natural",
  "naturally",
  "all natural",
  "all-natural",
  "organic",
  "chemical free",
  "chemical-free",
  "non-toxic",
  "non toxic",
  "nontoxic",
  "preservative free",
  "preservative-free",
  "hypoallergenic",
  "dermatologist tested",
  "dermatologist recommended",
  "doctor recommended",
  "clinically proven",
  "clinically tested",
  "fda approved",
  "pharmaceutical",
  "pharmaceutical grade"
];

/**
 * The whole product-side list, flattened with the reason each group is on it.
 * Order is stable so a drop reason reads the same run to run.
 */
const PRODUCT_SIDE_BANNED = []
  .concat(
    TREATMENT_WORDS.map(function (t) {
      return { term: t, why: "reads as a treatment claim" };
    })
  )
  .concat(
    CONDITION_WORDS.map(function (t) {
      return { term: t, why: "is a symptom or condition; it belongs on the query side only" };
    })
  )
  .concat(
    PESTICIDE_WORDS.map(function (t) {
      return { term: t, why: "is a pesticide/repellent claim (FIFRA)" };
    })
  )
  .concat(
    SUBSTANTIATION_WORDS.map(function (t) {
      return { term: t, why: "is an unsubstantiated marketing claim" };
    })
  );

/* Other people's brands. Ranking our salve for "burt's bees" is a trademark
   question we have no reason to open, and the words describe nothing we sell. */
const COMPETITOR_BRANDS = [
  "burts bees",
  "burt's bees",
  "bath and body works",
  "bath & body works",
  "lush",
  "aveeno",
  "eucerin",
  "cerave",
  "cetaphil",
  "aquaphor",
  "neutrogena",
  "la roche posay",
  "dr bronner",
  "dr. bronner",
  "badger balm",
  "tiger balm",
  "bengay",
  "icy hot",
  "vicks",
  "gold bond",
  "okeeffes",
  "o'keeffe's",
  "nivea",
  "olay",
  "dove",
  "sol de janeiro",
  "glossier",
  "thayers",
  "earth mama",
  "honest company",
  "weleda",
  "doterra",
  "young living",
  "herbivore",
  "kiehls",
  "kiehl's",
  "tubby todd",
  "native deodorant",
  "lume"
];

/* The rewording vocabulary the compliance review handed the owner. Fed to the
   prompt as the preferred product-side register, so the model reaches for
   "tired legs" before it reaches for "sore muscles" and the filter has less to
   do. Not enforced -- a filter cannot check taste. */
const PREFERRED_VOCABULARY = [
  {
    insteadOf: "sore muscles, joint ache, arthritis, stiffness",
    prefer: "tired legs, hardworking hands, worked-hard joints, the ache of a long day"
  },
  { insteadOf: "eczema, rashes, skin recovery", prefer: "rough dry patches, thirsty skin" },
  {
    insteadOf: "insomnia, anxiety, helps you sleep",
    prefer: "wind-down ritual, built for night owls, bedtime"
  },
  {
    insteadOf: "heals, soothes, relieves",
    prefer: "softens, smooths, conditions, pampers, comforts"
  },
  { insteadOf: "repels mosquitoes, bug bites", prefer: "porch nights, trail days, outdoor mist" },
  {
    insteadOf: "natural, organic",
    prefer: "small-batch, hand-poured, Appalachian, made in Landrum"
  }
];

/** Caps. A model asked for 40 keywords writes 40 bad ones. */
const LIMITS = {
  maxKeywords: 12,
  maxSynonymEntries: 6,
  maxSynonymTerms: 8,
  maxTermChars: 40
};

/* ---------------------------------------------------------------------------
   Matching. Everything below is mechanism; the policy is the arrays above.
   --------------------------------------------------------------------------- */

/** Lowercase, collapse whitespace, trim. The single normal form. */
function normalizeTerm(value) {
  return String(value === undefined || value === null ? "" : value)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The key normalisation buildSearchSynonyms() applies, reproduced exactly so a
 * key this file accepts is the key the build will store. Kept as its own
 * function, and pinned against the build in the test suite.
 */
function normalizeSynonymKey(value) {
  return String(value === undefined || value === null ? "" : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, "")
    .replace(/\s+/g, "_");
}

/** A term's words, punctuation stripped. "post-hike" -> ["post", "hike"]. */
function wordsOf(term) {
  return normalizeTerm(term)
    .split(/[^a-z0-9']+/)
    .filter(Boolean);
}

/** True when `phrase` (one or more words) occurs as whole words inside `term`. */
function containsPhrase(term, phrase) {
  const words = wordsOf(term);
  const needle = wordsOf(phrase);
  if (!needle.length || needle.length > words.length) return false;
  for (let i = 0; i + needle.length <= words.length; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) {
      if (words[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/** First entry of `list` that `term` contains, or null. Entries: string or {term, why}. */
function firstHit(term, list) {
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    const word = typeof entry === "string" ? entry : entry.term;
    if (containsPhrase(term, word)) {
      return { term: word, why: typeof entry === "string" ? "" : entry.why || "" };
    }
  }
  return null;
}

/**
 * The words the BUILD refuses on the query side that this policy does not
 * refuse itself. Computed, never typed, so it cannot go stale. It was
 * ["wound", "infection", "psoriasis"] until the 2026-09-04 brief; those three
 * are now in MEDICAL_QUERY_TERMS, so the policy and the gate agree and this is
 * EMPTY. Keeping the computation (rather than deleting it) is what makes a
 * future divergence -- someone adding a word to SEARCH_SYNONYM_BANNED and
 * nowhere else -- show up in a test instead of in a failed deploy.
 */
const QUERY_SIDE_BLOCKED_BY_BUILD_ONLY = SEARCH_SYNONYM_BANNED.filter(function (word) {
  const banned = QUERY_SIDE_BANNED.some(function (entry) {
    return entry.term === word;
  });
  const routed = MEDICAL_QUERY_TERMS.some(function (entry) {
    return entry.term === word;
  });
  return !banned && !routed;
});

/** Router rejection: not a synonym for anything, because it maps to no product. */
function medicalQueryHit(term) {
  const hit = firstHit(term, MEDICAL_QUERY_TERMS);
  if (!hit) return null;
  return {
    term: hit.term,
    why:
      hit.why +
      " -- it is a medicalQueryTerms word, handled by the router that maps to no product, " +
      "and is never a synonym"
  };
}

/** Query-side rejection = policy list + the router + whatever the build enforces. */
function querySideHit(term) {
  const policy = firstHit(term, QUERY_SIDE_BANNED);
  if (policy) return policy;
  const routed = medicalQueryHit(term);
  if (routed) return routed;
  const build = firstHit(term, QUERY_SIDE_BLOCKED_BY_BUILD_ONLY);
  if (build) {
    return {
      term: build.term,
      why:
        "is refused by build-site-data.js SEARCH_SYNONYM_BANNED and is named by no list in " +
        "search-enrichment-rules.js -- add it to QUERY_SIDE_BANNED or MEDICAL_QUERY_TERMS"
    };
  }
  return null;
}

/** Product-side rejection = the full list, plus everything the query side refuses. */
function productSideHit(term) {
  return firstHit(term, PRODUCT_SIDE_BANNED) || querySideHit(term);
}

function competitorHit(term) {
  return firstHit(term, COMPETITOR_BRANDS);
}

/** Characters a search word may contain once normalised. Anything else is noise. */
const ALLOWED_CHARS = /^[a-z0-9 '&+.-]+$/;

/**
 * Screen one proposed PRODUCT-SIDE keyword.
 *
 * @param {{term: *, ownerKeywords: (!Array<string>|undefined),
 *          nameTokens: (!Array<string>|undefined), taken: (!Set|undefined)}} input
 * @return {{ok: boolean, value: (string|undefined), reason: (string|undefined)}}
 */
function screenKeyword(input) {
  const raw = input.term;
  if (typeof raw !== "string") return { ok: false, reason: "not a string" };
  const term = normalizeTerm(raw);
  if (!term) return { ok: false, reason: "empty after trimming" };
  if (term.length > LIMITS.maxTermChars) {
    return {
      ok: false,
      reason: "is " + term.length + " characters, over the " + LIMITS.maxTermChars + "-char cap"
    };
  }
  if (!ALLOWED_CHARS.test(term)) {
    return { ok: false, reason: "contains characters a search word should not have" };
  }
  const banned = productSideHit(term);
  if (banned) {
    return { ok: false, reason: 'contains "' + banned.term + '", which ' + banned.why };
  }
  const brand = competitorHit(term);
  if (brand) return { ok: false, reason: 'names another brand ("' + brand.term + '")' };

  const owner = (input.ownerKeywords || []).map(normalizeTerm);
  if (owner.indexOf(term) !== -1) {
    return { ok: false, reason: "duplicates a keyword the owner already wrote" };
  }
  const nameTokens = (input.nameTokens || []).map(normalizeTerm);
  if (nameTokens.indexOf(term) !== -1) {
    return { ok: false, reason: "is already a word in the product's own name" };
  }
  if (input.taken && input.taken.has(term)) {
    return { ok: false, reason: "duplicates another keyword in the same batch" };
  }
  return { ok: true, value: term };
}

/**
 * Screen one proposed QUERY-SIDE synonym entry. Terms are screened one at a
 * time so a single bad word costs one word, not the entry -- an entry left with
 * no surviving term is then dropped, because buildSearchSynonyms() throws on
 * an empty `terms`.
 *
 * @param {{entry: *, taken: (!Set|undefined)}} input
 * @return {{ok: boolean, value: (!Object|undefined), reason: (string|undefined),
 *           dropped: !Array<{item: string, reason: string}>}}
 */
function screenSynonymEntry(input) {
  const dropped = [];
  const entry = input.entry;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { ok: false, reason: "is not a { key, terms } object", dropped: dropped };
  }
  const key = normalizeSynonymKey(entry.key);
  if (!key) return { ok: false, reason: "has an empty key", dropped: dropped };
  const keyBan = querySideHit(key.replace(/_/g, " "));
  if (keyBan) {
    return {
      ok: false,
      reason: 'key contains "' + keyBan.term + '", which ' + keyBan.why,
      dropped: dropped
    };
  }
  if (input.taken && input.taken.has(key)) {
    return {
      ok: false,
      reason: "repeats a synonym key already used in this batch",
      dropped: dropped
    };
  }

  const rawTerms = Array.isArray(entry.terms) ? entry.terms : [];
  const seen = new Set();
  const terms = [];
  rawTerms.forEach(function (raw) {
    if (terms.length >= LIMITS.maxSynonymTerms) {
      dropped.push({
        item: String(raw),
        reason: "over the " + LIMITS.maxSynonymTerms + "-term cap"
      });
      return;
    }
    if (typeof raw !== "string") {
      dropped.push({ item: JSON.stringify(raw), reason: "not a string" });
      return;
    }
    const term = normalizeTerm(raw);
    if (!term) {
      dropped.push({ item: raw, reason: "empty after trimming" });
      return;
    }
    if (term.length > LIMITS.maxTermChars) {
      dropped.push({
        item: term,
        reason: "is " + term.length + " characters, over the " + LIMITS.maxTermChars + "-char cap"
      });
      return;
    }
    if (!ALLOWED_CHARS.test(term)) {
      dropped.push({ item: term, reason: "contains characters a search word should not have" });
      return;
    }
    const banned = querySideHit(term);
    if (banned) {
      dropped.push({ item: term, reason: 'contains "' + banned.term + '", which ' + banned.why });
      return;
    }
    const brand = competitorHit(term);
    if (brand) {
      dropped.push({ item: term, reason: 'names another brand ("' + brand.term + '")' });
      return;
    }
    if (seen.has(term)) {
      dropped.push({ item: term, reason: "repeats another term in the same entry" });
      return;
    }
    seen.add(term);
    terms.push(term);
  });

  if (!terms.length) {
    return { ok: false, reason: "has no term left after screening", dropped: dropped };
  }
  return { ok: true, value: { key: key, terms: terms }, dropped: dropped };
}

/**
 * The policy, rendered for the prompt. Generated from the arrays above so the
 * instruction the model gets and the filter that judges its answer cannot
 * drift -- the same reasoning as scripts/lib/i18n-claims-rules.js.
 */
function promptFragment() {
  const productWords = PRODUCT_SIDE_BANNED.map(function (e) {
    return e.term;
  });
  const queryWords = QUERY_SIDE_BANNED.map(function (e) {
    return e.term;
  }).concat(QUERY_SIDE_BLOCKED_BY_BUILD_ONLY);
  const routerWords = MEDICAL_QUERY_TERMS.map(function (e) {
    return e.term;
  });
  return [
    "TWO SURFACES, TWO RULES. This is a cosmetics shop, not a pharmacy.",
    "",
    "1. `keywords` are PUBLISHED with the product. Never use any of these words, in any form:",
    "   " + productWords.join(", "),
    "   Write uses, occasions, gift contexts, ingredient names, plain-language descriptors and",
    "   2-4 realistic misspellings of the product name or its ingredients. Prefer this register:",
    PREFERRED_VOCABULARY.map(function (p) {
      return "   - instead of " + p.insteadOf + " -> " + p.prefer;
    }).join("\n"),
    "",
    "2. `querySynonyms` only rewrite what a shopper TYPED and are never displayed, so the",
    "   LAY symptom and sensory words a shopper actually uses ARE wanted here -- " +
      QUERY_SIDE_ALLOWED.map(function (a) {
        return a.term;
      }).join(", ") +
      ".",
    "   Never use these, even here: " + queryWords.join(", ") + ".",
    "   Named diseases and treatment verbs are NOT synonyms -- do not propose them, here or",
    "   anywhere: " + routerWords.join(", ") + ".",
    "   They are handled by a router that maps them to NO product, so proposing one as a",
    "   synonym would wire a disease word to a salve, which is the one thing this must not do.",
    "   Map the shopper's language onto the product's own concern and category vocabulary."
  ].join("\n");
}

module.exports = {
  POLICY_VERSION: POLICY_VERSION,
  SEARCH_SYNONYM_BANNED: SEARCH_SYNONYM_BANNED,
  QUERY_SIDE_BANNED: QUERY_SIDE_BANNED,
  QUERY_SIDE_ALLOWED: QUERY_SIDE_ALLOWED,
  QUERY_SIDE_BLOCKED_BY_BUILD_ONLY: QUERY_SIDE_BLOCKED_BY_BUILD_ONLY,
  MEDICAL_QUERY_TERMS: MEDICAL_QUERY_TERMS,
  medicalQueryTermList: medicalQueryTermList,
  PRODUCT_SIDE_BANNED: PRODUCT_SIDE_BANNED,
  TREATMENT_WORDS: TREATMENT_WORDS,
  CONDITION_WORDS: CONDITION_WORDS,
  PESTICIDE_WORDS: PESTICIDE_WORDS,
  SUBSTANTIATION_WORDS: SUBSTANTIATION_WORDS,
  COMPETITOR_BRANDS: COMPETITOR_BRANDS,
  PREFERRED_VOCABULARY: PREFERRED_VOCABULARY,
  LIMITS: LIMITS,
  normalizeTerm: normalizeTerm,
  normalizeSynonymKey: normalizeSynonymKey,
  wordsOf: wordsOf,
  containsPhrase: containsPhrase,
  medicalQueryHit: medicalQueryHit,
  querySideHit: querySideHit,
  productSideHit: productSideHit,
  competitorHit: competitorHit,
  screenKeyword: screenKeyword,
  screenSynonymEntry: screenSynonymEntry,
  promptFragment: promptFragment
};

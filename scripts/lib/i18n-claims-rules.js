/**
 * @fileoverview The claims vocabulary, in ONE place.
 *
 * This table used to live inside scripts/i18n-claims.test.js. It now lives
 * here because two things need it and they must never disagree: the test,
 * which is the gate over the committed dictionaries, and
 * scripts/i18n-translate.js, which refuses a machine translation BEFORE it is
 * written. A prompt that told the model "do not say 舒缓" while the gate
 * banned a different word would be worse than no prompt at all -- the run
 * would look green and the drift would be somewhere else.
 *
 * WHAT IS BANNED, AND WHY. The 2026-09-01 audit found translation drift in one
 * direction: every error ADDED a claim the English does not make. A cosmetic
 * presented as a medicinal product is a regulatory problem under EU Reg.
 * 1223/2009 Art. 20; 安心 ("safe / peace of mind") is a regulated assertion for
 * cosmetics in Japan under 薬機法, where a safety guarantee is a violation even
 * when it is true; and China's 化妆品监督管理条例 Art. 43 forbids a medical
 * effect that is merely implied. Fluency is a matter of taste. These are not.
 *
 * SOURCE PARITY -- the part that is new, and why it is not a loosening.
 * The rule the gate is really enforcing is "exactly the claims the English
 * makes, no more and no fewer". The first version could only express half of
 * that: any occurrence of a banned word was an offence, whatever the English
 * said, with hand-keyed per-key exemptions as the escape hatch. That does not
 * survive contact with the live catalogue, which today says "calms the itch
 * underneath" (beard salve) and "buzz off, naturally" (bug spray). A faithful
 * fr/de/zh rendering of "calms" IS apaise/beruhigt/舒缓, and a faithful ja/zh
 * rendering of "naturally" IS 天然. Under the old rule the honest translation
 * was the one that failed, and the hand-keyed exemption list does not scale to
 * keys a bot mints.
 *
 * So each banned term is paired with the English trigger(s) that license it,
 * and the offence is skipped only when the key's own English contains one.
 * A claim the English does not make is still rejected in every locale -- which
 * is the whole point, and is exactly what caught Kräuterheilmittel and 安心.
 * Terms with an EMPTY trigger list can never be licensed by any English at
 * all: 安心 and 効能/疗效/功效 are assertions no English marketing sentence
 * entitles us to make in those markets.
 *
 * Two details that matter:
 *
 *   - Triggers are matched with word boundaries, and PROTECTED TERMS ARE
 *     STRIPPED FROM THE ENGLISH FIRST. Otherwise the product literally named
 *     "Y'all Heal Now Miracle Frankincense Salve" would license "heilend" in
 *     every blurb that names it, and "Bug Off B*tch Natural Bug Spray" would
 *     license 天然 everywhere. A brand name is a name, not a claim.
 *   - CLAIM_EXEMPT (by key, with a written reason) is kept as well as source
 *     parity, not replaced by it. pdp.notMedicine is exempt because its whole
 *     job is to deny the claims it names.
 *
 * Neither this file nor its callers decide anything about English copy. That
 * two live blurbs sit on the regulatory line is a question for the owner about
 * the ENGLISH storefront -- EU/JP/CN rules apply to it too.
 */

/** Banned, per locale. Matched case-insensitively; German compounds the word
    ("Kräuterheilmittel" is the exact form the audit found), so these are
    substrings rather than whole words. */
const CLAIM_WORDS = {
  es: ["remedio", "remedios", "curativ", "medicinal", "calmante", "terapéut", "sanador"],
  de: ["Heilmittel", "heilend", "lindert", "beruhigt", "medizinisch", "therapeutisch"],
  fr: ["remède", "remèdes", "guérit", "apaise", "apaisant", "soulage", "médicinal", "thérapeut"],
  ja: ["安心", "天然", "効能", "治療", "改善"],
  zh: ["安心", "天然", "疗效", "功效", "舒缓", "治疗"]
};

/* The English words that license each banned term, keyed by the banned term
   exactly as it appears above (lower-cased at match time). A term that is
   absent from this table licenses nothing -- the default is "never allowed" --
   and so is a term whose list is empty, which is spelled out rather than
   omitted so the intent is legible.

   Every entry below is derivable from the pairs i18n-claims.test.js already
   asserts over, plus the two live blurbs in assets/data/products.json that
   forced the change. Adding a trigger widens what a translation may say, so
   each one should be a word whose absence from the English would make the
   translation a NEW claim. */
const CALMS = ["calm", "calms", "calming", "soothe", "soothes", "soothing", "soothed"];
const RELIEVES = [
  "relieve",
  "relieves",
  "relieving",
  "ease",
  "eases",
  "easing",
  "soothe",
  "soothes"
];
const REMEDY = ["remedy", "remedies"];
const MEDICINAL = ["medicinal", "medicine", "medical"];
const THERAPEUTIC = ["therapeutic", "therapy", "therapies"];
const TREATS = ["treat", "treats", "treating", "treatment", "cure", "cures", "curing"];
const HEALS = ["heal", "heals", "healing"];
const NATURAL = ["natural", "naturally"];

const CLAIM_SOURCE_PARITY = {
  /* es */
  remedio: REMEDY,
  remedios: REMEDY,
  curativ: TREATS,
  medicinal: MEDICINAL,
  calmante: CALMS,
  terapéut: THERAPEUTIC,
  sanador: HEALS,
  /* de */
  heilmittel: REMEDY,
  heilend: HEALS,
  lindert: RELIEVES,
  beruhigt: CALMS,
  medizinisch: MEDICINAL,
  therapeutisch: THERAPEUTIC,
  /* fr */
  remède: REMEDY,
  remèdes: REMEDY,
  guérit: HEALS.concat(TREATS),
  apaise: CALMS,
  apaisant: CALMS,
  soulage: RELIEVES,
  médicinal: MEDICINAL,
  thérapeut: THERAPEUTIC,
  /* ja + zh. 安心 is a safety assurance and 効能/疗效/功效 are efficacy
     assertions: prohibited for cosmetics in JP and CN whether or not they are
     true, so no English sentence licenses them. */
  安心: [],
  効能: [],
  疗效: [],
  功效: [],
  天然: NATURAL,
  治療: TREATS,
  治疗: TREATS,
  改善: ["improve", "improves", "improving", "improvement"],
  舒缓: CALMS
};

/** Keys whose English itself uses the word, so the translation has to. Each
    needs a reason; "we could not phrase it otherwise" is not one. Source
    parity covers most of what this used to, but it is kept: a per-key
    exemption with a written reason is stronger evidence than a word match. */
const CLAIM_EXEMPT = {
  "pdp.notMedicine": {
    es: ["curar"],
    ja: ["治療", "治癒"],
    zh: ["治疗", "治愈"],
    reason:
      "the disclaimer denies these claims -- the English reads 'nothing here is meant to " +
      "diagnose, treat, cure or prevent any condition', so the words have to appear"
  }
};

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The English with every protected brand/product/INCI term removed, so a name
 * cannot license a claim. Callers pass brand-glossary.json's protectedTerms.
 */
function stripProtectedTerms(english, protectedTerms) {
  let rest = String(english);
  (protectedTerms || [])
    .slice()
    .sort(function (a, b) {
      return String(b).length - String(a).length;
    })
    .forEach(function (term) {
      if (term && rest.indexOf(term) !== -1) rest = rest.split(term).join(" ");
    });
  return rest;
}

/** True when the English licenses this banned term under source parity. */
function englishLicenses(word, english, protectedTerms) {
  const triggers = CLAIM_SOURCE_PARITY[String(word).toLowerCase()];
  if (!triggers || !triggers.length) return false;
  const haystack = stripProtectedTerms(english, protectedTerms).toLowerCase();
  return triggers.some(function (trigger) {
    /* Word boundaries, so "treat" does not fire on "retreat" and "ease" does
       not fire on "please". \b works here because every trigger is ASCII. */
    return new RegExp("\\b" + escapeRegExp(trigger.toLowerCase()) + "\\b").test(haystack);
  });
}

/** True when this key/locale pair is hand-exempted for this word. */
function keyIsExempt(key, code, word) {
  const exempt = CLAIM_EXEMPT[key] && CLAIM_EXEMPT[key][code];
  if (!exempt) return false;
  const lw = String(word).toLowerCase();
  return exempt.some(function (w) {
    const ew = String(w).toLowerCase();
    return lw.indexOf(ew) !== -1 || ew.indexOf(lw) !== -1;
  });
}

/**
 * Every banned term in `translated` that the English does not license.
 *
 * @param {{key: string, code: string, english: string, translated: string,
 *          protectedTerms: (Array<string>|undefined)}} input
 * @return {!Array<{word: string, licensed: boolean}>} offences; empty is a pass.
 */
function claimOffenses(input) {
  const code = input.code;
  const words = CLAIM_WORDS[code];
  if (!words) return [];
  const value = String(input.translated || "").toLowerCase();
  const offenses = [];
  words.forEach(function (word) {
    const lower = word.toLowerCase();
    if (value.indexOf(lower) === -1) return;
    if (keyIsExempt(input.key, code, lower)) return;
    if (englishLicenses(lower, input.english || "", input.protectedTerms)) return;
    offenses.push({ word: word, licensed: false });
  });
  return offenses;
}

/**
 * The prompt fragment for one locale, generated from the table above rather
 * than retyped, so the instruction the model gets and the gate that judges it
 * can never drift apart.
 */
function claimPromptFragment(code) {
  const words = CLAIM_WORDS[code] || [];
  const lines = words.map(function (word) {
    const triggers = CLAIM_SOURCE_PARITY[word.toLowerCase()];
    if (!triggers || !triggers.length) {
      return "  - never use " + JSON.stringify(word) + " (not permitted in any translation)";
    }
    return (
      "  - use " +
      JSON.stringify(word) +
      " only if the English says " +
      triggers
        .map(function (t) {
          return JSON.stringify(t);
        })
        .join(" / ")
    );
  });
  return lines.join("\n");
}

module.exports = {
  CLAIM_WORDS: CLAIM_WORDS,
  CLAIM_EXEMPT: CLAIM_EXEMPT,
  CLAIM_SOURCE_PARITY: CLAIM_SOURCE_PARITY,
  stripProtectedTerms: stripProtectedTerms,
  englishLicenses: englishLicenses,
  keyIsExempt: keyIsExempt,
  claimOffenses: claimOffenses,
  claimPromptFragment: claimPromptFragment
};

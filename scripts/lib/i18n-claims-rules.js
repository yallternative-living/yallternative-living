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
    substrings rather than whole words.

    Three groups, and the grouping is the argument:

    (1) MEDICINAL / TREATMENT REGISTER. The original list, plus the verbs the
        2026-09-04 research brief §7(d) names: a translation must not localise
        a cosmetic sentence into the register a pharmacy uses. Each is licensed
        only by an English treatment verb -- which is itself banned in the
        owner's copy by scripts/lib/copy-claims-rules.js, so in practice these
        are licensed only where the English DENIES the claim ("nothing here is
        meant to diagnose, treat, cure or prevent any condition").

    (2) CONDITION NAMES, licensed by nothing. The brief's rule is "never
        translate a symptom into a condition": "rough, dry patches" must not
        come back as Ekzem / eczéma / eccema / 湿疹 / 皮炎. A named disease in
        the target language is an intended-use claim under 21 U.S.C.
        § 321(g)(1)(B) and a medicine by presentation under Directive
        2001/83/EC Art. 1(2)(a), and no English marketing sentence licenses
        one. The single exception is the injury family -- herida / Wunde /
        plaie / 傷 / 伤口 -- which carries BROKEN_SKIN triggers because the
        live pdp.externalUseOnly caution says "keep away from ... broken skin"
        in English, and fr and ja already render that as "plaies" / "傷". A
        caution that tells you NOT to use the product somewhere is the opposite
        of an intended-use claim; the word is still an offence in every string
        whose English does not warn about broken skin.

    (3) EU/UK CLAIMS, licensed by nothing. Localized copy is aimed at exactly
        the markets where these are unlawful: the Commission's Technical
        document on cosmetic claims, Annex III, says "the claim 'free from
        parabens' should not be accepted" and that "free from
        allergenic/sensitizing substances" is not allowed; Annex IV requires
        that a "hypoallergenic" product avoid known allergens entirely, which
        an essential-oil line cannot; and DGCCRF's 2023 report lists
        « formulation clean » among unlawful claims. "Dermatologically tested"
        needs a test that does not exist here.

        These are licensed by nothing on purpose, including where the English
        might one day say a harmless "clean" (a clean scent). If that happens
        the fix is a CLAIM_EXEMPT entry for that key with a written reason --
        the module's designed escape hatch -- and not a trigger that would also
        license « formulation clean ». */
const CLAIM_WORDS = {
  es: [
    "remedio",
    "remedios",
    "curativ",
    "cura",
    "alivia",
    "medicinal",
    "calmante",
    "terapéut",
    "sanador",
    "eccema",
    "psoriasis",
    "dermatitis",
    "rosácea",
    "rosacea",
    "acné",
    "insomnio",
    "ansiedad",
    "migraña",
    "artritis",
    "infección",
    "inflamación",
    "dolor",
    "herida",
    "hipoalergénic",
    "dermatológicamente",
    "paraben",
    "alérgen",
    "clean"
  ],
  de: [
    "Heilmittel",
    "heilend",
    "lindert",
    "beruhigt",
    "medizinisch",
    "therapeutisch",
    "Ekzem",
    "Schuppenflechte",
    "Psoriasis",
    "Dermatitis",
    "Rosazea",
    "Rosacea",
    "Akne",
    "Schlaflosigkeit",
    "Angst",
    "Migräne",
    "Arthritis",
    "Infektion",
    "Entzündung",
    "Schmerz",
    "Wunde",
    "hypoallergen",
    "dermatologisch",
    "Paraben",
    "Allergen",
    "clean"
  ],
  fr: [
    "remède",
    "remèdes",
    "guérit",
    "apaise",
    "apaisant",
    "soulage",
    "soigner",
    "médicinal",
    "thérapeut",
    "eczéma",
    "psoriasis",
    "dermatite",
    "rosacée",
    "acné",
    "insomnie",
    "anxiété",
    "migraine",
    "arthrite",
    "infection",
    "inflammation",
    "douleur",
    "plaie",
    "hypoallergén",
    "dermatologiquement",
    "parabèn",
    "paraben",
    "allergèn",
    "clean"
  ],
  ja: [
    "安心",
    "天然",
    "効能",
    "効く",
    "治療",
    "治す",
    "改善",
    "湿疹",
    "乾癬",
    "皮膚炎",
    "酒さ",
    "ニキビ",
    "不眠",
    "不安",
    "片頭痛",
    "関節炎",
    "感染",
    "炎症",
    "痛み",
    "傷",
    "低アレルギー",
    "ノンアレルギー",
    "皮膚科テスト",
    "皮膚科医テスト",
    "パラベン",
    "アレルゲン",
    "クリーン",
    "clean"
  ],
  zh: [
    "安心",
    "天然",
    "疗效",
    "功效",
    "舒缓",
    "治疗",
    "湿疹",
    "银屑病",
    "牛皮癣",
    "皮炎",
    "玫瑰痤疮",
    "痤疮",
    "失眠",
    "焦虑",
    "偏头痛",
    "关节炎",
    "感染",
    "炎症",
    "疼痛",
    "伤口",
    "低敏",
    "皮肤科测试",
    "对羟基苯甲酸酯",
    "尼泊金",
    "过敏原",
    "clean"
  ]
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
/* The ONLY trigger list attached to a condition/injury word. pdp.externalUseOnly
   says "keep away from eyes and broken skin" -- a caution, not an intended use --
   and fr/ja already render that as "plaies" / "傷のある部分". "cut" is
   deliberately absent: "cut with shea" would license a wound word by accident. */
const BROKEN_SKIN = [
  "broken skin",
  "wound",
  "wounds",
  "scrape",
  "scrapes",
  "abrasion",
  "abrasions"
];

const CLAIM_SOURCE_PARITY = {
  /* es */
  remedio: REMEDY,
  remedios: REMEDY,
  curativ: TREATS,
  cura: TREATS,
  alivia: RELIEVES,
  medicinal: MEDICINAL,
  calmante: CALMS,
  terapéut: THERAPEUTIC,
  sanador: HEALS,
  herida: BROKEN_SKIN,
  /* de */
  heilmittel: REMEDY,
  heilend: HEALS,
  lindert: RELIEVES,
  beruhigt: CALMS,
  medizinisch: MEDICINAL,
  therapeutisch: THERAPEUTIC,
  wunde: BROKEN_SKIN,
  /* fr */
  remède: REMEDY,
  remèdes: REMEDY,
  guérit: HEALS.concat(TREATS),
  apaise: CALMS,
  apaisant: CALMS,
  soulage: RELIEVES,
  soigner: TREATS.concat(HEALS),
  médicinal: MEDICINAL,
  thérapeut: THERAPEUTIC,
  plaie: BROKEN_SKIN,
  /* ja + zh. 安心 is a safety assurance and 効能/疗效/功效 are efficacy
     assertions: prohibited for cosmetics in JP and CN whether or not they are
     true, so no English sentence licenses them. */
  安心: [],
  効能: [],
  疗效: [],
  功效: [],
  天然: NATURAL,
  治療: TREATS,
  治す: TREATS,
  効く: TREATS,
  治疗: TREATS,
  改善: ["improve", "improves", "improving", "improvement"],
  舒缓: CALMS,
  傷: BROKEN_SKIN,
  伤口: BROKEN_SKIN
  /* Every other term added on 2026-09-04 -- the condition names and the EU/UK
     claims -- is absent from this table on purpose: absent means "licensed by
     nothing", which is the rule the research brief asks for. */
};

/**
 * Longer, innocent words that CONTAIN a banned substring, per banned term.
 *
 * Substring matching is what lets "Heilmittel" catch "Kräuterheilmittel", and
 * that is worth keeping -- but it also means German "wunderbar" contains
 * "Wunde" and Spanish "manicura" contains "cura". A gate that fails on
 * "wunderbar" is a gate somebody switches off. Each container below is
 * stripped from the translation before that one term is looked for, exactly
 * the way stripProtectedTerms() removes a brand name from the English.
 *
 * Keep this list SHORT and keep it innocent. "Wundermittel" (miracle cure) is
 * deliberately not here: it is a claim, and it should trip the gate.
 */
const CLAIM_NOT_INSIDE = {
  /* de: wunderbar / wundervoll / wunderschön are the brand's register. */
  wunde: ["wunderbar", "wundervoll", "wunderschön", "wunderlich"],
  /* es: a nail service and "dark" are not a cure. */
  cura: ["manicura", "pedicura", "oscura", "obscura", "procura"],
  /* es: "indoloro" is painLESS. */
  dolor: ["indoloro", "indolora"],
  /* ja: 傷め- ("damage", in every conjugation, 傷めない included) and 傷み
     ("spoilage") are not injuries; 感傷 is sentimentality. */
  傷: ["傷め", "傷み", "感傷", "中傷"],
  /* every locale: cleanse / cleanser / cleansing / cleaner are the literal
     sense; only the marketing "clean" is the banned claim. */
  clean: ["cleans", "cleaner", "cleaning"]
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

/**
 * The translation with the innocent longer words that contain `word` removed,
 * so a substring ban cannot fire inside one of them. Replacement is a space,
 * not nothing, so two words cannot be glued into a third.
 */
function stripInnocentContainers(value, word) {
  const containers = CLAIM_NOT_INSIDE[String(word).toLowerCase()];
  if (!containers || !containers.length) return value;
  let rest = String(value);
  containers
    .slice()
    .sort(function (a, b) {
      return String(b).length - String(a).length;
    })
    .forEach(function (container) {
      const needle = String(container).toLowerCase();
      if (rest.indexOf(needle) !== -1) rest = rest.split(needle).join(" ");
    });
  return rest;
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
    if (stripInnocentContainers(value, lower).indexOf(lower) === -1) return;
    if (keyIsExempt(input.key, code, lower)) return;
    if (englishLicenses(lower, input.english || "", input.protectedTerms)) return;
    offenses.push({ word: word, licensed: false });
  });
  return offenses;
}

/**
 * Rules the GATE cannot express, and that therefore have to be said to the
 * model instead.
 *
 * The 2026-09-04 research brief §7(d) asks for four translation rules. Three
 * of them are word rules and live in the table above, where the gate enforces
 * them. The fourth -- "never render a hedge as a promise" -- is about a word
 * that is MISSING from the output, which no ban list can see: there is no
 * string to search for when "helps your skin feel softer" comes back as "makes
 * your skin softer". It is a prompt rule and it is written down as one, here,
 * rather than pretended into the gate. The gate is not weakened by a line
 * below; nothing here permits anything.
 */
const CLAIM_PROMPT_RULES = [
  'Never translate a symptom into a condition. "Rough, dry patches" describes skin; it is not',
  "eczema, dermatitis, psoriasis, rosacea or acne, and naming a condition invents a claim the",
  "English does not make. The same goes for insomnia, anxiety, migraine, arthritis, infection,",
  "inflammation and wounds.",
  'Never render a hedge as a promise. "Feels", "looks", "the look of", "helps you feel", "meant',
  'for" and "built for" are hedges, and every one of them has to survive into your translation.',
  "Where the target language has no natural hedge for a sentence, leave the sentence WEAKER than",
  "the English rather than stronger: an understatement is a question of style, an upgrade is a",
  "regulatory one. THIS RULE IS NOT MACHINE-CHECKED -- nothing downstream can see a hedge you drop,",
  "so it is on you.",
  "Never localise into a regulated register. The pharmacy wording of the target market is off",
  "limits even when it is the most idiomatic rendering available.",
  'Never add an EU/UK cosmetics claim, in any language: no "hypoallergenic", no "dermatologically',
  'tested", no "free from parabens" or "free from allergens", no "clean" formulation language.',
  "When in doubt, drop the word and keep the sentence plain. Output that adds a claim is a failure",
  "even when it is more fluent."
];

/**
 * The prompt fragment for one locale, generated from the table above rather
 * than retyped, so the instruction the model gets and the gate that judges it
 * can never drift apart. The trailing rules are the ones the gate cannot see;
 * they are appended here so there is exactly one call site to keep in sync.
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
  return lines
    .concat(["", "AND THESE, WHICH NO WORD LIST CAN CATCH:"], CLAIM_PROMPT_RULES)
    .join("\n");
}

module.exports = {
  CLAIM_WORDS: CLAIM_WORDS,
  CLAIM_EXEMPT: CLAIM_EXEMPT,
  CLAIM_SOURCE_PARITY: CLAIM_SOURCE_PARITY,
  CLAIM_NOT_INSIDE: CLAIM_NOT_INSIDE,
  CLAIM_PROMPT_RULES: CLAIM_PROMPT_RULES,
  stripProtectedTerms: stripProtectedTerms,
  stripInnocentContainers: stripInnocentContainers,
  englishLicenses: englishLicenses,
  keyIsExempt: keyIsExempt,
  claimOffenses: claimOffenses,
  claimPromptFragment: claimPromptFragment
};

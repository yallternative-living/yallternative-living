/**
 * @fileoverview Claims-drift pins for assets/data/locales/*.json.
 *
 * The 2026-09-01 audit found the translations drifting in one direction: every
 * error ADDED a claim the English does not make. A cosmetic that is presented
 * as a medicinal product is a regulatory problem under EU Reg. 1223/2009 Art.
 * 20, and 安心 ("safe / peace of mind") is a regulated assertion for cosmetics
 * in Japan. Fluency is a matter of taste; these are not. The specific findings,
 * each of which now has a pin below:
 *
 *   - quiz.subtitle (de) turned "herbal remedies" into "Kräuterheilmittel",
 *     a curative remedy
 *   - home.badge3Text (ja) added 安心 to a line about ingredients you can
 *     pronounce
 *   - home.featuredText (ja) promised a salve that "regulates your skin and
 *     sleep"; es/de replaced the joke with "calma tu piel" / "beruhigt eure
 *     Haut" and dropped the "(and your sleep)" aside altogether
 *   - home.badge3Text (all five) swapped the plain ingredient names for INCI
 *     binomials inside a sentence whose joke is that you can pronounce them
 *   - footer.newsletterSubtext (all five) invented the promo code YALL10
 *   - cart.emptySubtext (es, de, ja) inserted the brand name into copy that
 *     has none in English
 *   - home.heroText (ja) dropped the "told they're a little too much" premise,
 *     which is the brand
 *
 * The rules are asserted over the WHOLE dictionary, not just the keys that were
 * wrong, because the next drift will be in a different key. Where the English
 * itself contains one of these words -- the "not medicine" disclaimer says
 * "diagnose, treat, cure or prevent" precisely in order to deny it -- the key
 * is exempted by name with a reason, not by loosening the rule.
 *
 * Run: node scripts/i18n-claims.test.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CODES = ["en", "es", "de", "fr", "ja", "zh"];

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

const locales = {};
CODES.forEach((code) => {
  locales[code] = JSON.parse(
    fs.readFileSync(path.join(ROOT, "assets/data/locales", code + ".json"), "utf8")
  );
});
const glossary = JSON.parse(
  fs.readFileSync(path.join(ROOT, "assets/data/brand-glossary.json"), "utf8")
);

const enPhrases = locales.en.phrases;
const keys = Object.keys(enPhrases);

console.log("Running i18n claims-drift pins...\n");

/* Assert the subject exists before asserting anything about it: every loop
   below is vacuously true over an empty dictionary. */
assert(keys.length >= 300, "dictionary has at least 300 keys", "found " + keys.length);
CODES.slice(1).forEach((code) => {
  assert(
    Object.keys(locales[code].phrases || {}).length === keys.length,
    "locale " + code + " has the same number of keys as en",
    "en " + keys.length + " vs " + code + " " + Object.keys(locales[code].phrases || {}).length
  );
});

/* Look a key up by the English string it holds, so renaming a key cannot
   quietly retire a pin -- the assertion fails loudly instead. */
function keyFor(englishText) {
  const found = keys.filter((k) => enPhrases[k] === englishText);
  return found.length === 1 ? found[0] : null;
}

// ---------------------------------------------------------------------------
// 1. No claim vocabulary anywhere the English does not have it.
// ---------------------------------------------------------------------------
const CLAIM_WORDS = {
  es: ["remedio", "remedios", "curativ", "medicinal", "calmante", "terapéut", "sanador"],
  de: ["Heilmittel", "heilend", "lindert", "beruhigt", "medizinisch", "therapeutisch"],
  fr: ["remède", "remèdes", "guérit", "apaise", "apaisant", "soulage", "médicinal", "thérapeut"],
  ja: ["安心", "天然", "効能", "治療", "改善"],
  zh: ["安心", "天然", "疗效", "功效", "舒缓", "治疗"]
};

/* Keys whose English itself uses the word, so the translation has to. Each
   needs a reason; "we could not phrase it otherwise" is not one. */
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

/* Matched case-insensitively. German compounds the word rather than standing it
   alone -- "Kräuterheilmittel" is the exact form the audit found, and a
   case-sensitive search for "Heilmittel" walks straight past it. */
CODES.slice(1).forEach((code) => {
  const words = CLAIM_WORDS[code].map((w) => w.toLowerCase());
  const offenders = [];
  keys.forEach((key) => {
    const raw = locales[code].phrases[key] || "";
    const value = raw.toLowerCase();
    words.forEach((word) => {
      if (value.indexOf(word) === -1) return;
      const exempt = CLAIM_EXEMPT[key] && CLAIM_EXEMPT[key][code];
      if (
        exempt &&
        exempt.some((w) => {
          const lw = w.toLowerCase();
          return word.indexOf(lw) !== -1 || lw.indexOf(word) !== -1;
        })
      ) {
        return;
      }
      offenders.push(key + ": " + JSON.stringify(word) + " in " + JSON.stringify(raw));
    });
  });
  assert(
    offenders.length === 0,
    "locale " + code + " adds no medicinal, soothing or safety claim",
    offenders.join("\n      ")
  );
});

// ---------------------------------------------------------------------------
// 2. No INCI binomial anywhere in the UI dictionary.
// ---------------------------------------------------------------------------
const botanicals = (glossary.categories && glossary.categories.botanicals) || [];
assert(botanicals.length > 0, "the glossary lists INCI botanicals to check against");
{
  const offenders = [];
  CODES.forEach((code) => {
    keys.forEach((key) => {
      const value = locales[code].phrases[key] || "";
      botanicals.forEach((term) => {
        if (value.indexOf(term) !== -1) {
          offenders.push(code + "." + key + " contains INCI " + JSON.stringify(term));
        }
      });
    });
  });
  assert(
    offenders.length === 0,
    "no locale substitutes an INCI binomial into UI copy",
    offenders.join("\n      ")
  );
}

// ---------------------------------------------------------------------------
// 3. No locale invents a brand or product name the English does not use.
// ---------------------------------------------------------------------------
{
  const brandish = (glossary.protectedTerms || []).concat(
    (glossary.categories && glossary.categories.brand) || []
  );
  assert(brandish.length > 0, "the glossary lists brand terms to check against");
  const offenders = [];
  keys.forEach((key) => {
    const en = enPhrases[key];
    brandish.forEach((term) => {
      if (en.indexOf(term) !== -1) return;
      CODES.slice(1).forEach((code) => {
        const value = locales[code].phrases[key] || "";
        if (value.indexOf(term) !== -1) {
          offenders.push(code + "." + key + " inserts " + JSON.stringify(term));
        }
      });
    });
  });
  assert(
    offenders.length === 0,
    "no locale inserts a brand or product name the English does not have",
    offenders.join("\n      ")
  );
}

// ---------------------------------------------------------------------------
// 4. No invented promo code, in any locale, including English.
// ---------------------------------------------------------------------------
{
  const offenders = [];
  CODES.forEach((code) => {
    keys.forEach((key) => {
      const value = locales[code].phrases[key] || "";
      if (/YALL\d+/.test(value)) offenders.push(code + "." + key + ": " + JSON.stringify(value));
    });
  });
  assert(
    offenders.length === 0,
    "no dictionary value carries a promo code",
    offenders.join("\n      ")
  );
}

// ---------------------------------------------------------------------------
// 5. The specific lines the audit called out still say what they should.
// ---------------------------------------------------------------------------
{
  const badgeKey = keyFor(
    "Calendula, arnica, magnesium, shea: stuff you can actually pronounce and trust."
  );
  assert(badgeKey !== null, "the 'stuff you can actually pronounce' badge is in the dictionary");
  if (badgeKey) {
    /* The joke is that the ingredients are pronounceable, so each locale has to
       name all four of them in plain words. Checked by counting separators
       rather than by matching a translation, so the assertion survives
       rewording. */
    CODES.slice(1).forEach((code) => {
      const value = locales[code].phrases[badgeKey];
      const parts = value.split(/[,、，]/).length;
      assert(
        parts >= 4,
        "badge3Text [" + code + "] still names the four ingredients in plain words",
        JSON.stringify(value)
      );
    });
  }

  const featuredKey = keyFor(
    "The stuff y'all keep coming back for, from the flagship tee to the salve that actually " +
      "gets your skin (and your sleep) to behave."
  );
  assert(featuredKey !== null, "the 'gets your skin to behave' line is in the dictionary");
  if (featuredKey) {
    /* "(and your sleep)" was dropped from es, de and fr. It is an aside in
       parentheses in every locale, so its presence is checkable without
       knowing the wording. */
    const sleepWord = { es: "sueño", de: "Schlaf", fr: "sommeil", ja: "睡眠", zh: "睡眠" };
    CODES.slice(1).forEach((code) => {
      const value = locales[code].phrases[featuredKey];
      assert(
        value.indexOf(sleepWord[code]) !== -1,
        "featuredText [" + code + "] keeps the '(and your sleep)' aside",
        JSON.stringify(value)
      );
      assert(
        /[(（].*[)）]/.test(value),
        "featuredText [" + code + "] keeps the aside parenthesised",
        JSON.stringify(value)
      );
    });
  }

  const heroKey = keyFor(
    "For anybody who's ever been told they're a little too much: taking up space and smelling " +
      "amazing was always the plan."
  );
  assert(heroKey !== null, "the hero premise is in the dictionary");
  if (heroKey) {
    /* The Japanese dropped the "told they're a little too much" premise
       entirely -- the inclusion message, which is the brand. A translation that
       keeps it cannot be much shorter than the others. */
    CODES.slice(1).forEach((code) => {
      const value = locales[code].phrases[heroKey];
      assert(
        value.length >= 30,
        "heroText [" + code + "] is not a truncated rewrite",
        JSON.stringify(value)
      );
    });
    assert(
      locales.ja.phrases[heroKey].indexOf("多すぎる") !== -1,
      "heroText [ja] still carries the 'a little too much' premise",
      JSON.stringify(locales.ja.phrases[heroKey])
    );
  }

  const quizKey = keyFor(
    "Answer 3 quick questions in our popup quiz to discover your personalized salve, soak, or " +
      "potion match."
  );
  assert(quizKey !== null, "the quiz subtitle is in the dictionary");
  if (quizKey) {
    /* The old subtitle called the products "herbal remedies", which de rendered
       as "Kräuterheilmittel". The English no longer says remedy at all; rule 1
       above keeps the translations from re-introducing one. This pins that the
       English itself stays out of the remedy register. */
    assert(
      !/\bremed(y|ies)\b/i.test(enPhrases[quizKey]),
      "the English quiz subtitle does not call the products remedies",
      JSON.stringify(enPhrases[quizKey])
    );
  }
}

// ---------------------------------------------------------------------------
// 6. The three keys that used to be identical in all five locales.
// ---------------------------------------------------------------------------
{
  const wereIdentical = [
    "✦ COMPLETE THE RITUAL ✦",
    "Pair this item with complementary botanicals crafted to work together.",
    "Find Your Custom Self-Care Match"
  ];
  wereIdentical.forEach((englishText) => {
    const key = keyFor(englishText);
    assert(key !== null, "dictionary holds " + JSON.stringify(englishText.slice(0, 40)));
    if (!key) return;
    const same = CODES.slice(1).filter((code) => locales[code].phrases[key] === englishText);
    assert(
      same.length === 0,
      "'" + key + "' is translated in all five non-English locales",
      "still English in: " + same.join(", ")
    );
  });
}

// ---------------------------------------------------------------------------
// 7. The governing-language line still says the English governs.
// ---------------------------------------------------------------------------
{
  const governsKey = keyFor(
    "Heads up: we keep this page in English on purpose. If your browser or our language " +
      "picker shows it another way, the English text is the one that counts."
  );
  assert(governsKey !== null, "the governing-language line is in the dictionary");
  if (governsKey) {
    const englishWord = {
      es: ["inglés"],
      de: ["Englisch", "englische"],
      fr: ["anglais"],
      ja: ["英語"],
      zh: ["英文", "英语"]
    };
    CODES.slice(1).forEach((code) => {
      const value = locales[code].phrases[governsKey] || "";
      assert(
        englishWord[code].some((w) => value.indexOf(w) !== -1),
        "the governing-language line still names English in " + code,
        JSON.stringify(value)
      );
    });
  }
}

console.log("\ni18n-claims.test.js: " + passed + " passed, " + failed + " failed");
if (require.main === module) {
  process.exit(failed ? 1 : 0);
}
module.exports = { passed, failed };

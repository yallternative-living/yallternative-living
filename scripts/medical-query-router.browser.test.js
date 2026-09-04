/* eslint-env node, browser */
/**
 * @fileoverview The medical-query router, driven in a real browser.
 *
 * A shopper types "psoriasis" into a shop that sells body butter. The legal
 * brief of 2026-09-04 (section 7(c)) says what has to happen: recognise the
 * word, match on NOTHING, and answer with a fixed note saying we make comfort
 * products and not medicines, above a link to a cosmetically-named shelf. This
 * suite is that requirement, asserted against the shipped pages rather than
 * against the functions -- because every part of the requirement is about what
 * a reader (and a regulator, and a crawler) can actually SEE.
 *
 * What it holds:
 *
 *   1. "psoriasis"           note visible, dry-skin shelf, ZERO product tiles,
 *                            and NOT the ordinary "No Apothecary Items Found"
 *                            panel -- that panel answers a search that failed,
 *                            and this search was answered.
 *   2. "wound salve"         note visible AND the salves still listed, exactly
 *                            as a search for "salve" alone lists them. Only the
 *                            medical token is taken out of the matching.
 *   3. "cure for itchy skin" note visible, and the same products "itchy skin"
 *                            finds on its own.
 *   4. "itchy skin"          NO note. Lay symptom vocabulary is not medical
 *                            vocabulary, and treating it as such would put a
 *                            disclaimer on half the shop's real traffic.
 *   5. the note is inline    Not inside anything hidden, collapsed, closed or
 *                            aria-hidden, at any depth. FTC's Health Products
 *                            Compliance Guidance calls hyperlinked disclosures
 *                            avoidable, and 16 CFR 465.1(c)(4) says a
 *                            disclosure the reader must click or hover to see
 *                            is not clear and conspicuous.
 *   6. noindex               present for a medical query and absent otherwise,
 *                            so the rendered results view never gets filed
 *                            under the word.
 *   7. nothing PRESENTS the  no disease word in the page text, in a popular
 *      words                 chip, or in the modal's suggestion UI. This is
 *                            the constraint the brief calls the single most
 *                            important one: recognising a condition is lawful,
 *                            presenting a list of them is MHRA Appendix 9.
 *   8. the modal too         the global search dialog is a search surface as
 *                            much as the shop grid is.
 *
 * Run: node scripts/medical-query-router.browser.test.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const ROOT = path.resolve(__dirname, "..");

/* Words that may legitimately appear in the shop's own rendered copy, with the
   reason. Everything else on the router's list must appear nowhere: this is a
   subset check, not an equality one, so the day the owner renames "Y'all Heal
   Now" (which the 2026-09-01 review recommends) this suite gets quieter rather
   than red. */
const RENDERED_WORD_ALLOWLIST = {
  heal: "the \"Y'all Heal Now\" product name -- the owner's decision, flagged in the review",
  diagnose: 'the footer disclaimer ("not intended to diagnose, treat, cure, or prevent")',
  treat: "the same footer disclaimer, and the router note itself",
  cure: "the same footer disclaimer, and the router note itself",
  medicine: 'the router note ("we make comfort products, not medicines")',
  medicines: "the router note"
};

function createTestServer() {
  const mimeTypes = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".avif": "image/avif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json"
  };
  const server = http.createServer((req, res) => {
    let reqPath = req.url.split("?")[0];
    if (reqPath === "/") reqPath = "/index.html";
    let filePath = path.join(ROOT, reqPath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(ROOT, "404.html");
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end("Server error");
        return;
      }
      res.writeHead(200, {
        "Content-Type":
          mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream"
      });
      res.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    /* Port 0: the OS picks a free one, so this suite can run beside every other
       browser suite in the pool without a port collision. */
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const failures = [];

function ok(msg) {
  passed++;
  console.log("  ✓ " + msg);
}

function bad(msg, detail) {
  failed++;
  failures.push(msg + (detail ? " -- " + detail : ""));
  console.error("  ✗ FAIL: " + msg + (detail ? "\n      " + detail : ""));
}

function check(cond, msg, detail) {
  if (cond) ok(msg);
  else bad(msg, detail);
}

(async () => {
  console.log("=".repeat(80));
  console.log("MEDICAL-QUERY ROUTER (legal brief 2026-09-04, section 7(c))");
  console.log("=".repeat(80) + "\n");

  let serverInstance = null;
  let browser = null;

  try {
    const { server, port } = await createTestServer();
    serverInstance = server;
    const baseUrl = "http://127.0.0.1:" + port;
    console.log("Test server on " + baseUrl + "\n");

    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto(baseUrl + "/shop.html", { waitUntil: "networkidle2" });

    const terms = await page.evaluate(() =>
      window.YL_SEARCH_INDEX && Array.isArray(window.YL_SEARCH_INDEX.medicalQueryTerms)
        ? window.YL_SEARCH_INDEX.medicalQueryTerms
        : []
    );
    check(
      terms.length >= 30,
      "the shipped index carries the router's word list (" + terms.length + " words)"
    );

    /* ------------------------------------------------------------------
       Drive the shop grid.
       ------------------------------------------------------------------ */
    async function search(text) {
      await page.evaluate((t) => {
        const input = document.getElementById("shopSearch");
        input.value = t;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, text);
      /* The shop search debounces at 150ms. */
      await sleep(400);
      return page.evaluate(() => {
        const note = document.getElementById("shopMedicalNote");
        const grid = document.getElementById("shopGrid");
        const link = note ? note.querySelector("a") : null;
        const cards = Array.from(grid.querySelectorAll("article.card"));
        return {
          noteExists: !!note,
          noteVisible: !!note && !note.hidden && !!note.offsetParent,
          noteText: note ? note.innerText.trim() : "",
          linkHref: link ? link.getAttribute("href") : null,
          linkText: link ? link.textContent.trim() : null,
          cardIds: cards.map((c) => c.getAttribute("data-id")),
          hasEmptyStatePanel: !!grid.querySelector(".yl-no-results"),
          countText: (document.getElementById("shopCount") || {}).textContent || "",
          robots: Array.from(document.head.querySelectorAll('meta[name="robots"]')).map(
            (m) => m.getAttribute("content") || ""
          ),
          bodyText: document.body.innerText.toLowerCase()
        };
      });
    }

    const LEDE =
      "We make comfort products, not medicines — nothing here is meant to diagnose, treat, cure or prevent anything.";
    const INVITE = "If you're looking for something kind to dry, rough skin, start here.";

    // --- 1. "psoriasis": recognised, answered, and matched against nothing ---
    console.log('\n[1] "psoriasis" -- a named disease, alone');
    const psoriasis = await search("psoriasis");
    check(psoriasis.noteVisible, "the note is visible");
    check(
      psoriasis.noteText.indexOf(LEDE) === 0,
      "it opens with the fixed non-claim wording, verbatim",
      JSON.stringify(psoriasis.noteText)
    );
    check(
      psoriasis.noteText.indexOf(INVITE) !== -1,
      "and ends with the invitation to a cosmetically-named shelf",
      JSON.stringify(psoriasis.noteText)
    );
    check(
      /shop\.html\?concern=dry-skin$/.test(psoriasis.linkHref || ""),
      "the link points at the Dry, Rough Skin concern",
      String(psoriasis.linkHref)
    );
    check(
      psoriasis.linkText === "start here",
      "the link text is three cosmetic words, not a condition name",
      String(psoriasis.linkText)
    );
    check(
      !/psoriasis|eczema|dermatitis/.test(psoriasis.linkHref || ""),
      "and the URL carries no condition name either"
    );
    check(psoriasis.cardIds.length === 0, "zero product tiles", psoriasis.cardIds.join(", "));
    check(
      !psoriasis.hasEmptyStatePanel,
      'and NOT the bare "No Apothecary Items Found" panel -- the search was answered'
    );
    check(
      psoriasis.countText.indexOf("psoriasis") === -1,
      "the result count line does not quote the word back",
      JSON.stringify(psoriasis.countText)
    );
    check(
      psoriasis.robots.some((c) => c.indexOf("noindex") !== -1),
      "a robots noindex meta is present for the medical query",
      JSON.stringify(psoriasis.robots)
    );
    check(
      psoriasis.bodyText.indexOf("psoriasis") === -1,
      "and the word appears nowhere in the rendered page text"
    );

    /* The note must be reachable without any action: no ancestor hidden,
       collapsed, closed or aria-hidden. */
    const enclosure = await page.evaluate(() => {
      const note = document.getElementById("shopMedicalNote");
      if (!note) return { found: false };
      const problems = [];
      let el = note;
      while (el && el !== document.documentElement) {
        const cs = window.getComputedStyle(el);
        const name = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "");
        if (el.hasAttribute("hidden")) problems.push(name + " [hidden]");
        if (el.getAttribute("aria-hidden") === "true") problems.push(name + " [aria-hidden]");
        if (cs.display === "none") problems.push(name + " display:none");
        if (cs.visibility === "hidden" || cs.visibility === "collapse") {
          problems.push(name + " visibility:" + cs.visibility);
        }
        if (Number(cs.opacity) === 0) problems.push(name + " opacity:0");
        if (el.tagName === "DETAILS" && !el.open) problems.push(name + " closed <details>");
        if (el.tagName === "DIALOG" && !el.open) problems.push(name + " closed <dialog>");
        el = el.parentElement;
      }
      const rect = note.getBoundingClientRect();
      const grid = document.getElementById("shopGrid");
      return {
        found: true,
        problems: problems,
        height: rect.height,
        aboveResults: rect.top <= grid.getBoundingClientRect().top,
        insideSummary: !!note.closest("summary"),
        insideTooltip: !!note.closest('[role="tooltip"]')
      };
    });
    check(
      enclosure.found && !enclosure.problems.length,
      "no ancestor hides or collapses the note",
      (enclosure.problems || []).join(", ")
    );
    check(enclosure.height > 0, "the note has real height on screen (" + enclosure.height + "px)");
    check(enclosure.aboveResults, "and sits ABOVE the results, not below them");
    check(
      !enclosure.insideSummary && !enclosure.insideTooltip,
      "it is not inside a <summary> or a tooltip"
    );

    // --- 2. "wound salve": the ordinary word still works ---
    console.log('\n[2] "wound salve" -- a medical word beside an ordinary one');
    const salveOnly = await search("salve");
    check(!salveOnly.noteVisible, '"salve" alone shows no note');
    check(
      salveOnly.cardIds.length > 0,
      '"salve" finds products (' + salveOnly.cardIds.length + ")"
    );

    const woundSalve = await search("wound salve");
    check(woundSalve.noteVisible, "the note is visible");
    check(
      JSON.stringify(woundSalve.cardIds) === JSON.stringify(salveOnly.cardIds),
      'and the salves are still listed -- exactly what "salve" alone lists',
      JSON.stringify(woundSalve.cardIds) + " vs " + JSON.stringify(salveOnly.cardIds)
    );
    check(
      woundSalve.cardIds.some((id) => /salve|balm/.test(id || "")),
      "including the salves themselves",
      woundSalve.cardIds.join(", ")
    );
    check(/\bwound\b/.test(woundSalve.bodyText) === false, '"wound" is rendered nowhere');

    // --- 3. "cure for itchy skin": a statutory verb around lay vocabulary ---
    console.log('\n[3] "cure for itchy skin" -- a drug verb around lay vocabulary');
    const itchyOnly = await search("itchy skin");
    check(!itchyOnly.noteVisible, '"itchy skin" alone shows NO note -- it is lay vocabulary');
    check(
      !itchyOnly.robots.some((c) => c.indexOf("noindex") !== -1),
      "and leaves the page indexable",
      JSON.stringify(itchyOnly.robots)
    );
    check(
      itchyOnly.cardIds.length >= 10,
      '"itchy skin" finds the shop\'s comfort products (' + itchyOnly.cardIds.length + ")"
    );

    const cureItchy = await search("cure for itchy skin");
    check(cureItchy.noteVisible, "the note is visible");
    check(
      JSON.stringify(cureItchy.cardIds) === JSON.stringify(itchyOnly.cardIds),
      "and the same " + itchyOnly.cardIds.length + ' products are found as for "itchy skin"',
      JSON.stringify(cureItchy.cardIds)
    );
    check(
      cureItchy.countText.indexOf("cure") === -1,
      "the count line does not quote the query back",
      JSON.stringify(cureItchy.countText)
    );

    // --- 4. nothing PRESENTS the words ---
    console.log("\n[4] recognised, never presented");
    await search("");
    const rendered = await page.evaluate((list) => {
      const text = document.body.innerText.toLowerCase();
      return list.filter((word) => {
        const pattern = word.replace(/[-]/g, "[- ]").replace(/[^a-z0-9[\]\- ]/g, "");
        return new RegExp("\\b" + pattern + "\\b").test(text);
      });
    }, terms);
    const unexpected = rendered.filter(
      (w) => !Object.prototype.hasOwnProperty.call(RENDERED_WORD_ALLOWLIST, w)
    );
    check(
      unexpected.length === 0,
      "no router word is rendered on the shop page except the documented ones",
      "unexpected: " + unexpected.join(", ") + " | allowed and present: " + rendered.join(", ")
    );
    [
      "eczema",
      "psoriasis",
      "dermatitis",
      "rosacea",
      "acne",
      "insomnia",
      "arthritis",
      "infection",
      "repellent"
    ].forEach((disease) => {
      check(
        rendered.indexOf(disease) === -1,
        "no named condition on the page: " + JSON.stringify(disease)
      );
    });

    const chipQueries = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".search-chip")).map(
        (c) => (c.getAttribute("data-search-query") || "") + " " + c.textContent
      )
    );
    check(chipQueries.length > 0, "the popular-search chips render (" + chipQueries.length + ")");
    const chipHit = chipQueries.filter((chip) =>
      terms.some((t) => chip.toLowerCase().indexOf(t) !== -1)
    );
    check(
      chipHit.length === 0,
      "and no chip offers a medical word as a search",
      chipHit.join(" | ")
    );

    /* ------------------------------------------------------------------
       5. The global search dialog is a search surface too.
       ------------------------------------------------------------------ */
    console.log("\n[5] the global search modal");
    await page.evaluate(() => {
      const trigger =
        document.getElementById("globalSearchTrigger") ||
        document.querySelector("[data-action='open-global-search']");
      if (trigger) trigger.click();
    });
    await sleep(400);

    async function modalSearch(text) {
      await page.evaluate((t) => {
        const input = document.getElementById("globalSearchInput");
        input.value = t;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, text);
      await sleep(600);
      return page.evaluate(() => {
        const note = document.getElementById("globalSearchMedicalNote");
        const list = document.getElementById("globalSearchResultsList");
        const chips = document.getElementById("globalSearchChipsSection");
        return {
          noteVisible: !!note && !note.hidden && !!note.offsetParent,
          noteText: note ? note.innerText.trim() : "",
          noteBeforeResults: !!note && !!(note.compareDocumentPosition(list) & 4),
          rows: list.querySelectorAll(".search-result-item").length,
          hasEmptyPanel: !!list.querySelector(".search-empty-state"),
          countText: (document.getElementById("globalSearchResultCount") || {}).textContent || "",
          chipsText: chips ? chips.innerText.toLowerCase() : "",
          bodyText: document.body.innerText.toLowerCase()
        };
      });
    }

    const modalPsoriasis = await modalSearch("psoriasis");
    check(modalPsoriasis.noteVisible, "the note is visible in the modal");
    check(modalPsoriasis.noteBeforeResults, "and is rendered above the results list");
    check(modalPsoriasis.rows === 0, "zero result rows", String(modalPsoriasis.rows));
    check(
      !modalPsoriasis.hasEmptyPanel,
      "and not the zero-result panel, which would name the query in a heading"
    );
    check(
      modalPsoriasis.countText.indexOf("psoriasis") === -1 &&
        modalPsoriasis.bodyText.indexOf("psoriasis") === -1,
      "the word reaches no rendered string",
      JSON.stringify(modalPsoriasis.countText)
    );

    const modalWound = await modalSearch("wound salve");
    check(modalWound.noteVisible, '"wound salve" keeps the note in the modal');
    check(
      modalWound.rows > 0,
      "and still returns the salves (" + modalWound.rows + " rows)",
      String(modalWound.rows)
    );

    const modalItchy = await modalSearch("itchy skin");
    check(!modalItchy.noteVisible, '"itchy skin" shows no note in the modal either');
    check(modalItchy.rows > 0, "and returns products (" + modalItchy.rows + " rows)");

    await modalSearch("");
    const suggestionHit = await page.evaluate((list) => {
      const chips = document.getElementById("globalSearchChipsSection");
      const text = chips ? chips.innerText.toLowerCase() : "";
      const queries = Array.from(document.querySelectorAll("[data-search-query]"))
        .map((el) => (el.getAttribute("data-search-query") || "").toLowerCase())
        .join(" ");
      return list.filter((t) => text.indexOf(t) !== -1 || queries.indexOf(t) !== -1);
    }, terms);
    check(
      suggestionHit.length === 0,
      "the modal's suggestion UI offers no medical word",
      suggestionHit.join(", ")
    );

    check(pageErrors.length === 0, "no uncaught page errors", pageErrors.join(" | "));

    /* Screenshots for the record. */
    const shotDir = process.env.YL_SHOT_DIR;
    if (shotDir && fs.existsSync(shotDir)) {
      await page.keyboard.press("Escape");
      await sleep(200);
      const intoView = () =>
        page.evaluate(() => {
          const note = document.getElementById("shopMedicalNote");
          if (note) note.scrollIntoView({ block: "center" });
        });
      await search("psoriasis");
      await intoView();
      await sleep(200);
      await page.screenshot({ path: path.join(shotDir, "shop-psoriasis.png") });
      await search("wound salve");
      await intoView();
      await sleep(200);
      await page.screenshot({ path: path.join(shotDir, "shop-wound-salve.png") });
      console.log("\nscreenshots written to " + shotDir);
    }
  } catch (err) {
    bad("suite crashed", err && err.stack ? err.stack : String(err));
  } finally {
    if (browser) await browser.close();
    if (serverInstance) serverInstance.close();
  }

  console.log("\n" + "=".repeat(80));
  console.log("MEDICAL-QUERY ROUTER: " + passed + " passed, " + failed + " failed");
  if (failures.length) failures.forEach((f) => console.log("  - " + f));
  console.log("=".repeat(80));
  process.exit(failed ? 1 : 0);
})();

const puppeteer = require("puppeteer");

(async () => {
  console.log("Starting Puppeteer tests...");
  let exitCode = 0;
  let browser;
  try {
    browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
    const page = await browser.newPage();
    const url = "http://127.0.0.1:8082";

    // 1. Check for Broken Links (Internal)
    console.log("--- Testing Broken Links ---");
    await page.goto(url, { waitUntil: "networkidle2" });
    const hrefs = await page.$$eval("a", (links) =>
      links.map((a) => a.href).filter((h) => h.startsWith("http"))
    );
    let brokenLinks = [];
    for (let href of [...new Set(hrefs)]) {
      if (href.startsWith(url)) {
        try {
          const res = await page.goto(href, { waitUntil: "domcontentloaded" });
          if (res && res.status() >= 400) {
            brokenLinks.push(`${href} (Status: ${res.status()})`);
          }
        } catch (e) {
          brokenLinks.push(`${href} (Error: ${e.message})`);
        }
      }
    }
    if (brokenLinks.length > 0) {
      console.log(`❌ Found ${brokenLinks.length} broken links:`);
      brokenLinks.forEach((b) => console.log(b));
      exitCode = 1;
    } else {
      console.log("✅ No broken internal links found on homepage.");
    }

    // 2. Test Mobile Menu Interaction
    console.log("--- Testing Mobile Menu ---");
    await page.goto(url, { waitUntil: "networkidle2" });
    await page.setViewport({ width: 375, height: 667 });

    const menuToggle = await page.$(".nav-toggle");
    if (menuToggle) {
      await menuToggle.click();
      await new Promise((r) => setTimeout(r, 500)); // wait for transition
      const isActive = await page.$eval(
        ".nav-links",
        // eslint-disable-next-line no-undef
        (el) => el.classList.contains("active") || window.getComputedStyle(el).display !== "none"
      );

      if (isActive) {
        console.log("✅ Mobile menu toggle works.");
      } else {
        console.log("❌ Mobile menu did not become active/visible after clicking toggle.");
        exitCode = 1;
      }
    } else {
      console.log("❌ Mobile menu toggle button not found.");
      exitCode = 1;
    }
    await page.setViewport({ width: 1200, height: 800 });

    // 3. Test Form Submissions
    console.log("--- Testing Newsletter Form ---");
    await page.goto(url, { waitUntil: "networkidle2" });
    const emailInput = await page.$("#footer_email");
    if (emailInput) {
      await emailInput.type("test@example.com");

      let intercepted = false;
      await page.setRequestInterception(true);
      const requestHandler = (req) => {
        if (req.isInterceptResolutionHandled()) return;
        if (req.method() === "POST" && req.url().includes("YOUR_KIT_FORM_ACTION_URL")) {
          intercepted = true;
          req.abort();
        } else {
          req.continue();
        }
      };
      page.on("request", requestHandler);

      await page.$eval(".footer-signup-form", (form) => form.submit()).catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));

      if (intercepted) {
        console.log("✅ Form submission intercepted correctly.");
      } else {
        console.log("❌ Form did not submit to the expected URL.");
        exitCode = 1;
      }

      page.off("request", requestHandler);
      await page.setRequestInterception(false);
    } else {
      console.log("❌ Newsletter form not found.");
      exitCode = 1;
    }

    // 4. Test Snipcart E-commerce Cart Flow
    console.log("--- Testing Snipcart Flow ---");
    await page.goto(`${url}/shop.html`, { waitUntil: "networkidle2" });
    await page.waitForSelector(".snipcart-add-item", { timeout: 5000 }).catch(() => {});
    const addBtn = await page.$(".snipcart-add-item");
    if (addBtn) {
      await addBtn.click();
      let snipcartVisible = false;
      try {
        await page.waitForSelector(".snipcart-modal", { visible: true, timeout: 5000 });
        snipcartVisible = true;
      } catch (e) {
        // try checking if body has snipcart class or checking shadow dom if used
        snipcartVisible = await page
          .$eval("#snipcart", (el) => {
            return !el.hasAttribute("hidden");
          })
          .catch(() => false);
      }

      if (snipcartVisible) {
        console.log("✅ Snipcart modal appeared after adding to cart.");
      } else {
        console.log("❌ Snipcart modal did not appear. (Snipcart might need valid API keys)");
        exitCode = 1;
      }
    } else {
      console.log("❌ No 'Add to Cart' button found on shop.html.");
      exitCode = 1;
    }
  } catch (e) {
    console.error("❌ Unexpected error in Puppeteer tests:", e);
    exitCode = 1;
  } finally {
    if (browser) await browser.close();
    process.exit(exitCode);
  }
})();

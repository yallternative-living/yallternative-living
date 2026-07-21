const puppeteer = require("puppeteer");
const path = require("path");

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 700 });

  await page.goto("http://localhost:8082/shop.html", { waitUntil: "networkidle0" });

  await page.screenshot({ path: path.join(__dirname, "../header_option_current.png") });

  await browser.close();
})();

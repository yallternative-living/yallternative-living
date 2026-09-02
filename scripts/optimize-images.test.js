/**
 * @fileoverview Unit tests for scripts/optimize-images.js
 * Run: node scripts/optimize-images.test.js
 */

const fs = require("fs");

// Mocking 'sharp' module for optimizeOne testing
const Module = require("module");
const originalRequire = Module.prototype.require;

let mockedTasks = [];

Module.prototype.require = function (moduleName) {
  if (moduleName === "sharp") {
    const sharpMock = (srcPath) => {
      let currentWidth = null;

      const instance = {
        metadata: async () => ({ width: 1200, height: 1020 }),
        resize: (opts) => {
          currentWidth = opts.width;
          return instance;
        },
        webp: () => instance,
        avif: () => instance,
        toFile: async (outPath) => {
          mockedTasks.push({ srcPath, outPath, width: currentWidth });
          return { size: 5000 };
        }
      };
      return instance;
    };
    return sharpMock;
  }
  return originalRequire.apply(this, arguments);
};

const optimizeScript = require("./optimize-images.js");

let passed = 0;
let failed = 0;

function check(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

async function runTests() {
  console.log("Running optimize-images.js unit tests...\n");

  /* 1. shouldSkip */
  check(optimizeScript.shouldSkip("logo.jpg"), "shouldSkip skips logo.jpg");
  /* logo.png is deliberately NOT skipped any more (live audit 2026-09-02,
     H-1): skipping it shipped a 512x512, 201KB PNG into a 48x48 header box
     on every page. It gets its own 48/96/144 DPR ladder instead. */
  check(!optimizeScript.shouldSkip("logo.png"), "shouldSkip no longer skips logo.png");
  check(optimizeScript.shouldSkip("favicon.ico"), "shouldSkip skips favicon.ico");
  check(optimizeScript.shouldSkip("favicon-32x32.png"), "shouldSkip skips favicon variants");
  check(!optimizeScript.shouldSkip("product-1.jpg"), "shouldSkip includes product-1.jpg");
  check(!optimizeScript.shouldSkip("product-2.png"), "shouldSkip includes product-2.png");

  /* 2. loadExistingManifest */
  const originalExistsSync = fs.existsSync;
  fs.existsSync = (p) => {
    if (p.endsWith("image-manifest.js")) return false;
    return originalExistsSync(p);
  };

  const emptyManifest = optimizeScript.loadExistingManifest();
  check(
    Object.keys(emptyManifest).length === 0,
    "loadExistingManifest returns empty object if file is missing"
  );

  fs.existsSync = originalExistsSync;

  /* 3. writeManifest */
  const originalWriteFileSync = fs.writeFileSync;
  const originalMkdirSync = fs.mkdirSync;

  let writtenPath = null;
  let writtenData = null;
  fs.writeFileSync = (p, data) => {
    writtenPath = p;
    writtenData = data;
  };
  fs.mkdirSync = () => {}; // mock mkdirSync safely

  const testManifest = {
    "assets/img/test.jpg": {
      key: "assets/img/test.jpg",
      width: 1200,
      height: 1020,
      size: 15000,
      variants: { avif: [], webp: [] }
    }
  };

  optimizeScript.writeManifest(testManifest);
  check(writtenPath.endsWith("image-manifest.js"), "writeManifest writes to correct path");
  check(writtenData.includes("window.YL_IMAGES ="), "writeManifest includes window assignment");
  check(
    writtenData.includes('"width": 1200'),
    "writeManifest serializes manifest object correctly"
  );

  fs.writeFileSync = originalWriteFileSync;
  fs.mkdirSync = originalMkdirSync;

  /* 4. optimizeOne */
  const originalStatSync = fs.statSync;
  fs.statSync = () => {
    return { size: 102400 }; // Mock stat size for original image
  };

  mockedTasks = []; // reset

  const result = await optimizeScript.optimizeOne("mock-product.jpg");

  check(result.key === "assets/img/mock-product.jpg", "optimizeOne returns correct key");
  check(result.width === 1200, "optimizeOne returns correct source width");
  check(result.height === 1020, "optimizeOne returns correct source height");
  check(result.size === 102400, "optimizeOne returns correct source size");

  // Verify tasks generated

  // 480 webp + avif, 800 webp + avif, 1200 webp + avif = 6 total tasks
  check(mockedTasks.length === 6, "optimizeOne generates expected number of resizing tasks");

  // Check output paths in manifest result
  const avifFiles = result.variants.avif.map((v) => v.file);
  const webpFiles = result.variants.webp.map((v) => v.file);

  check(
    avifFiles.includes("assets/img/mock-product-480.avif"),
    "optimizeOne manifest includes 480w avif"
  );
  check(
    avifFiles.includes("assets/img/mock-product-800.avif"),
    "optimizeOne manifest includes 800w avif"
  );
  check(
    avifFiles.includes("assets/img/mock-product.avif"),
    "optimizeOne manifest includes full-size avif"
  );

  check(
    webpFiles.includes("assets/img/mock-product-480.webp"),
    "optimizeOne manifest includes 480w webp"
  );
  check(
    webpFiles.includes("assets/img/mock-product-800.webp"),
    "optimizeOne manifest includes 800w webp"
  );
  check(
    webpFiles.includes("assets/img/mock-product.webp"),
    "optimizeOne manifest includes full-size webp"
  );

  fs.statSync = originalStatSync;

  console.log(`\noptimize-images.test.js: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});

/**
 * @fileoverview Service-worker fetch-strategy unit tests.
 *
 * sw.js has no Node entry point of its own -- it is a bare script that
 * registers listeners on `self` at load time. That is still a testable seam:
 * evaluate it inside a `vm` context carrying a stub `self`/`caches`/`fetch`,
 * capture the listeners it registers, and drive them with synthetic events.
 *
 * The assertion that matters most here is the `cache: "reload"` one. The
 * network-first branch for HTML/JS/CSS used to call a plain `fetch()`, which
 * consults the browser's own HTTP cache first -- and netlify.toml serves
 * /assets/js/* and /assets/css/* with `max-age=604800` at a *static* URL
 * (`main.js?v=2.0` is a hand-set string, not a per-deploy hash). A shopper who
 * had visited in the previous seven days therefore had the service worker's
 * "network" leg answered out of their own disk cache, and the worker then
 * wrote those stale bytes into its freshly-rotated CACHE_NAME. The digest
 * cache-name rotation in scripts/build-site-data.js was being defeated by the
 * very fetch meant to populate it. Without a test this is invisible: every
 * existing gate passes with or without the flag.
 *
 * Run: node scripts/service-worker.test.js
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const SW_PATH = path.join(ROOT, "sw.js");
const ORIGIN = "https://yallternativeliving.com";

let passed = 0;
let failed = 0;
const queue = [];

/* Tests are queued and awaited one at a time by run() at the bottom. An
   earlier draft of this file called fn() and counted a pass immediately,
   which meant every assertion inside a returned promise was scored before it
   had run -- the exact "check that stops checking" shape AGENTS.md warns
   about. Nothing here reports a pass until its promise has settled. */
function it(name, fn) {
  queue.push({ name, fn });
}

async function run() {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed++;
      console.log(`  PASS  ${name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${name}`);
      console.log(`        ${err.message}`);
    }
  }
  console.log(`\n==================================================`);
  console.log(`Service worker tests: ${passed} passed, ${failed} failed.`);
  console.log(`==================================================\n`);
  if (!passed && !failed) {
    console.log("No service-worker assertions ran at all -- treating as a failure.");
    process.exitCode = 1;
    return;
  }
  if (failed > 0) process.exitCode = 1;
}

/**
 * Loads sw.js into a fresh sandbox and returns the harness: the registered
 * listeners, the calls made to fetch/caches, and the cache contents.
 */
function loadServiceWorker(options) {
  options = options || {};
  const source = fs.readFileSync(SW_PATH, "utf8");
  assert.ok(source.length > 0, "sw.js is empty -- nothing to test");

  const listeners = {};
  const fetchCalls = [];
  const cachePuts = [];
  const cacheStore = options.cacheStore || {};
  const deletedCaches = [];
  let addAllArgs = null;
  const addedUrls = [];
  const failedAdds = [];
  let claimed = false;
  let skippedWaiting = false;
  let preloadEnabled = false;

  function makeResponse(body, status) {
    return {
      __body: body,
      status: typeof status === "number" ? status : 200,
      clone() {
        return makeResponse(body, status);
      }
    };
  }

  const caches = {
    open() {
      return Promise.resolve({
        addAll(list) {
          addAllArgs = list;
          return Promise.resolve();
        },
        /* One entry can be made to fail, the way a host answering a precached
           URL with a non-2xx status makes it fail in production. */
        add(url) {
          if (options.failToAdd && String(url) === options.failToAdd) {
            failedAdds.push(String(url));
            return Promise.reject(new TypeError("Request failed"));
          }
          addedUrls.push(String(url));
          return Promise.resolve();
        },
        put(request, response) {
          cachePuts.push({ url: String(request.url || request), response });
          return Promise.resolve();
        },
        /* Real Cache instances have their own match(), separate from the
           top-level caches.match() below -- sw.js's activate handler opens
           the cache and calls match() on it directly to check whether
           /offline.html survived install, without needing to know this
           worker's own CACHE_NAME is also the one caches.match() searches. */
        match(request) {
          const key = String(request.url || request);
          return Promise.resolve(cacheStore[key] || undefined);
        }
      });
    },
    match(request) {
      const key = String(request.url || request);
      return Promise.resolve(cacheStore[key] || undefined);
    },
    keys() {
      return Promise.resolve(options.existingCacheNames || []);
    },
    delete(name) {
      deletedCaches.push(name);
      return Promise.resolve(true);
    }
  };

  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    URL,
    Promise,
    Request: function Request(url, init) {
      this.url = String(url);
      this.init = init;
      this.mode = (init && init.mode) || "cors";
      this.method = (init && init.method) || "GET";
      this.headers = { get: () => null };
    },
    /* A real constructor, not just the static .error() this harness used to
       stub alone: sw.js's synthesized offline fallback calls `new
       Response(html, { status, headers })` directly. */
    Response: (function () {
      function ResponseCtor(body, init) {
        this.__body = body;
        this.status = (init && init.status) || 200;
        this.headers = (init && init.headers) || {};
      }
      ResponseCtor.error = function () {
        return { __networkError: true };
      };
      return ResponseCtor;
    })(),
    caches,
    fetch(request, init) {
      fetchCalls.push({ url: String(request.url || request), init: init || null });
      if (options.networkFails) return Promise.reject(new Error("offline"));
      return Promise.resolve(makeResponse("fresh:" + String(request.url || request), 200));
    },
    self: {
      location: { origin: ORIGIN },
      addEventListener(type, handler) {
        listeners[type] = handler;
      },
      skipWaiting() {
        skippedWaiting = true;
        return Promise.resolve();
      },
      clients: {
        claim() {
          claimed = true;
          return Promise.resolve();
        }
      },
      registration: options.noPreload
        ? {}
        : {
            navigationPreload: {
              enable() {
                preloadEnabled = true;
                return Promise.resolve();
              }
            }
          }
    }
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "sw.js" });

  return {
    source,
    listeners,
    fetchCalls,
    cachePuts,
    deletedCaches,
    makeResponse,
    get addAllArgs() {
      return addAllArgs;
    },
    get addedUrls() {
      return addedUrls;
    },
    get failedAdds() {
      return failedAdds;
    },
    get claimed() {
      return claimed;
    },
    get skippedWaiting() {
      return skippedWaiting;
    },
    get preloadEnabled() {
      return preloadEnabled;
    }
  };
}

/** Builds a synthetic FetchEvent and returns { event, responded } . */
function makeFetchEvent(sw, url, opts) {
  opts = opts || {};
  const responses = [];
  const waits = [];
  return {
    responses,
    waits,
    event: {
      request: {
        url,
        method: opts.method || "GET",
        mode: opts.mode || "no-cors",
        headers: { get: (n) => (n === "accept" ? opts.accept || null : null) }
      },
      preloadResponse: Object.prototype.hasOwnProperty.call(opts, "preloadResponse")
        ? Promise.resolve(opts.preloadResponse)
        : Promise.resolve(undefined),
      respondWith(p) {
        responses.push(p);
      },
      waitUntil(p) {
        waits.push(p);
      }
    }
  };
}

console.log("\nService worker (sw.js) fetch strategy\n");

/* ---------- 1. The subject exists and registers what we think it does ---- */
it("sw.js registers install, activate and fetch listeners", () => {
  const sw = loadServiceWorker();
  ["install", "activate", "fetch"].forEach((type) => {
    assert.strictEqual(
      typeof sw.listeners[type],
      "function",
      `no ${type} listener registered by sw.js`
    );
  });
});

it("install precaches a non-empty ASSETS_TO_CACHE including the search index", async () => {
  const sw = loadServiceWorker();
  const ev = makeFetchEvent(sw, ORIGIN + "/");
  sw.listeners.install(ev.event);
  return Promise.all(ev.waits).then(() => {
    assert.strictEqual(
      sw.addAllArgs,
      null,
      "install used cache.addAll() -- it is all-or-nothing, so one URL the host " +
        "answers with a non-2xx status empties the entire precache (see below)"
    );
    assert.ok(sw.addedUrls.length > 20, "precache list is suspiciously short");
    assert.ok(
      sw.addedUrls.indexOf("/assets/js/search-data.js") !== -1,
      "precache list lost /assets/js/search-data.js (scripts/qa-check.js asserts this too)"
    );
    assert.ok(sw.skippedWaiting, "install did not call skipWaiting()");
  });
});

/* The production bug this replaced. '/404.html' was on the precache list, and
   Netlify answers a direct request for the not-found page with a 404 status,
   so cache.addAll() rejected and precached NOTHING -- swallowed into a console
   warning while the worker installed and reported healthy. Verified live on
   2026-09-03: the cache held only pages the visitor had already opened, and
   /offline.html was absent. One unreachable entry must cost one entry. */
it("one unreachable asset does not empty the whole precache", async () => {
  const sw = loadServiceWorker({ failToAdd: "/offline.html" });
  const ev = makeFetchEvent(sw, ORIGIN + "/");
  sw.listeners.install(ev.event);
  return Promise.all(ev.waits).then(() => {
    assert.deepStrictEqual(
      sw.failedAdds,
      ["/offline.html"],
      "the harness did not exercise a failing precache entry"
    );
    assert.ok(
      sw.addedUrls.length > 20,
      `a single failing entry took the precache down to ${sw.addedUrls.length} asset(s)`
    );
    assert.ok(
      sw.addedUrls.indexOf("/") !== -1,
      "the app shell was lost alongside the failing entry"
    );
    assert.ok(sw.skippedWaiting, "install did not call skipWaiting() after a failed add");
  });
});

/* The list itself: the site's own 404 page cannot be precached, because the
   host serves it with a 404 status by definition. qa-check.js asserts this
   statically too; here it is asserted against what install actually adds. */
it("the precache list does not include the site's 404 page", async () => {
  const sw = loadServiceWorker();
  const ev = makeFetchEvent(sw, ORIGIN + "/");
  sw.listeners.install(ev.event);
  return Promise.all(ev.waits).then(() => {
    assert.strictEqual(
      sw.addedUrls.indexOf("/404.html"),
      -1,
      "/404.html is back on the precache list -- the host answers it 404, so it " +
        "can never be cached, and it used to take the whole batch with it"
    );
    assert.ok(
      sw.addedUrls.indexOf("/offline.html") !== -1,
      "/offline.html must stay precached -- it is what the worker serves when the network is gone"
    );
  });
});

/* ---------- 2. The /api/ and /.netlify/ bypass (C-3) stays intact -------- */
["/api/checkout", "/.netlify/functions/gift-card-balance"].forEach((p) => {
  it(`fetch handler never intercepts ${p}`, () => {
    const sw = loadServiceWorker();
    const ev = makeFetchEvent(sw, ORIGIN + p, { accept: "application/json" });
    sw.listeners.fetch(ev.event);
    assert.strictEqual(
      ev.responses.length,
      0,
      "respondWith() was called for a dynamic endpoint -- it must be left to the network"
    );
    assert.strictEqual(sw.fetchCalls.length, 0, "the worker started a fetch for a bypassed path");
    assert.strictEqual(sw.cachePuts.length, 0, "the worker wrote a dynamic response to the cache");
  });
});

it("non-GET requests are ignored outright", () => {
  const sw = loadServiceWorker();
  const ev = makeFetchEvent(sw, ORIGIN + "/shop.html", { method: "POST" });
  sw.listeners.fetch(ev.event);
  assert.strictEqual(ev.responses.length, 0, "respondWith() was called for a POST");
});

/* ---------- 3. The fix under test --------------------------------------- */
[
  ["/assets/js/main.js?v=2.0", "JS"],
  ["/assets/css/styles.css?v=2.0", "CSS"]
].forEach(([p, label]) => {
  it(`network-first ${label} fetch bypasses the browser HTTP cache (cache: "reload")`, async () => {
    const sw = loadServiceWorker();
    const ev = makeFetchEvent(sw, ORIGIN + p);
    sw.listeners.fetch(ev.event);
    return Promise.all(ev.responses).then(() => {
      assert.strictEqual(sw.fetchCalls.length, 1, `expected exactly one fetch for ${p}`);
      const init = sw.fetchCalls[0].init;
      assert.ok(
        init && init.cache === "reload",
        `fetch() for ${p} was called without { cache: "reload" } -- a <=7-day-old ` +
          "browser HTTP cache entry can satisfy it and defeat the digest cache rotation"
      );
    });
  });
});

it("a navigation with no preload response also bypasses the HTTP cache", async () => {
  const sw = loadServiceWorker();
  const ev = makeFetchEvent(sw, ORIGIN + "/shop.html", {
    mode: "navigate",
    accept: "text/html"
  });
  sw.listeners.fetch(ev.event);
  return Promise.all(ev.responses).then(() => {
    assert.strictEqual(sw.fetchCalls.length, 1);
    assert.ok(sw.fetchCalls[0].init && sw.fetchCalls[0].init.cache === "reload");
  });
});

it("navigation preload is still used untouched when the browser supplies one", async () => {
  const sw = loadServiceWorker();
  const preload = { status: 200, __body: "preloaded", clone: () => ({ __body: "preloaded" }) };
  const ev = makeFetchEvent(sw, ORIGIN + "/about.html", {
    mode: "navigate",
    accept: "text/html",
    preloadResponse: preload
  });
  sw.listeners.fetch(ev.event);
  return Promise.all(ev.responses).then(([res]) => {
    assert.strictEqual(sw.fetchCalls.length, 0, "a second fetch was started despite a preload");
    assert.strictEqual(res.__body, "preloaded");
  });
});

it("the network-first response is written to the cache under a query-stripped key", async () => {
  const sw = loadServiceWorker();
  const ev = makeFetchEvent(sw, ORIGIN + "/assets/js/main.js?v=2.0");
  sw.listeners.fetch(ev.event);
  return Promise.all(ev.responses).then(() =>
    new Promise((r) => setTimeout(r, 0)).then(() => {
      assert.strictEqual(sw.cachePuts.length, 1, "expected one cache.put");
      assert.strictEqual(sw.cachePuts[0].url, ORIGIN + "/assets/js/main.js");
    })
  );
});

it("offline falls back to the cached copy rather than erroring", async () => {
  const cached = { __body: "cached main.js", status: 200 };
  const sw = loadServiceWorker({
    networkFails: true,
    cacheStore: { [ORIGIN + "/assets/js/main.js"]: cached }
  });
  const ev = makeFetchEvent(sw, ORIGIN + "/assets/js/main.js?v=2.0");
  sw.listeners.fetch(ev.event);
  return Promise.all(ev.responses).then(([res]) => {
    assert.strictEqual(res.__body, "cached main.js");
  });
});

/* rendered audit M-? (2026-09-03): a host answering /offline.html with a
   non-2xx at install left it out of the precache. The old fallback chain
   then tried caches.match('/index.html') -- but index.html's asset links
   are root-RELATIVE, so serving it under any other path (a product page, a
   typo) resolved them against the wrong directory and rendered raw,
   unstyled markup. A synthesized, fully self-contained page replaces that
   index.html leg entirely. */
it("an offline navigation with /offline.html missing gets the synthesized fallback, not index.html", async () => {
  const sw = loadServiceWorker({
    networkFails: true,
    // Neither the requested page nor /offline.html is cached; index.html
    // IS, so this also proves it is no longer consulted.
    cacheStore: { "/index.html": { __body: "raw index.html markup", status: 200 } }
  });
  const ev = makeFetchEvent(sw, ORIGIN + "/products/never-visited.html", {
    mode: "navigate"
  });
  sw.listeners.fetch(ev.event);
  return Promise.all(ev.responses).then(([res]) => {
    assert.ok(
      !res.__networkError,
      "fell through to Response.error() instead of the synthesized page"
    );
    assert.notStrictEqual(
      res.__body,
      "raw index.html markup",
      "served cached index.html under the wrong path -- exactly the unstyled-page bug"
    );
    assert.ok(/You're offline/.test(res.__body), "synthesized fallback does not say it's offline");
    assert.ok(/href="\/"/.test(res.__body), "synthesized fallback has no link home");
    assert.strictEqual(res.status, 200);
    assert.ok(
      !/href="assets\//.test(res.__body) && !/src="assets\//.test(res.__body),
      "synthesized fallback must not reference any root-relative asset -- the whole point is a page nothing else can break"
    );
  });
});

it("an offline navigation still prefers the cached /offline.html page over the synthesized one", async () => {
  const offlinePage = { __body: "the real offline.html", status: 200 };
  const sw = loadServiceWorker({
    networkFails: true,
    cacheStore: { "/offline.html": offlinePage }
  });
  const ev = makeFetchEvent(sw, ORIGIN + "/products/never-visited.html", {
    mode: "navigate"
  });
  sw.listeners.fetch(ev.event);
  return Promise.all(ev.responses).then(([res]) => {
    assert.strictEqual(res.__body, "the real offline.html");
  });
});

/* ---------- 4. The stale-while-revalidate branch is left alone ---------- */
it("images keep the plain stale-while-revalidate fetch (no cache override)", async () => {
  const sw = loadServiceWorker();
  const ev = makeFetchEvent(sw, ORIGIN + "/assets/img/logo.png");
  sw.listeners.fetch(ev.event);
  return Promise.all(ev.responses).then(() => {
    assert.strictEqual(sw.fetchCalls.length, 1);
    assert.strictEqual(
      sw.fetchCalls[0].init,
      null,
      "the SWR branch should keep using the default cache mode -- its freshness " +
        "window is already bounded by re-fetching on every request"
    );
  });
});

it("cross-origin requests are not intercepted", () => {
  const sw = loadServiceWorker();
  const ev = makeFetchEvent(sw, "https://embed.tawk.to/widget.js");
  sw.listeners.fetch(ev.event);
  assert.strictEqual(ev.responses.length, 0);
});

/* ---------- 5. activate still purges old caches and claims clients ------ */
it("activate enables navigation preload, purges stale caches and claims clients", async () => {
  const sw = loadServiceWorker({ existingCacheNames: ["yallternative-cache-vOLD", "other"] });
  const ev = makeFetchEvent(sw, ORIGIN + "/");
  sw.listeners.activate(ev.event);
  return Promise.all(ev.waits).then(() => {
    assert.ok(sw.preloadEnabled, "navigationPreload.enable() was not called");
    assert.deepStrictEqual(sw.deletedCaches.sort(), ["other", "yallternative-cache-vOLD"]);
    assert.ok(sw.claimed, "clients.claim() was not called");
  });
});

/* /offline.html is the one asset this worker exists to have ready. install's
   per-asset add() already survives it failing (see the tests above); this
   retries it on every activate too, so a precache that came up without it
   self-heals the next time the worker updates rather than staying broken
   until the site's next deploy bumps CACHE_NAME. */
it("activate retries precaching /offline.html when it is missing from the cache", async () => {
  const sw = loadServiceWorker({ cacheStore: {} });
  const ev = makeFetchEvent(sw, ORIGIN + "/");
  sw.listeners.activate(ev.event);
  return Promise.all(ev.waits).then(() => {
    assert.ok(
      sw.addedUrls.indexOf("/offline.html") !== -1,
      "activate did not retry adding the missing /offline.html to the cache"
    );
  });
});

it("activate does not re-add /offline.html when it is already cached", async () => {
  const sw = loadServiceWorker({
    cacheStore: { "/offline.html": { __body: "already cached", status: 200 } }
  });
  const ev = makeFetchEvent(sw, ORIGIN + "/");
  sw.listeners.activate(ev.event);
  return Promise.all(ev.waits).then(() => {
    assert.strictEqual(
      sw.addedUrls.indexOf("/offline.html"),
      -1,
      "activate re-fetched /offline.html even though it was already cached"
    );
  });
});

it("activate survives the /offline.html retry itself failing", async () => {
  const sw = loadServiceWorker({ cacheStore: {}, failToAdd: "/offline.html" });
  const ev = makeFetchEvent(sw, ORIGIN + "/");
  sw.listeners.activate(ev.event);
  return Promise.all(ev.waits).then(() => {
    assert.deepStrictEqual(sw.failedAdds, ["/offline.html"]);
    assert.ok(sw.claimed, "a failed retry must not stop clients.claim() from running");
  });
});

run();

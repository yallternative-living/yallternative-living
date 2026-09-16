const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error("FAIL:", label);
  }
}

function makeD1(dbSync) {
  return {
    prepare(sql) {
      const stmt = dbSync.prepare(sql);
      return {
        bind(...args) {
          return {
            async run() {
              const info = stmt.run(...args);
              return { success: true, meta: { changes: info.changes } };
            },
            async all() {
              const results = stmt.all(...args);
              return { success: true, results };
            },
            async first() {
              const result = stmt.get(...args);
              return result || null;
            }
          };
        },
        async run() {
          const info = stmt.run();
          return { success: true, meta: { changes: info.changes } };
        },
        async all() {
          const results = stmt.all();
          return { success: true, results };
        },
        async first() {
          const result = stmt.get();
          return result || null;
        }
      };
    },
    exec(sql) {
      dbSync.exec(sql);
    }
  };
}

/**
 * A stand-in for the Workers Rate Limiting binding (`env.RATE_LIMITER`):
 * records every key it is asked about and denies once `denyAfter` checks
 * have been made, so a test can prove the counter runs on every request.
 */
function makeLimiter(denyAfter = Infinity) {
  const calls = [];
  return {
    calls,
    async limit({ key }) {
      calls.push(key);
      return { success: calls.length <= denyAfter };
    }
  };
}

function request(headers, body) {
  return {
    headers: new Map(headers || []),
    json: async () => body
  };
}

const ORIGIN = "https://example.com";
// A push-capable owner token, a signed-in stranger, and one GitHub rejects.
const OWNER_TOKEN = "gho_ownerTokenAAAAAAAAAAAAAAAAAAAAAAAA";
const STRANGER_TOKEN = "gho_strangerTokenAAAAAAAAAAAAAAAAAAAA";
const REVOKED_TOKEN = "gho_revokedTokenAAAAAAAAAAAAAAAAAAAAA";
const AUTH = [["Authorization", "Bearer " + OWNER_TOKEN]];
const STRANGER_AUTH = [["Authorization", "Bearer " + STRANGER_TOKEN]];

/**
 * Stands in for api.github.com. Records each call so a test can prove the
 * Worker asked (or did not ask), and answers the three cases that matter:
 * push access, a read-only stranger on this PUBLIC repo (200 + push:false),
 * and a token GitHub refuses (401).
 */
function installGitHubStub(state) {
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    const href = String(url);
    if (href.startsWith("https://api.github.com/")) {
      state.calls.push({ url: href, options });
      if (state.fail) return { ok: false, status: state.fail, json: async () => ({}) };
      const token = String((options && options.headers && options.headers.Authorization) || "");
      if (token.includes(REVOKED_TOKEN)) {
        return { ok: false, status: 401, json: async () => ({ message: "Bad credentials" }) };
      }
      if (token.includes(STRANGER_TOKEN)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ permissions: { admin: false, push: false, pull: true } })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ permissions: { admin: true, push: true, pull: true } })
      };
    }
    return realFetch(url, options);
  };
  return () => {
    global.fetch = realFetch;
  };
}

async function main() {
  const { ensureSchema } = await import("file://" + process.cwd() + "/workers/state/migrations.js");
  const {
    handleUnfulfilledOrders,
    handleFulfillOrder,
    ADMIN_AUTH_RATE_LIMIT,
    FULFILLMENT_STATUSES
  } = await import("file://" + process.cwd() + "/workers/routes/fulfillment.js");
  const { SHIPPED_STATUSES } = await import(
    "file://" + process.cwd() + "/workers/routes/ship-notice.js"
  );

  const db = makeD1(new DatabaseSync(":memory:"));
  const env = {
    STATE_DB: db,
    STRIPE_SECRET_KEY: "sk_test_mock",
    // The admin gate fails CLOSED without a counter, so the baseline env
    // carries a permissive one; the fail-closed case is tested on its own.
    RATE_LIMITER: makeLimiter()
  };

  await ensureSchema(env.STATE_DB);

  // Setup: mock an unfulfilled order
  await env.STATE_DB.prepare(
    "INSERT INTO order_signals (order_id, email, email_hash, placed_at) VALUES (?, ?, ?, ?)"
  )
    .bind("cs_test_mock", "mock@example.com", "mockhash", 1700000000)
    .run();

  await env.STATE_DB.prepare(
    "INSERT INTO orders (session_id, email_hash, payment_intent, created, amount_total, currency, status, line_items_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(
      "cs_test_mock",
      "mockhash",
      "pi_3TestMock0000",
      1700000000,
      2000,
      "usd",
      "processing",
      "[]",
      1700000000
    )
    .run();

  /* ------------------------------------------------ constants */
  assert(
    Array.isArray(FULFILLMENT_STATUSES) &&
      FULFILLMENT_STATUSES.length === SHIPPED_STATUSES.length &&
      SHIPPED_STATUSES.every((v) => FULFILLMENT_STATUSES.includes(v)) &&
      !FULFILLMENT_STATUSES.includes("processing"),
    "FULFILLMENT_STATUSES is exactly SHIPPED_STATUSES (no revert to processing)"
  );

  /* ------------------------------------------------ GET /api/unfulfilled-orders: auth */
  const gh = { calls: [], fail: 0 };
  // Left installed for the whole run on purpose: the Stripe section below
  // captures this as its fall-through, so GitHub verification keeps working
  // there instead of depending on the token cache still being warm.
  installGitHubStub(gh);

  let unauthRes = await handleUnfulfilledOrders(request(), env, ORIGIN);
  assert(unauthRes.status === 401, "unfulfilled-orders rejects missing auth");
  assert(gh.calls.length === 0, "a missing token never reaches GitHub");

  // Anything that is not shaped like a GitHub token is refused locally, so a
  // flood of junk costs no API calls.
  for (const junk of ["wrong_password", "", "   ", "gho_short", "Basic gho_xxxx", "undefined"]) {
    const res = await handleUnfulfilledOrders(
      request([["Authorization", "Bearer " + junk]]),
      env,
      ORIGIN
    );
    assert(res.status === 401, `a malformed token (${JSON.stringify(junk)}) is refused`);
  }
  assert(gh.calls.length === 0, "no malformed token reached GitHub");

  const revokedRes = await handleUnfulfilledOrders(
    request([["Authorization", "Bearer " + REVOKED_TOKEN]]),
    env,
    ORIGIN
  );
  assert(revokedRes.status === 401, "a token GitHub refuses (401) is refused");

  // The repo is public, so a stranger's token also gets a 200 from GitHub --
  // with push:false. That, not the status code, is the boundary.
  const strangerRes = await handleUnfulfilledOrders(request(STRANGER_AUTH), env, ORIGIN);
  assert(strangerRes.status === 403, "a signed-in stranger without push access gets 403");
  const strangerBody = await strangerRes.json();
  assert(typeof strangerBody.error === "string", "403 carries the usual {error} shape");

  // Absent `permissions` must never be read as permission.
  {
    const noPerms = { calls: [], fail: 0 };
    const restoreNoPerms = installGitHubStub(noPerms);
    global.fetch = async (url) =>
      String(url).startsWith("https://api.github.com/")
        ? { ok: true, status: 200, json: async () => ({ name: "repo" }) }
        : { ok: false, status: 500, json: async () => ({}) };
    const res = await handleUnfulfilledOrders(
      request([["Authorization", "Bearer gho_noPermsTokenAAAAAAAAAAAAAAAAAAA"]]),
      env,
      ORIGIN
    );
    assert(res.status === 403, "a response with no permissions object is refused");
    restoreNoPerms();
  }

  // GitHub itself unreachable is a 503 about us, not a verdict on the token.
  {
    const down = { calls: [], fail: 500 };
    const restoreDown = installGitHubStub(down);
    const res = await handleUnfulfilledOrders(
      request([["Authorization", "Bearer gho_ghDownTokenAAAAAAAAAAAAAAAAAAAA"]]),
      env,
      ORIGIN
    );
    assert(res.status === 503, "GitHub being unreachable answers 503, not 200");
    restoreDown();
  }

  // The verified token is cached: a second call asks GitHub nothing more.
  {
    gh.calls.length = 0;
    await handleUnfulfilledOrders(request(AUTH), env, ORIGIN);
    const afterFirst = gh.calls.length;
    await handleUnfulfilledOrders(request(AUTH), env, ORIGIN);
    assert(afterFirst === 1, "the first verification calls GitHub once");
    assert(
      gh.calls.length === 1,
      "a repeat request inside the cache window calls GitHub again 0 times"
    );
    const call = gh.calls[0];
    assert(
      call.url === "https://api.github.com/repos/yallternative-living/yallternative-living",
      "verification reads the configured repo"
    );
    assert(
      call.options.headers["User-Agent"] && call.options.headers.Accept,
      "the GitHub call sends a User-Agent (api.github.com rejects requests without one) and Accept"
    );
    assert(
      call.options.headers.Authorization === "Bearer " + OWNER_TOKEN,
      "the caller's own token is what GitHub is asked about"
    );
  }

  // A rejected token is cached too, so a flood of the same bad token is cheap.
  {
    gh.calls.length = 0;
    await handleUnfulfilledOrders(request(STRANGER_AUTH), env, ORIGIN);
    await handleUnfulfilledOrders(request(STRANGER_AUTH), env, ORIGIN);
    assert(gh.calls.length === 0 || gh.calls.length === 1, "a repeated rejection is not re-asked");
  }

  // GITHUB_REPO is honoured, and a different repo is a different verdict.
  {
    gh.calls.length = 0;
    await handleUnfulfilledOrders(
      request([["Authorization", "Bearer gho_otherRepoTokenAAAAAAAAAAAAAAAA"]]),
      { ...env, GITHUB_REPO: "someone/else" },
      ORIGIN
    );
    assert(
      gh.calls.length === 1 && gh.calls[0].url.endsWith("/repos/someone/else"),
      "GITHUB_REPO picks the repository that is checked"
    );
  }

  let unfulfilledRes = await handleUnfulfilledOrders(request(AUTH), env, ORIGIN);
  assert(unfulfilledRes.status === 200, "unfulfilled-orders returns 200 with auth");
  let unfulfilledJson = await unfulfilledRes.json();
  assert(
    unfulfilledJson.orders && unfulfilledJson.orders.length === 1,
    "finds one processing order"
  );
  assert(
    unfulfilledJson.orders[0].email === "mock@example.com",
    "resolves email from order_signals"
  );
  assert(unfulfilledJson.orders[0].payment_intent === "pi_3TestMock0000", "returns payment intent");

  /* ------------------------------------------------ rate limiting */
  {
    const limiter = makeLimiter(0); // deny every check
    const limitedEnv = { ...env, RATE_LIMITER: limiter };
    const res = await handleUnfulfilledOrders(request(AUTH), limitedEnv, ORIGIN);
    assert(
      res.status === 429,
      "unfulfilled-orders answers 429 when the limiter denies, even with the right password"
    );
    const body = await res.json();
    assert(
      typeof body.error === "string" && body.error.length > 0,
      "429 carries the usual {error} shape"
    );
    assert(
      limiter.calls.length === 1 && limiter.calls[0] === "admin-auth",
      "limiter key is the one global bucket"
    );

    const postRes = await handleFulfillOrder(
      request(AUTH, { payment_intent: "pi_3TestMock0000", status: "shipped" }),
      limitedEnv,
      ORIGIN
    );
    assert(postRes.status === 429, "fulfill-order answers 429 when the limiter denies");
  }
  {
    // The counter runs on EVERY request, successful ones included, so a
    // guesser cannot keep the window open by interleaving valid calls.
    const limiter = makeLimiter(ADMIN_AUTH_RATE_LIMIT.limit);
    const limitedEnv = { ...env, RATE_LIMITER: limiter };
    const statuses = [];
    for (let i = 0; i < ADMIN_AUTH_RATE_LIMIT.limit; i++) {
      const headers = i % 2 === 0 ? AUTH : [["Authorization", "Bearer nope"]];
      statuses.push((await handleUnfulfilledOrders(request(headers), limitedEnv, ORIGIN)).status);
    }
    assert(
      statuses.every((s) => s === 200 || s === 401) &&
        statuses.includes(200) &&
        statuses.includes(401),
      "the first N requests are judged on the password alone"
    );
    const sixth = await handleUnfulfilledOrders(request(AUTH), limitedEnv, ORIGIN);
    assert(
      sixth.status === 429,
      "request N+1 in the window is refused before the password is read"
    );
    assert(
      limiter.calls.length === ADMIN_AUTH_RATE_LIMIT.limit + 1,
      "every request, pass or fail, counted once"
    );
  }
  {
    // The bucket must not be pickable by the caller: on the workers.dev
    // hostname a client sets X-Forwarded-For freely (routes/http.js), so a
    // per-IP key would hand a guesser a fresh budget per header value.
    const hdrLimiter = makeLimiter();
    const spoofs = [
      [["X-Forwarded-For", "198.51.100.7"]],
      [["X-Forwarded-For", "203.0.113.9, 198.51.100.7"]],
      [["CF-Connecting-IP", "192.0.2.4"]],
      [
        ["CF-Connecting-IP", "192.0.2.4"],
        ["X-Forwarded-For", "10.0.0.1, 192.0.2.4"]
      ]
    ];
    for (const extra of spoofs) {
      await handleUnfulfilledOrders(
        request([...AUTH, ...extra]),
        { ...env, RATE_LIMITER: hdrLimiter },
        ORIGIN
      );
    }
    assert(
      hdrLimiter.calls.length === spoofs.length &&
        hdrLimiter.calls.every((k) => k === "admin-auth"),
      "limiter key ignores X-Forwarded-For and CF-Connecting-IP entirely"
    );
  }
  {
    // Fails OPEN now: the credential is a GitHub token, not a guessable
    // secret, so a counter outage must not lock the owner out of shipping.
    // The GitHub check still decides, so an outage is not a way in.
    const noLimiterEnv = { ...env };
    delete noLimiterEnv.RATE_LIMITER;
    const res = await handleUnfulfilledOrders(request(AUTH), noLimiterEnv, ORIGIN);
    assert(res.status === 200, "no rate-limit backend still serves the owner (fail open)");
    const strangerNoLimiter = await handleUnfulfilledOrders(
      request(STRANGER_AUTH),
      noLimiterEnv,
      ORIGIN
    );
    assert(
      strangerNoLimiter.status === 403,
      "failing open on the limiter does not admit a caller without push access"
    );
    const anonNoLimiter = await handleUnfulfilledOrders(request(), noLimiterEnv, ORIGIN);
    assert(anonNoLimiter.status === 401, "failing open on the limiter still needs a token");
    // A Durable Object counter that throws is the same case.
    const brokenDoEnv = {
      ...noLimiterEnv,
      RATE_LIMIT_COUNTER: {
        idFromName: (n) => n,
        get: () => ({
          fetch: async () => {
            throw new Error("object reset");
          }
        })
      }
    };
    const errRes = await handleUnfulfilledOrders(request(AUTH), brokenDoEnv, ORIGIN);
    assert(errRes.status === 200, "a counter that throws does not block the owner");
  }

  /* ------------------------------------------------ POST /api/fulfill-order */
  let stripeCalls = [];
  const ogFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes("api.stripe.com")) {
      stripeCalls.push({ url: String(url), options });
      return { ok: true, json: async () => ({ id: "pi_3TestMock0000" }) };
    }
    return ogFetch(url, options);
  };

  async function expectClientError(body, label) {
    const before = stripeCalls.length;
    let status = null;
    try {
      const res = await handleFulfillOrder(request(AUTH, body), env, ORIGIN);
      status = res.status;
    } catch (err) {
      status =
        err && err.name === "ClientError" ? err.status || 400 : `threw ${err && err.message}`;
    }
    assert(status === 400, `${label} -> 400 (got ${status})`);
    assert(stripeCalls.length === before, `${label}: Stripe never called`);
  }

  try {
    const goodBody = {
      payment_intent: "pi_3TestMock0000",
      tracking_url: "https://track.it/123",
      status: "shipped"
    };

    // Auth on the POST
    let unauthFulfillRes = await handleFulfillOrder(request([], goodBody), env, ORIGIN);
    assert(unauthFulfillRes.status === 401, "fulfill-order rejects missing auth");
    const strangerPost = await handleFulfillOrder(
      request([["Authorization", "Bearer " + STRANGER_TOKEN]], goodBody),
      env,
      ORIGIN
    );
    assert(
      strangerPost.status === 403,
      "fulfill-order refuses a signed-in stranger without push access"
    );
    const noAuthPost = await handleFulfillOrder(request([], goodBody), env, ORIGIN);
    assert(noAuthPost.status === 401, "fulfill-order refuses a request with no token");
    assert(stripeCalls.length === 0, "no Stripe call before auth passes");

    // Validation
    await expectClientError(
      { ...goodBody, payment_intent: "pi_x/cancel" },
      'payment_intent "pi_x/cancel"'
    );
    await expectClientError(
      { ...goodBody, payment_intent: "../refunds" },
      'payment_intent "../refunds"'
    );
    await expectClientError({ ...goodBody, payment_intent: "" }, "empty payment_intent");
    await expectClientError({ ...goodBody, payment_intent: 42 }, "non-string payment_intent");
    await expectClientError(
      { ...goodBody, tracking_url: "javascript:alert(1)" },
      'tracking_url "javascript:alert(1)"'
    );
    await expectClientError(
      { ...goodBody, tracking_url: "not a url" },
      "tracking_url that is not a URL"
    );
    await expectClientError(
      { ...goodBody, tracking_url: "https://track.it/" + "a".repeat(500) },
      "tracking_url over 500 characters"
    );
    await expectClientError({ ...goodBody, status: "hacked" }, 'status "hacked"');
    await expectClientError({ ...goodBody, status: "refunded" }, 'status "refunded"');

    // A non-object body must not blow up in the handler
    {
      let status = null;
      try {
        status = (await handleFulfillOrder(request(AUTH, "just a string"), env, ORIGIN)).status;
      } catch (err) {
        status = err && err.name === "ClientError" ? 400 : `threw ${err && err.message}`;
      }
      assert(status === 400, `string JSON body -> 400 (got ${status})`);
    }
    {
      let status = null;
      try {
        const broken = {
          headers: new Map(AUTH),
          json: async () => {
            throw new SyntaxError("bad");
          }
        };
        status = (await handleFulfillOrder(broken, env, ORIGIN)).status;
      } catch (err) {
        status = err && err.name === "ClientError" ? 400 : `threw ${err && err.message}`;
      }
      assert(status === 400, `malformed JSON -> 400 (got ${status})`);
    }
    assert(stripeCalls.length === 0, "no Stripe call for any rejected body");

    // The happy path
    let fulfillRes = await handleFulfillOrder(request(AUTH, goodBody), env, ORIGIN);
    assert(fulfillRes.status === 200, "fulfill-order returns 200 with auth");

    assert(stripeCalls.length === 1, "stripePost was called");
    assert(
      stripeCalls[0].url.endsWith("/payment_intents/pi_3TestMock0000"),
      "called correct Stripe URL"
    );
    const sentBody = stripeCalls[0].options.body;
    assert(sentBody.includes("metadata%5Bfulfillment_status%5D=shipped"), "sent status correctly");
    assert(
      sentBody.includes("metadata%5Btracking_url%5D=https%3A%2F%2Ftrack.it%2F123"),
      "sent tracking url correctly"
    );
    assert(
      /metadata%5Bshipped_at%5D=\d{4}-\d{2}-\d{2}/.test(sentBody),
      "sent shipped_at as YYYY-MM-DD"
    );

    // The id is encoded on its way into the path (a regex-valid id never
    // needs it, but the precedent in stripe.js deleteCoupon is kept).
    stripeCalls = [];
    let upperRes = await handleFulfillOrder(
      request(AUTH, { payment_intent: "pi_3Abc9XyZ", status: "DELIVERED" }),
      env,
      ORIGIN
    );
    assert(upperRes.status === 200, "status is case-insensitive");
    assert(
      stripeCalls[0].url.endsWith("/payment_intents/" + encodeURIComponent("pi_3Abc9XyZ")),
      "path is encoded"
    );
    assert(
      stripeCalls[0].options.body.includes("metadata%5Bfulfillment_status%5D=delivered"),
      "status lower-cased"
    );
    assert(
      !stripeCalls[0].options.body.includes("tracking_url"),
      "no tracking_url key sent when none given"
    );

    // "processing" is not a fulfilment the dashboard may write: undoing a
    // shipment happens in the Stripe Dashboard. Refused before Stripe is called.
    stripeCalls = [];
    const revertRes = await handleFulfillOrder(
      request(AUTH, { payment_intent: "pi_3TestMock0000", status: "processing" }),
      env,
      ORIGIN
    ).catch((err) => ({ status: err.status || 400, clientError: true, message: err.message }));
    assert(
      revertRes.status === 400 && revertRes.clientError,
      "status processing is refused with a ClientError"
    );
    assert(stripeCalls.length === 0, "a refused status never reaches Stripe");

    // Stripe refusing the write is a 500, not a success.
    global.fetch = async (url) => {
      if (String(url).includes("api.stripe.com")) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: { message: "No such payment_intent" } })
        };
      }
      return ogFetch(url);
    };
    let refusedRes = await handleFulfillOrder(request(AUTH, goodBody), env, ORIGIN);
    assert(refusedRes.status === 500, "a Stripe refusal answers 500");
  } finally {
    global.fetch = ogFetch;
  }

  /* ------------------------------------------------ the dashboard page vs the /admin/* CSP */
  const html = fs.readFileSync(path.join(ROOT, "admin", "fulfillment.html"), "utf8");
  const pageScript = fs.readFileSync(path.join(ROOT, "admin", "fulfillment.js"), "utf8");
  const headers = fs.readFileSync(path.join(ROOT, "_headers"), "utf8");

  assert(
    html.length > 0 && pageScript.length > 0,
    "admin/fulfillment.html and admin/fulfillment.js exist"
  );
  const inlineScripts = html.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi) || [];
  assert(
    inlineScripts.length === 0,
    "fulfillment.html has no inline <script> body (the /admin/* CSP would block it)"
  );
  assert(
    /<script\s+src="fulfillment\.js"\s+defer><\/script>/.test(html),
    "fulfillment.html loads fulfillment.js"
  );
  assert(
    !/<[^>]*\son[a-z]+\s*=/i.test(html),
    "fulfillment.html has no inline on*= handler attributes"
  );
  assert(
    !/<script\s+src="(https?:)?\/\//i.test(html),
    "fulfillment.html loads no cross-origin scripts"
  );
  const adminCsp =
    (headers.split("/admin/*")[1] || "")
      .split("\n")
      .find((l) => /Content-Security-Policy/.test(l)) || "";
  assert(
    /script-src 'self'/.test(adminCsp),
    "/admin/* CSP allows same-origin scripts (fulfillment.js)"
  );
  assert(
    /style-src [^;]*'unsafe-inline'/.test(adminCsp),
    "/admin/* CSP allows the page's inline <style>"
  );
  assert(
    /connect-src [^;]*'self'/.test(adminCsp),
    "/admin/* CSP allows the same-origin /api fetches"
  );
  // The page holds no secret of its own: it reads the token Sveltia CMS
  // already stored and never writes storage. A setItem here would mean the
  // dashboard had started keeping a credential on the storefront origin.
  assert(
    !/(?:sessionStorage|localStorage)\.setItem/.test(pageScript) &&
      !/sessionStorage/.test(pageScript),
    "fulfillment.js never writes a credential to web storage"
  );
  assert(
    /localStorage\.getItem\(/.test(pageScript) && /sveltia-cms\.user/.test(pageScript),
    "fulfillment.js reads the CMS sign-in from sveltia-cms.user"
  );
  assert(
    /typeof\s+user\.token\s*!==\s*["']string["']/.test(pageScript),
    "fulfillment.js gates on a string token (Sveltia writes {} on sign-out)"
  );
  // Comments may still explain why the password went away; code may not ask
  // for one, and the Authorization header must carry the GitHub token.
  const scriptCode = pageScript.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert(
    !/prompt\(/.test(scriptCode) && !/password/i.test(scriptCode),
    "fulfillment.js code never asks for or handles a password"
  );
  assert(
    /Authorization["']?\s*:\s*["']Bearer ["']\s*\+\s*\(?\s*token/.test(scriptCode),
    "the Authorization header carries the GitHub token"
  );
  assert(
    /href="\/admin\/"/.test(pageScript),
    "fulfillment.js offers a link back to the CMS sign-in"
  );
  assert(!/sessionStorage|localStorage/.test(html), "fulfillment.html never touches web storage");
  assert(
    /addEventListener\(\s*["']submit["']/.test(pageScript),
    "fulfillment.js wires submit with addEventListener"
  );
  assert(
    !/id="lock-btn"/.test(html) && !/lock-btn/.test(pageScript),
    "the Lock button is gone: there is no secret left to forget"
  );
  assert(
    !/\$\{item\.quantity\}/.test(pageScript) && /Number\(item && item\.quantity\)/.test(pageScript),
    "quantity is coerced before render"
  );

  /* ---------------------------------------------- the ROUTER, not the handler
     Every assertion above calls the handler directly, which is how
     /unfulfilled-orders shipped 404ing for a day: the handler was correct,
     the GET branch was correct, and the route was missing from checkout.js's
     ROUTES table, so the router's `known` check refused it before either ran.
     These drive the real fetch() entry point so the wiring itself is covered. */
  const workerModule = await import("file://" + path.join(ROOT, "workers/checkout.js"));
  const worker = workerModule.default || workerModule;
  const routerEnv = { ...env, STATE_DB: null, STRIPE_SECRET_KEY: "" };
  const routerCtx = { waitUntil() {}, passThroughOnException() {} };

  for (const url of [
    "https://yallternativeliving.com/api/unfulfilled-orders",
    "https://yallternative-checkout.workers.dev/unfulfilled-orders"
  ]) {
    const res = await worker.fetch(
      new Request(url, { method: "GET", headers: { Origin: ORIGIN } }),
      routerEnv,
      routerCtx
    );
    assert(res.status !== 404, `the router knows GET ${url} (not a 404)`);
    const body = await res.json();
    assert(
      body && body.error !== "Not Found",
      `GET ${url} is answered by its handler, not the unknown-route branch`
    );
  }

  const postToGetRoute = await worker.fetch(
    new Request("https://yallternativeliving.com/api/unfulfilled-orders", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: "{}"
    }),
    routerEnv,
    routerCtx
  );
  assert(
    postToGetRoute.status === 405,
    "the router keeps /unfulfilled-orders GET-only (405 on POST)"
  );

  const fulfillRouted = await worker.fetch(
    new Request("https://yallternativeliving.com/api/fulfill-order", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ payment_intent: "pi_3TestMock0000", status: "shipped" })
    }),
    routerEnv,
    routerCtx
  );
  assert(fulfillRouted.status !== 404, "the router knows POST /api/fulfill-order");

  if (failed === 0) {
    console.log(`✓ worker-fulfillment.test.js passed (${passed} assertions)`);
  } else {
    console.error(`✗ ${failed} tests failed (${passed} passed)`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

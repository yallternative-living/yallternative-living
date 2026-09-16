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
const AUTH = [["Authorization", "Bearer secret_admin_pw"]];

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
    ADMIN_PASSWORD: "secret_admin_pw"
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
    ADMIN_AUTH_RATE_LIMIT &&
      ADMIN_AUTH_RATE_LIMIT.limit === 5 &&
      ADMIN_AUTH_RATE_LIMIT.period === 60,
    "ADMIN_AUTH_RATE_LIMIT is 5 attempts per 60 seconds"
  );
  assert(
    SHIPPED_STATUSES.every((s) => FULFILLMENT_STATUSES.includes(s)) &&
      FULFILLMENT_STATUSES.includes("processing") &&
      FULFILLMENT_STATUSES.length === SHIPPED_STATUSES.length + 1,
    "FULFILLMENT_STATUSES is SHIPPED_STATUSES plus processing"
  );

  /* ------------------------------------------------ GET /api/unfulfilled-orders: auth */
  let unauthRes = await handleUnfulfilledOrders(request(), env, ORIGIN);
  assert(unauthRes.status === 401, "unfulfilled-orders rejects missing auth");

  let wrongRes = await handleUnfulfilledOrders(
    request([["Authorization", "Bearer wrong_password"]]),
    env,
    ORIGIN
  );
  assert(wrongRes.status === 401, "unfulfilled-orders rejects a wrong password");

  let emptyRes = await handleUnfulfilledOrders(
    request([["Authorization", "Bearer "]]),
    env,
    ORIGIN
  );
  assert(emptyRes.status === 401, "unfulfilled-orders rejects an empty bearer token");

  let unsetRes = await handleUnfulfilledOrders(
    request([["Authorization", "Bearer "]]),
    { ...env, ADMIN_PASSWORD: undefined },
    ORIGIN
  );
  assert(unsetRes.status === 401, "ADMIN_PASSWORD unset: empty token is still refused");

  let unsetMatchRes = await handleUnfulfilledOrders(
    request([["Authorization", "Bearer undefined"]]),
    { ...env, ADMIN_PASSWORD: undefined },
    ORIGIN
  );
  assert(
    unsetMatchRes.status === 401,
    "ADMIN_PASSWORD unset: a token that stringifies the same is refused"
  );

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
      limiter.calls.length === 1 && /^admin-auth:/.test(limiter.calls[0]),
      "limiter key is admin-auth:<ip>"
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
    const ipLimiter = makeLimiter();
    await handleUnfulfilledOrders(
      request([...AUTH, ["X-Forwarded-For", "198.51.100.7"]]),
      { ...env, RATE_LIMITER: ipLimiter },
      ORIGIN
    );
    assert(ipLimiter.calls[0] === "admin-auth:198.51.100.7", "limiter is keyed by the client IP");
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
    let wrongFulfillRes = await handleFulfillOrder(
      request([["Authorization", "Bearer secret_admin_pw2"]], goodBody),
      env,
      ORIGIN
    );
    assert(
      wrongFulfillRes.status === 401,
      "fulfill-order rejects a wrong password (longer than the real one)"
    );
    let unsetFulfillRes = await handleFulfillOrder(
      request(AUTH, goodBody),
      { ...env, ADMIN_PASSWORD: "" },
      ORIGIN
    );
    assert(
      unsetFulfillRes.status === 401,
      "fulfill-order: ADMIN_PASSWORD unset refuses even a matching token"
    );
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

    // Reverting to processing: clears the shipped keys on Stripe and writes D1 now.
    await env.STATE_DB.prepare(
      "UPDATE orders SET status = 'shipped', tracking_url = 'https://x.y/z' WHERE payment_intent = ?"
    )
      .bind("pi_3TestMock0000")
      .run();
    stripeCalls = [];
    let revertRes = await handleFulfillOrder(
      request(AUTH, { payment_intent: "pi_3TestMock0000", status: "processing" }),
      env,
      ORIGIN
    );
    assert(revertRes.status === 200, "revert to processing is accepted");
    const revertBody = stripeCalls[0].options.body;
    assert(
      revertBody.includes("metadata%5Bfulfillment_status%5D=processing"),
      "revert sends processing"
    );
    assert(
      revertBody.includes("metadata%5Btracking_url%5D=&") ||
        revertBody.endsWith("metadata%5Btracking_url%5D="),
      "revert clears tracking_url"
    );
    assert(/metadata%5Bshipped_at%5D=(&|$)/.test(revertBody), "revert clears shipped_at");
    const row = await env.STATE_DB.prepare(
      "SELECT status, tracking_url FROM orders WHERE payment_intent = ?"
    )
      .bind("pi_3TestMock0000")
      .first();
    assert(
      row && row.status === "processing" && row.tracking_url === null,
      "revert is written to D1 immediately"
    );

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
  assert(
    !/sessionStorage|localStorage/.test(pageScript),
    "fulfillment.js never stores the password in web storage"
  );
  assert(!/sessionStorage|localStorage/.test(html), "fulfillment.html never touches web storage");
  assert(
    /addEventListener\(\s*["']submit["']/.test(pageScript),
    "fulfillment.js wires submit with addEventListener"
  );
  assert(
    /getElementById\(\s*["']lock-btn["']/.test(pageScript) && /id="lock-btn"/.test(html),
    "Lock button is wired"
  );
  assert(
    !/\$\{item\.quantity\}/.test(pageScript) && /Number\(item && item\.quantity\)/.test(pageScript),
    "quantity is coerced before render"
  );

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

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
// The owner's account, but a token minted with NO scopes -- what any "Sign in
// with GitHub" site holds. GitHub still reports push:true for the repo.
const NO_SCOPE_TOKEN = "gho_noScopeTokenAAAAAAAAAAAAAAAAAAAAA";
// A classic PAT scoped `repo`, issued by no OAuth app.
const PAT_TOKEN = "ghp_classicPatTokenAAAAAAAAAAAAAAAAAA";
const AUTH = [["Authorization", "Bearer " + OWNER_TOKEN]];
const STRANGER_AUTH = [["Authorization", "Bearer " + STRANGER_TOKEN]];

/**
 * What the GitHub stub knows about each token: whose it is, the scopes
 * GitHub reports for it, whether that account may push, and whether the
 * CMS's own OAuth app issued it. A token not listed here is one GitHub
 * refuses (401), like REVOKED_TOKEN.
 */
const TOKENS = {
  [OWNER_TOKEN]: { login: "shop-owner", scopes: "public_repo, read:user", push: true, app: true },
  [STRANGER_TOKEN]: { login: "stranger", scopes: "public_repo", push: false, app: true },
  [NO_SCOPE_TOKEN]: { login: "shop-owner", scopes: "", push: true, app: false },
  [PAT_TOKEN]: { login: "shop-owner", scopes: "repo", push: true, app: false }
};

/**
 * A fresh push-capable owner token. The Worker caches verdicts per token, so
 * a test that must reach the limiter or GitHub needs a token not seen yet.
 */
let freshCount = 0;
function freshOwnerToken(overrides) {
  freshCount++;
  const token = "gho_fresh" + String(freshCount).padStart(4, "0") + "A".repeat(28);
  TOKENS[token] = { ...TOKENS[OWNER_TOKEN], ...overrides };
  return token;
}

/** A well-formed token GitHub has never issued (401 at the first call). */
function unknownToken(i) {
  return "gho_unknown" + String(i).padStart(4, "0") + "A".repeat(28);
}

function bearer(token) {
  return [["Authorization", "Bearer " + token]];
}

function ghResponse(status, body, scopes) {
  const headers = { "Content-Type": "application/json" };
  if (scopes != null) headers["X-OAuth-Scopes"] = scopes;
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Stands in for api.github.com. Records each call so a test can prove the
 * Worker asked (or did not ask), and answers the three endpoints the Worker
 * uses: `GET /user` (login + the X-OAuth-Scopes header), `GET /repos/...`
 * (the account's `permissions`), and `POST /applications/{id}/token` (the
 * OAuth app check, answered only for the app credentials in
 * state.clientId / state.clientSecret and only for tokens that app issued).
 */
function installGitHubStub(state) {
  const realFetch = global.fetch;
  global.fetch = async (url, options) => {
    const href = String(url);
    if (!href.startsWith("https://api.github.com/")) return realFetch(url, options);
    state.calls.push({ url: href, options });
    if (state.fail) return ghResponse(state.fail, {});
    const auth = String((options && options.headers && options.headers.Authorization) || "");
    const route = href.slice("https://api.github.com".length);

    if (route.startsWith("/applications/")) {
      const expected = "Basic " + btoa(`${state.clientId}:${state.clientSecret}`);
      if (auth !== expected) return ghResponse(401, { message: "Bad credentials" });
      const info = TOKENS[JSON.parse(options.body).access_token];
      if (!info || !info.app) return ghResponse(404, { message: "Not Found" });
      return ghResponse(200, {
        scopes: info.scopes
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        user: { login: info.login }
      });
    }

    const info = TOKENS[auth.replace(/^Bearer /, "")];
    if (!info) return ghResponse(401, { message: "Bad credentials" });
    if (route === "/user") return ghResponse(200, { login: info.login }, info.scopes);
    if (route.startsWith("/repos/")) {
      // `noPerms`: a 200 with no permissions object at all.
      return ghResponse(
        200,
        info.noPerms
          ? { name: "repo" }
          : { permissions: { admin: info.push, push: info.push, pull: true } }
      );
    }
    return ghResponse(404, { message: "Not Found" });
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
    // A permissive counter, so the baseline env exercises the limiter path;
    // denying and absent counters are tested on their own below.
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

  // Anything that is not shaped like a classic GitHub token is refused
  // locally, so a flood of junk costs no API calls. Fine-grained and GitHub
  // App tokens are well-formed but report no scopes, so they are refused too.
  for (const junk of [
    "wrong_password",
    "",
    "   ",
    "gho_short",
    "Basic gho_xxxx",
    "undefined",
    "ghu_userToServerTokenAAAAAAAAAAAAAAAAA",
    "ghs_installationTokenAAAAAAAAAAAAAAAAA",
    "github_pat_11AAAAAAA0fineGrainedTokenAAAAAAAAAAAA"
  ]) {
    const res = await handleUnfulfilledOrders(
      request([["Authorization", "Bearer " + junk]]),
      env,
      ORIGIN
    );
    assert(res.status === 401, `a token of the wrong shape (${JSON.stringify(junk)}) is refused`);
  }
  assert(gh.calls.length === 0, "no wrongly shaped token reached GitHub");

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

  // THE account-vs-token hole: the owner's account can push, but this token
  // was minted with no scopes (any "Sign in with GitHub" site holds one).
  // GitHub still reports push:true on the repo, so the scope decides.
  {
    gh.calls.length = 0;
    const res = await handleUnfulfilledOrders(request(bearer(NO_SCOPE_TOKEN)), env, ORIGIN);
    assert(res.status === 403, "an owner token without public_repo/repo scope is refused (403)");
    assert(
      gh.calls.length === 1 && gh.calls[0].url === "https://api.github.com/user",
      "a token without the scope is refused before the repository is even asked"
    );
  }
  {
    const res = await handleUnfulfilledOrders(request(bearer(PAT_TOKEN)), env, ORIGIN);
    assert(res.status === 200, "a classic PAT scoped `repo` on a push account is accepted");
  }

  // Absent `permissions` must never be read as permission.
  {
    const token = freshOwnerToken({ noPerms: true });
    const res = await handleUnfulfilledOrders(request(bearer(token)), env, ORIGIN);
    assert(res.status === 403, "a response with no permissions object is refused");
  }

  // GitHub itself unreachable is a 503 about us, not a verdict on the token.
  {
    gh.fail = 500;
    const token = freshOwnerToken();
    const res = await handleUnfulfilledOrders(request(bearer(token)), env, ORIGIN);
    assert(res.status === 503, "GitHub being unreachable answers 503, not 200");
    gh.fail = 0;
    const again = await handleUnfulfilledOrders(request(bearer(token)), env, ORIGIN);
    assert(again.status === 200, "a 503 is never cached: the next request asks GitHub again");
  }

  // The verified token is cached: a second call asks GitHub nothing more.
  {
    gh.calls.length = 0;
    await handleUnfulfilledOrders(request(AUTH), env, ORIGIN);
    const afterFirst = gh.calls.length;
    await handleUnfulfilledOrders(request(AUTH), env, ORIGIN);
    assert(afterFirst === 2, "the first verification asks GitHub twice (/user, then the repo)");
    assert(
      gh.calls.length === 2,
      "a repeat request inside the cache window calls GitHub again 0 times"
    );
    assert(gh.calls[0].url === "https://api.github.com/user", "identity and scopes come first");
    const call = gh.calls[1];
    assert(
      call.url === "https://api.github.com/repos/yallternative-living/yallternative-living",
      "verification reads the configured repo"
    );
    assert(
      call.options.headers["User-Agent"] && call.options.headers.Accept,
      "the GitHub call sends a User-Agent (api.github.com rejects requests without one) and Accept"
    );
    assert(
      gh.calls.every((c) => c.options.headers.Authorization === "Bearer " + OWNER_TOKEN),
      "the caller's own token is what GitHub is asked about"
    );
  }

  // A rejected token is cached too, so a flood of the same bad token is cheap.
  {
    gh.calls.length = 0;
    await handleUnfulfilledOrders(request(STRANGER_AUTH), env, ORIGIN);
    await handleUnfulfilledOrders(request(STRANGER_AUTH), env, ORIGIN);
    assert(gh.calls.length === 0, "a repeated rejection is not re-asked");
  }

  // GITHUB_REPO is honoured, and a different repo is a different verdict.
  {
    gh.calls.length = 0;
    await handleUnfulfilledOrders(
      request(bearer(freshOwnerToken())),
      { ...env, GITHUB_REPO: "someone/else" },
      ORIGIN
    );
    assert(
      gh.calls.length === 2 && gh.calls[1].url.endsWith("/repos/someone/else"),
      "GITHUB_REPO picks the repository that is checked"
    );
  }

  /* ------------------------------------------------ the CMS OAuth app pin */
  {
    gh.clientId = "Iv1.cmsapp";
    gh.clientSecret = "s3cret";
    const pinned = { ...env, GITHUB_CLIENT_ID: "Iv1.cmsapp", GITHUB_CLIENT_SECRET: "s3cret" };

    gh.calls.length = 0;
    const ownerRes = await handleUnfulfilledOrders(
      request(bearer(freshOwnerToken())),
      pinned,
      ORIGIN
    );
    assert(ownerRes.status === 200, "pinned: a token the CMS app issued is accepted");
    const appCall = gh.calls[0];
    assert(
      appCall.url === "https://api.github.com/applications/Iv1.cmsapp/token" &&
        appCall.options.method === "POST" &&
        appCall.options.headers.Authorization === "Basic " + btoa("Iv1.cmsapp:s3cret"),
      "pinned: the token is checked with POST /applications/{client_id}/token as the app"
    );
    assert(
      !gh.calls.some((c) => c.url.endsWith("/user")),
      "pinned: /user is not needed (the app check returns login and scopes)"
    );

    const otherApp = await handleUnfulfilledOrders(
      request(bearer(freshOwnerToken({ app: false }))),
      pinned,
      ORIGIN
    );
    assert(
      otherApp.status === 401,
      "pinned: another app's token is refused even with public_repo scope and push access"
    );
    const pat = await handleUnfulfilledOrders(
      request(bearer(freshOwnerToken({ app: false, scopes: "repo" }))),
      pinned,
      ORIGIN
    );
    assert(pat.status === 401, "pinned: a classic PAT (issued by no app) is refused");
    const noScope = await handleUnfulfilledOrders(
      request(bearer(freshOwnerToken({ scopes: "" }))),
      pinned,
      ORIGIN
    );
    assert(noScope.status === 403, "pinned: the app's own token still needs a push scope");

    gh.calls.length = 0;
    const wrongSecretToken = freshOwnerToken();
    const wrongSecret = await handleUnfulfilledOrders(
      request(bearer(wrongSecretToken)),
      { ...pinned, GITHUB_CLIENT_SECRET: "stale" },
      ORIGIN
    );
    assert(wrongSecret.status === 503, "pinned: wrong app credentials are our problem (503)");
    const afterFix = await handleUnfulfilledOrders(
      request(bearer(wrongSecretToken)),
      pinned,
      ORIGIN
    );
    assert(afterFix.status === 200, "pinned: a 503 from bad app credentials is not cached");

    gh.calls.length = 0;
    const halfConfigured = { ...env, GITHUB_CLIENT_ID: "Iv1.cmsapp" };
    const half = await handleUnfulfilledOrders(
      request(bearer(freshOwnerToken())),
      halfConfigured,
      ORIGIN
    );
    assert(half.status === 503, "an app id without its secret fails closed (503)");
    assert(gh.calls.length === 0, "half a configuration never asks GitHub");
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
    const res = await handleUnfulfilledOrders(
      request(bearer(freshOwnerToken())),
      limitedEnv,
      ORIGIN
    );
    assert(res.status === 429, "a token not yet verified gets 429 when the limiter denies");
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
      request(bearer(freshOwnerToken()), { payment_intent: "pi_3TestMock0000", status: "shipped" }),
      limitedEnv,
      ORIGIN
    );
    assert(postRes.status === 429, "fulfill-order answers 429 when the limiter denies");
  }
  {
    // THE LOCKOUT: a full minute's bucket of junk used to leave the owner on
    // 429. Requests that cost nothing (no token, a malformed one, a verdict
    // already cached) are no longer counted, so they cannot spend it.
    const limiter = makeLimiter(ADMIN_AUTH_RATE_LIMIT.limit);
    const limitedEnv = { ...env, RATE_LIMITER: limiter };
    for (let i = 0; i < ADMIN_AUTH_RATE_LIMIT.limit * 2; i++) {
      const headers = i % 2 === 0 ? [] : [["Authorization", "Bearer nope"]];
      await handleUnfulfilledOrders(request(headers), limitedEnv, ORIGIN);
    }
    for (let i = 0; i < 5; i++) {
      await handleUnfulfilledOrders(request(STRANGER_AUTH), limitedEnv, ORIGIN);
    }
    assert(limiter.calls.length === 0, "junk and cached refusals never touch the limiter");
    const owner = await handleUnfulfilledOrders(
      request(bearer(freshOwnerToken())),
      limitedEnv,
      ORIGIN
    );
    assert(owner.status === 200, "after a flood of free junk the owner still gets in");
    assert(limiter.calls.length === 1, "only the request that reached GitHub was counted");

    // What is left (see the file header): well-formed fake tokens each cost
    // a GitHub round trip and ARE counted, so they can fill the bucket...
    for (let i = 1; i < ADMIN_AUTH_RATE_LIMIT.limit; i++) {
      await handleUnfulfilledOrders(request(bearer(unknownToken(i))), limitedEnv, ORIGIN);
    }
    const coldOwner = await handleUnfulfilledOrders(
      request(bearer(freshOwnerToken())),
      limitedEnv,
      ORIGIN
    );
    assert(coldOwner.status === 429, "a full bucket still refuses an unverified token");
    // ...but an owner already verified in this isolate is served from cache.
    const warmOwner = await handleUnfulfilledOrders(request(AUTH), limitedEnv, ORIGIN);
    assert(warmOwner.status === 200, "a full bucket does not lock out a cached owner");
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
        request([...bearer(freshOwnerToken()), ...extra]),
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
    // Fails OPEN: the credential is a GitHub token, not a guessable secret,
    // so a counter outage must not lock the owner out of shipping.
    // The GitHub check still decides, so an outage is not a way in.
    const noLimiterEnv = { ...env };
    delete noLimiterEnv.RATE_LIMITER;
    const res = await handleUnfulfilledOrders(
      request(bearer(freshOwnerToken())),
      noLimiterEnv,
      ORIGIN
    );
    assert(res.status === 200, "no rate-limit backend still serves the owner (fail open)");
    const strangerNoLimiter = await handleUnfulfilledOrders(
      request(bearer(freshOwnerToken({ push: false }))),
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
    const errRes = await handleUnfulfilledOrders(
      request(bearer(freshOwnerToken())),
      brokenDoEnv,
      ORIGIN
    );
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

    // The happy path, and the audit line naming who marked it.
    const logged = [];
    const realLog = console.log;
    console.log = (...args) => logged.push(args.join(" "));
    let fulfillRes;
    try {
      fulfillRes = await handleFulfillOrder(request(AUTH, goodBody), env, ORIGIN);
    } finally {
      console.log = realLog;
    }
    assert(fulfillRes.status === 200, "fulfill-order returns 200 with auth");
    assert(
      logged.some((l) => l.includes("shop-owner") && l.includes("pi_3TestMock0000 to shipped")),
      "a fulfilment is logged with the GitHub login that made it"
    );

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

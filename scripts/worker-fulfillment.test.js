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
// Fine-grained PATs -- how the owner actually signs in to the CMS. GitHub
// reports no scopes for them; `contentsWrite` is what the token itself may do.
const FG_WRITE_TOKEN = "github_pat_11AAAAAAA0fineGrainedWriteAAAAAAAAAAAAAAAA";
const FG_READ_TOKEN = "github_pat_11AAAAAAA0fineGrainedReadAAAAAAAAAAAAAAAAA";
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
  [PAT_TOKEN]: { login: "shop-owner", scopes: "repo", push: true, app: false },
  [FG_WRITE_TOKEN]: { login: "shop-owner", scopes: null, push: true, contentsWrite: true },
  [FG_READ_TOKEN]: { login: "shop-owner", scopes: null, push: true, contentsWrite: false }
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
      // A 200 that is not GitHub's answer: an HTML page, or JSON with no
      // scopes list (red team, 2026-10-09).
      if (state.appNotJson) {
        return new Response("<html>upstream error</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" }
        });
      }
      if (state.appNoScopes) return ghResponse(200, { user: { login: info.login } });
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
    if (route === "/user") {
      // `dropScopesHeader`: a 200 with no X-OAuth-Scopes header at all --
      // what a fine-grained token always gets, and a classic one never does.
      return ghResponse(200, { login: info.login }, state.dropScopesHeader ? null : info.scopes);
    }
    if (route.endsWith("/git/refs") && options.method === "POST") {
      // The write check. GitHub refuses a token without Contents write before
      // it reads the body; one with it fails on the all-zero SHA instead.
      if (state.probeFail === "rate") {
        return new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: { "Content-Type": "application/json", "X-RateLimit-Remaining": "0" }
        });
      }
      if (state.probeFail === "secondary") {
        // GitHub's SECONDARY limit: a non-zero remaining count, Retry-After.
        return new Response(
          JSON.stringify({ message: "You have exceeded a secondary rate limit." }),
          {
            status: 403,
            headers: {
              "Content-Type": "application/json",
              "X-RateLimit-Remaining": "4321",
              "Retry-After": "60"
            }
          }
        );
      }
      /* Each rate-limit signal ON ITS OWN, so dropping any one of the three
         from probeContentsWrite() is caught: the two cases above always
         send two at once. */
      const neutral = { message: "Forbidden" };
      if (state.probeFail === "remaining-only") {
        return new Response(JSON.stringify(neutral), {
          status: 403,
          headers: { "Content-Type": "application/json", "X-RateLimit-Remaining": "0" }
        });
      }
      if (state.probeFail === "retry-after-only") {
        return new Response(JSON.stringify(neutral), {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Remaining": "4321",
            "Retry-After": "30"
          }
        });
      }
      if (state.probeFail === "message-only") {
        return new Response(JSON.stringify({ message: "API rate limit exceeded for user" }), {
          status: 403,
          headers: { "Content-Type": "application/json", "X-RateLimit-Remaining": "4321" }
        });
      }
      if (state.probeFail === "plain-403") {
        return new Response(JSON.stringify(neutral), {
          status: 403,
          headers: { "Content-Type": "application/json", "X-RateLimit-Remaining": "4321" }
        });
      }
      if (state.probeFail) return ghResponse(state.probeFail, {});
      // A classic token writes when its account may push (the scopes were
      // checked first) unless `contentsWrite` says otherwise -- an OAuth app
      // the organisation has not approved, say.
      const canWrite = info.contentsWrite !== undefined ? info.contentsWrite : info.push;
      return canWrite
        ? ghResponse(422, { message: "Object does not exist" })
        : ghResponse(403, { message: "Resource not accessible by personal access token" });
    }
    if (route.startsWith("/repos/")) {
      if (state.repoNotJson) {
        return new Response("<html>upstream error</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" }
        });
      }
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
    FULFILLMENT_STATUSES,
    KNOWN_TOKEN_MS,
    resetAuthMemo,
    sweepKnownTokens
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

  // Anything that is not shaped like a GitHub token the CMS could hold is
  // refused locally, so a flood of junk costs no API calls. GitHub App
  // tokens are well-formed but nobody signs in to the CMS with one.
  for (const junk of [
    "wrong_password",
    "",
    "   ",
    "gho_short",
    "Basic gho_xxxx",
    "undefined",
    "ghu_userToServerTokenAAAAAAAAAAAAAAAAA",
    "ghs_installationTokenAAAAAAAAAAAAAAAAA",
    "github_pat_short"
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

  /* ------------------------------------------------ fine-grained tokens */
  {
    // How the owner signs in to the CMS. No scopes to read, so the token is
    // asked whether it may write -- with a write that cannot succeed.
    gh.calls.length = 0;
    const res = await handleUnfulfilledOrders(request(bearer(FG_WRITE_TOKEN)), env, ORIGIN);
    assert(res.status === 200, "a fine-grained token that may write the repo is accepted");
    const probe = gh.calls.find((c) => c.url.endsWith("/git/refs"));
    assert(
      probe &&
        probe.url ===
          "https://api.github.com/repos/yallternative-living/yallternative-living/git/refs" &&
        probe.options.method === "POST",
      "a fine-grained token is checked with a write to the configured repo"
    );
    const sent = probe ? JSON.parse(probe.options.body) : {};
    assert(
      sent.sha === "0".repeat(40) && /^refs\/heads\//.test(sent.ref),
      "the write check points a branch at the all-zero SHA, so it can never create anything"
    );
    assert(
      gh.calls.map((c) => c.url.replace("https://api.github.com", "")).join(" ") ===
        "/user /repos/yallternative-living/yallternative-living " +
          "/repos/yallternative-living/yallternative-living/git/refs",
      "identity, then the account's push access, then the token's own write check"
    );
  }
  {
    // The account can push, but this token was made read-only (or for some
    // other repository): the same gap the scope check closes for classic tokens.
    gh.calls.length = 0;
    const res = await handleUnfulfilledOrders(request(bearer(FG_READ_TOKEN)), env, ORIGIN);
    assert(res.status === 403, "a fine-grained token that may not write is refused (403)");
    gh.calls.length = 0;
    await handleUnfulfilledOrders(request(bearer(FG_READ_TOKEN)), env, ORIGIN);
    assert(gh.calls.length === 0, "a refused fine-grained token is cached like any other");
  }
  {
    // A fine-grained token on an account without push never gets to the write.
    gh.calls.length = 0;
    const token = freshOwnerToken({ scopes: null, push: false, contentsWrite: true });
    const fg = "github_pat_" + token.slice(4);
    TOKENS[fg] = TOKENS[token];
    const res = await handleUnfulfilledOrders(request(bearer(fg)), env, ORIGIN);
    assert(res.status === 403, "a fine-grained token on an account without push gets 403");
    assert(
      !gh.calls.some((c) => c.url.endsWith("/git/refs")),
      "no write is attempted for an account that cannot push"
    );
  }
  {
    // GitHub failing to answer the write check is about us, not the token.
    for (const [fail, label] of [
      [500, "a 5xx"],
      ["rate", "a rate-limited 403"],
      ["secondary", "a secondary-rate-limit 403"]
    ]) {
      gh.probeFail = fail;
      const fg = "github_pat_" + freshOwnerToken().slice(4);
      TOKENS[fg] = { login: "shop-owner", scopes: null, push: true, contentsWrite: true };
      const res = await handleUnfulfilledOrders(request(bearer(fg)), env, ORIGIN);
      assert(res.status === 503, `${label} from the write check answers 503, not 403`);
      gh.probeFail = 0;
      const again = await handleUnfulfilledOrders(request(bearer(fg)), env, ORIGIN);
      assert(again.status === 200, `${label} from the write check is not cached`);
    }
  }

  {
    // A 200 from the repository check that is not JSON is GitHub failing to
    // answer -- not a five-minute refusal of the owner.
    gh.repoNotJson = true;
    const token = freshOwnerToken();
    const res = await handleUnfulfilledOrders(request(bearer(token)), env, ORIGIN);
    assert(res.status === 503, "a non-JSON 200 from the repository check answers 503");
    gh.repoNotJson = false;
    const again = await handleUnfulfilledOrders(request(bearer(token)), env, ORIGIN);
    assert(again.status === 200, "a non-JSON 200 from the repository check is not cached");
  }
  {
    // A classic token with the scope, on an account with push, that still
    // cannot write -- another OAuth app the organisation has not approved.
    const token = freshOwnerToken({ contentsWrite: false });
    const res = await handleUnfulfilledOrders(request(bearer(token)), env, ORIGIN);
    assert(res.status === 403, "a classic token that cannot write is refused (write check)");
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
    assert(
      afterFirst === 3,
      "the first verification asks GitHub three times (/user, the repo, the write check)"
    );
    assert(
      gh.calls.length === 3,
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
      gh.calls.length === 3 &&
        gh.calls[1].url.endsWith("/repos/someone/else") &&
        gh.calls[2].url.endsWith("/repos/someone/else/git/refs"),
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
    // THE LOCKOUT, second form (red team, 2026-10-08): 30 well-formed fake
    // tokens a minute hold the global bucket for as long as they keep coming,
    // and the owner's cache entry lasts one minute in one isolate. A token
    // GitHub said yes to before -- in ANY isolate, so remembered in D1 -- is
    // counted in a bucket of its own once the global one is full.
    const crypto = require("crypto");
    const digest = (t) => crypto.createHash("sha256").update(t).digest("hex");
    const calls = [];
    const floodedLimiter = {
      calls,
      async limit({ key }) {
        calls.push(key);
        return { success: key !== "admin-auth" };
      }
    };
    const floodedEnv = { ...env, RATE_LIMITER: floodedLimiter };

    // Verified in another isolate: the row is there, this isolate's cache is
    // not. This isolate sees another's yes when it next reloads its set of
    // remembered tokens -- at most a minute later; the reset stands in for
    // that minute.
    const remembered = freshOwnerToken();
    await env.STATE_DB.prepare("INSERT INTO job_state (job, value, updated_at) VALUES (?, '1', ?)")
      .bind("admin-known:" + digest(remembered), Date.now())
      .run();
    resetAuthMemo("known");
    const owner = await handleUnfulfilledOrders(request(bearer(remembered)), floodedEnv, ORIGIN);
    assert(
      owner.status === 200,
      "a flooded bucket does not lock out a token GitHub verified before"
    );
    assert(
      calls.length === 2 &&
        calls[0] === "admin-auth" &&
        calls[1] === "admin-auth-known:" + digest(remembered),
      "the remembered token is counted in its own bucket, keyed by its digest"
    );

    const stranger = await handleUnfulfilledOrders(
      request(bearer(unknownToken(900))),
      floodedEnv,
      ORIGIN
    );
    assert(stranger.status === 429, "a flooded bucket still refuses a token never verified");

    const stale = freshOwnerToken();
    await env.STATE_DB.prepare("INSERT INTO job_state (job, value, updated_at) VALUES (?, '1', ?)")
      .bind("admin-known:" + digest(stale), Date.now() - 91 * 24 * 60 * 60 * 1000)
      .run();
    resetAuthMemo("known");
    const staleRes = await handleUnfulfilledOrders(request(bearer(stale)), floodedEnv, ORIGIN);
    assert(staleRes.status === 429, "a yes older than KNOWN_TOKEN_MS is not honoured");

    // Any successful verification is remembered...
    const fresh = freshOwnerToken();
    await handleUnfulfilledOrders(request(bearer(fresh)), env, ORIGIN);
    const row = await env.STATE_DB.prepare("SELECT job FROM job_state WHERE job = ?")
      .bind("admin-known:" + digest(fresh))
      .first();
    assert(row !== null, "a verified token is remembered by its digest");
    const leaked = await env.STATE_DB.prepare("SELECT job FROM job_state WHERE job LIKE ?")
      .bind("%" + fresh + "%")
      .first();
    assert(leaked === null, "the token itself is never written to D1");

    // ...and a token GitHub now refuses is forgotten at once.
    const revoked = freshOwnerToken();
    await env.STATE_DB.prepare("INSERT INTO job_state (job, value, updated_at) VALUES (?, '1', ?)")
      .bind("admin-known:" + digest(revoked), Date.now())
      .run();
    resetAuthMemo("known");
    delete TOKENS[revoked];
    const revokedRes = await handleUnfulfilledOrders(request(bearer(revoked)), floodedEnv, ORIGIN);
    assert(revokedRes.status === 401, "a remembered token GitHub refuses is still refused");
    const gone = await env.STATE_DB.prepare("SELECT job FROM job_state WHERE job = ?")
      .bind("admin-known:" + digest(revoked))
      .first();
    assert(gone === null, "a refused token loses its remembered row");
  }
  /* ==================================================================
     Red team, 2026-10-09: the remembered-token path, assertion by
     assertion -- each of these was a change to fulfillment.js the suite
     above let through (mutation testing), plus findings A7, A9 and A10.
     ================================================================== */
  {
    const crypto = require("crypto");
    const digest = (t) => crypto.createHash("sha256").update(t).digest("hex");
    const rowOf = (t) =>
      env.STATE_DB.prepare("SELECT job, value, updated_at FROM job_state WHERE job = ?")
        .bind("admin-known:" + digest(t))
        .first();
    const remember = async (t, at = Date.now()) => {
      await env.STATE_DB.prepare(
        "INSERT INTO job_state (job, value, updated_at) VALUES (?, '1', ?) " +
          "ON CONFLICT(job) DO UPDATE SET updated_at = excluded.updated_at"
      )
        .bind("admin-known:" + digest(t), at)
        .run();
      resetAuthMemo("known"); // another isolate's yes, seen after this one's next reload
    };
    /** Global bucket full; each remembered token's own bucket per `ownOk`. */
    const flooded = (ownOk = () => true) => {
      const calls = [];
      return {
        calls,
        env: {
          ...env,
          RATE_LIMITER: {
            async limit({ key }) {
              calls.push(key);
              return { success: key === "admin-auth" ? false : ownOk(key) };
            }
          }
        }
      };
    };

    /* A8: a remembered token GitHub now answers 403 (the account lost push)
       is forgotten like a 401 -- and so loses its own bucket. */
    {
      const t = freshOwnerToken();
      await remember(t);
      TOKENS[t] = { ...TOKENS[t], push: false };
      const f = flooded();
      const res = await handleUnfulfilledOrders(request(bearer(t)), f.env, ORIGIN);
      assert(res.status === 403, "a remembered token that lost push is refused (403)");
      assert((await rowOf(t)) === null, "...and a 403 forgets the remembered row, like a 401");
      resetAuthMemo("verdicts");
      const again = await handleUnfulfilledOrders(request(bearer(t)), f.env, ORIGIN);
      assert(again.status === 429, "...so in the next flood it waits like any unknown token");
    }

    /* A8: the remembered token's OWN bucket is enforced. */
    {
      const t = freshOwnerToken();
      await remember(t);
      gh.calls.length = 0;
      const f = flooded(() => false);
      const res = await handleUnfulfilledOrders(request(bearer(t)), f.env, ORIGIN);
      assert(res.status === 429, "a remembered token whose own bucket is full gets 429");
      assert(
        f.calls.length === 2 && f.calls[1] === "admin-auth-known:" + digest(t),
        "...after asking its own bucket"
      );
      assert(gh.calls.length === 0, "...and GitHub is never asked");
    }

    /* A8: every use renews the remembered row (ON CONFLICT ... DO UPDATE). */
    {
      const t = freshOwnerToken();
      const old = Date.now() - 80 * 24 * 60 * 60 * 1000;
      await remember(t, old);
      const before = Date.now();
      const res = await handleUnfulfilledOrders(request(bearer(t)), env, ORIGIN);
      assert(res.status === 200, "an 80-day-old remembered token verifies again");
      const row = await rowOf(t);
      assert(
        row && Number(row.updated_at) >= before,
        "...and the yes renews its remembered row (updated_at moves to now)"
      );
    }

    /* A8: a 503 is about GitHub, not the token: never remembered. */
    {
      const t = freshOwnerToken();
      gh.fail = 500;
      const res = await handleUnfulfilledOrders(request(bearer(t)), env, ORIGIN);
      gh.fail = 0;
      assert(res.status === 503, "GitHub down: 503");
      assert((await rowOf(t)) === null, "...and a 503 is never remembered as a yes");
    }

    /* A8: each rate-limit signal on its own makes the write check a 503;
       none of them is a refusal of the token. */
    for (const [fail, label] of [
      ["remaining-only", "X-RateLimit-Remaining: 0 alone"],
      ["retry-after-only", "Retry-After alone"],
      ["message-only", "a 'rate limit' message alone"]
    ]) {
      gh.probeFail = fail;
      const fg = "github_pat_" + freshOwnerToken().slice(4);
      TOKENS[fg] = { login: "shop-owner", scopes: null, push: true, contentsWrite: true };
      const res = await handleUnfulfilledOrders(request(bearer(fg)), env, ORIGIN);
      gh.probeFail = 0;
      assert(res.status === 503, `write check, ${label}: 503, not a refusal`);
      const again = await handleUnfulfilledOrders(request(bearer(fg)), env, ORIGIN);
      assert(again.status === 200, `write check, ${label}: not cached`);
    }
    {
      gh.probeFail = "plain-403";
      const fg = "github_pat_" + freshOwnerToken().slice(4);
      TOKENS[fg] = { login: "shop-owner", scopes: null, push: true, contentsWrite: true };
      const res = await handleUnfulfilledOrders(request(bearer(fg)), env, ORIGIN);
      gh.probeFail = 0;
      assert(res.status === 403, "write check, a 403 with none of the signals: a refusal (403)");
    }

    /* A8: the token itself is in NO column of job_state. */
    {
      const t = freshOwnerToken();
      const res = await handleUnfulfilledOrders(request(bearer(t)), env, ORIGIN);
      assert(res.status === 200, "a fresh token verifies");
      const all = await env.STATE_DB.prepare("SELECT * FROM job_state").all();
      const dump = JSON.stringify(all.results);
      assert(all.results.length > 0 && dump.includes(digest(t)), "...and is remembered");
      assert(!dump.includes(t), "...by digest only: the raw token is in no column of job_state");
    }

    /* A7: a classic token's /user 200 without X-OAuth-Scopes is GitHub not
       answering properly: 503, not cached, and not a reason to forget. */
    {
      const t = freshOwnerToken();
      await remember(t);
      gh.dropScopesHeader = true;
      const res = await handleUnfulfilledOrders(request(bearer(t)), env, ORIGIN);
      gh.dropScopesHeader = false;
      assert(res.status === 503, "/user without X-OAuth-Scopes for a classic token: 503, not 403");
      assert((await rowOf(t)) !== null, "...the remembered row is kept");
      const again = await handleUnfulfilledOrders(request(bearer(t)), env, ORIGIN);
      assert(again.status === 200, "...and nothing was cached: the next request gets in");

      const fg = "github_pat_" + freshOwnerToken().slice(4);
      TOKENS[fg] = { login: "shop-owner", scopes: null, push: true, contentsWrite: true };
      gh.dropScopesHeader = true;
      const fgRes = await handleUnfulfilledOrders(request(bearer(fg)), env, ORIGIN);
      gh.dropScopesHeader = false;
      assert(fgRes.status === 200, "...while a fine-grained token, which never gets one, is fine");
    }

    /* A7: the pinned app check answering 200 without GitHub's JSON. */
    {
      gh.clientId = "Iv1.cmsapp";
      gh.clientSecret = "s3cret";
      const pinned = { ...env, GITHUB_CLIENT_ID: "Iv1.cmsapp", GITHUB_CLIENT_SECRET: "s3cret" };
      for (const [knob, label] of [
        ["appNotJson", "a non-JSON 200"],
        ["appNoScopes", "a 200 with no scopes list"]
      ]) {
        const t = freshOwnerToken();
        await remember(t);
        gh[knob] = true;
        const res = await handleUnfulfilledOrders(request(bearer(t)), pinned, ORIGIN);
        gh[knob] = false;
        assert(res.status === 503, `pinned: ${label} from the app check is a 503, not a 403`);
        assert((await rowOf(t)) !== null, `pinned: ${label} does not forget the remembered row`);
        const again = await handleUnfulfilledOrders(request(bearer(t)), pinned, ORIGIN);
        assert(again.status === 200, `pinned: ${label} is not cached as a refusal`);
      }
    }

    /* A9: during a flood, refused fake tokens cost ONE D1 read a minute,
       not one each; this isolate's own yes and no take effect at once. */
    {
      resetAuthMemo();
      const reads = [];
      const counting = {
        prepare(sql) {
          if (/^\s*SELECT/i.test(sql) && /job_state/.test(sql)) reads.push(sql);
          return env.STATE_DB.prepare(sql);
        }
      };
      const f = flooded();
      const floodEnv = { ...f.env, STATE_DB: counting };
      const owner = freshOwnerToken();
      await remember(owner);
      let refused = 0;
      for (let i = 0; i < 40; i++) {
        const res = await handleUnfulfilledOrders(
          request(bearer(unknownToken(2000 + i))),
          floodEnv,
          ORIGIN
        );
        if (res.status === 429) refused++;
      }
      assert(refused === 40, "a flood of 40 fake tokens is refused (429)");
      assert(reads.length === 1, `...for ONE read of the remembered tokens (got ${reads.length})`);
      const ownerRes = await handleUnfulfilledOrders(request(bearer(owner)), floodEnv, ORIGIN);
      assert(ownerRes.status === 200, "...and the remembered owner still gets in");
      assert(reads.length === 1, "...from memory, with no further read");

      // A yes heard in THIS isolate counts at once, before any reload.
      const fresh = freshOwnerToken();
      const ok = await handleUnfulfilledOrders(
        request(bearer(fresh)),
        { ...env, STATE_DB: counting },
        ORIGIN
      );
      assert(ok.status === 200, "a new sign-in verifies outside the flood");
      resetAuthMemo("verdicts");
      const known = await handleUnfulfilledOrders(request(bearer(fresh)), floodEnv, ORIGIN);
      assert(known.status === 200, "...and is known in the flood straight away");
      assert(reads.length === 1, "...without reloading the set");

      // A refusal heard in THIS isolate takes the token out at once.
      TOKENS[fresh] = { ...TOKENS[fresh], push: false };
      resetAuthMemo("verdicts");
      const lost = await handleUnfulfilledOrders(request(bearer(fresh)), floodEnv, ORIGIN);
      assert(lost.status === 403, "the same token, now without push, is refused");
      resetAuthMemo("verdicts");
      gh.calls.length = 0;
      const out = await handleUnfulfilledOrders(request(bearer(fresh)), floodEnv, ORIGIN);
      assert(out.status === 429, "...and is out of the set at once: the flood refuses it");
      assert(gh.calls.length === 0 && reads.length === 1, "...with no GitHub call and no read");
      resetAuthMemo();
    }

    /* A10: rows older than KNOWN_TOKEN_MS are deleted, by the sweep and by
       the hourly cron that runs it; nothing else in job_state is. */
    {
      assert(typeof sweepKnownTokens === "function", "sweepKnownTokens is exported");
      const now = Date.now();
      const { makeD1: makeEmulatedD1 } = require("./lib/d1-emulator.js");
      const { applyMigrations, resetSchemaMemo } = await import(
        "file://" + process.cwd() + "/workers/state/migrations.js"
      );
      resetSchemaMemo();
      const db = makeEmulatedD1(new DatabaseSync(":memory:"));
      await applyMigrations(db);
      const put = (job, at) =>
        db
          .prepare("INSERT INTO job_state (job, value, updated_at) VALUES (?, '1', ?)")
          .bind(job, at)
          .run();
      const seed = async () => {
        await put("admin-known:" + "a".repeat(64), now - KNOWN_TOKEN_MS - 1000);
        await put("admin-known:" + "b".repeat(64), now - 24 * 60 * 60 * 1000);
        await put("ship-notice:cursor", now - 400 * 24 * 60 * 60 * 1000);
      };
      const jobs = async () =>
        (await db.prepare("SELECT job FROM job_state ORDER BY job").all()).results.map(
          (r) => r.job
        );
      await seed();
      assert(
        (await sweepKnownTokens(db, now)) === 1,
        "the sweep deletes the one expired remembered row"
      );
      const kept = JSON.stringify(["admin-known:" + "b".repeat(64), "ship-notice:cursor"]);
      assert(
        JSON.stringify(await jobs()) === kept,
        "...keeping the fresh one and every other job's row, however old"
      );

      await db.prepare("DELETE FROM job_state").run();
      await seed();
      const workerModule = await import("file://" + path.join(ROOT, "workers/checkout.js"));
      const worker = workerModule.default || workerModule;
      const pending = [];
      const realFetch = global.fetch;
      const quiet = { log: console.log, warn: console.warn, error: console.error };
      global.fetch = async () => new Response("{}", { status: 404 });
      console.log = console.warn = console.error = () => {};
      try {
        await worker.scheduled(
          { scheduledTime: now },
          { STATE_DB: db },
          { waitUntil: (p) => pending.push(p) }
        );
        await Promise.all(pending);
      } finally {
        global.fetch = realFetch;
        Object.assign(console, quiet);
      }
      assert(pending.length > 0, "the hourly cron ran");
      assert(
        JSON.stringify(await jobs()) === kept,
        "...and its known-token sweep deleted the expired remembered row"
      );
    }
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

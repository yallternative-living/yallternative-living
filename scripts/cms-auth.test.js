/**
 * @fileoverview Unit tests for the CMS sign-in Worker (cms-auth/sveltia-auth.js).
 *
 * The Worker mints a GitHub token with real write access to this repository,
 * and until now nothing exercised it at all. These tests cover the four
 * behaviours the 2026-09-01 audit called out (Medium: "OAuth worker requests
 * classic `repo` scope and honours an attacker-supplied `?scope=`"; Low:
 * "origin check compares hostname only; CSRF cookie regex anchored with \b;
 * the token is minted before the origin check and never revoked on failure"):
 *
 *   1. `?scope=` from the caller is ignored; the scope is fixed server-side.
 *   2. The popup only postMessages a token to a full https origin on the
 *      allowlist -- scheme and port included, not just the hostname.
 *   3. The CSRF cookie is matched on a real cookie boundary, and is cleared by
 *      the callback response.
 *   4. An untrusted opener causes the just-issued token to be revoked at
 *      GitHub rather than left live.
 *
 * The Worker is an ES module with a single default export, so the popup script
 * it returns is exercised by running it in a `vm` context with a fake window --
 * which is also the only way to test the origin check, since that check runs in
 * the browser.
 *
 * Run: node scripts/cms-auth.test.js
 */

const vm = require("vm");

const workerModule = require("../cms-auth/sveltia-auth.js");
const worker = workerModule.default || workerModule;

const ENV = {
  GITHUB_CLIENT_ID: "Iv1_test_client_id",
  GITHUB_CLIENT_SECRET: "test_client_secret",
  ALLOWED_DOMAINS: "yallternativeliving.com,*.yallternativeliving.com"
};

const CSRF = "0123456789abcdef0123456789abcdef";

let passed = 0;
let failed = 0;

function assert(condition, label, detail) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

function eq(actual, expected, label) {
  assert(
    actual === expected,
    label,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

function get(url, headers) {
  return worker.fetch(new Request(url, { method: "GET", headers: headers || {} }), ENV);
}

/**
 * Pull the popup handshake script out of a /callback response body.
 * @param {string} html
 * @return {string}
 */
function extractScript(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("callback response carried no inline script");
  return m[1];
}

/**
 * Run the popup script against a fake browser and deliver one "authorizing:"
 * message from `openerOrigin`.
 * @param {string} script
 * @param {string} openerOrigin
 * @return {{posted: !Array, beacons: !Array, fetches: !Array, closed: boolean}}
 */
function runPopup(script, openerOrigin) {
  const posted = [];
  const beacons = [];
  const fetches = [];
  const listeners = [];
  const state = { closed: false };

  const sandbox = {
    console,
    URL,
    JSON,
    RegExp,
    Promise,
    window: {
      opener: {
        postMessage: (message, targetOrigin) => posted.push({ message, targetOrigin })
      },
      addEventListener: (type, fn) => listeners.push({ type, fn }),
      close: () => {
        state.closed = true;
      }
    },
    navigator: {
      sendBeacon: (url, blob) => {
        beacons.push({ url, body: blob && blob.parts ? blob.parts.join("") : String(blob) });
        return true;
      }
    },
    Blob: class {
      constructor(parts, options) {
        this.parts = parts;
        this.type = options && options.type;
      }
    },
    fetch: (url, init) => {
      fetches.push({ url, init });
      return Promise.resolve({ ok: true });
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);

  const listener = listeners.find((l) => l.type === "message");
  if (!listener) throw new Error("popup script registered no message listener");
  listener.fn({ data: "authorizing:github", origin: openerOrigin });

  return { posted, beacons, fetches, closed: state.closed };
}

(async () => {
  console.log("Running cms-auth/sveltia-auth.js unit tests...\n");

  // =========================================================================
  console.log("--- 1. The GitHub scope is fixed server-side ---");
  // =========================================================================
  {
    const res = await get("https://cms-auth.example/auth");
    eq(res.status, 302, "/auth redirects to GitHub");
    const location = new URL(res.headers.get("Location"));
    eq(location.hostname, "github.com", "/auth redirects to github.com");
    eq(
      location.searchParams.get("scope"),
      "public_repo",
      "default scope is public_repo, not classic repo"
    );
  }
  {
    const res = await get("https://cms-auth.example/auth?scope=repo,admin:org,delete_repo");
    const location = new URL(res.headers.get("Location"));
    eq(
      location.searchParams.get("scope"),
      "public_repo",
      "an attacker-supplied ?scope= is ignored"
    );
    assert(
      /csrf-token=github_[0-9a-f]{32};/.test(res.headers.get("Set-Cookie") || ""),
      "/auth sets the HttpOnly CSRF cookie"
    );
    const cookie = res.headers.get("Set-Cookie") || "";
    assert(
      cookie.includes("HttpOnly") && cookie.includes("Secure") && cookie.includes("SameSite=Lax"),
      "CSRF cookie is HttpOnly + Secure + SameSite=Lax"
    );
  }

  // =========================================================================
  console.log("\n--- 2. CSRF cookie matching is anchored on a cookie boundary ---");
  // =========================================================================
  {
    // A cookie whose VALUE ends in "csrf-token=github_<32 hex>". The old \b
    // anchor matched inside it, so any page that could set a cookie on the
    // domain could choose the `state` the callback would accept.
    const res = await get(`https://cms-auth.example/callback?code=abc&state=${CSRF}`, {
      Cookie: `junk=xcsrf-token=github_${CSRF}`
    });
    const html = await res.text();
    assert(
      html.includes("CSRF_DETECTED") || html.includes("UNSUPPORTED_PROVIDER"),
      "a csrf-token substring inside another cookie's value is not accepted",
      html.slice(0, 200)
    );
    assert(!html.includes('"token"'), "no token is issued on the rejected path");
  }
  {
    const res = await get(`https://cms-auth.example/callback?code=abc&state=${CSRF}wrong`, {
      Cookie: `csrf-token=github_${CSRF}`
    });
    const html = await res.text();
    assert(html.includes("CSRF_DETECTED"), "a state that does not match the cookie is rejected");
  }
  {
    // A genuine second cookie in front of ours must still parse.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ json: async () => ({ access_token: "gho_test_token" }) });
    let res;
    try {
      res = await get(`https://cms-auth.example/callback?code=abc&state=${CSRF}`, {
        Cookie: `theme=dark; csrf-token=github_${CSRF}; other=1`
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const html = await res.text();
    assert(
      html.includes("gho_test_token"),
      "a valid CSRF cookie among other cookies is accepted",
      html.slice(0, 200)
    );
    assert(
      (res.headers.get("Set-Cookie") || "").includes("Max-Age=0"),
      "the callback response clears the single-use CSRF cookie"
    );
    eq(res.headers.get("Cache-Control"), "no-store", "the token page is never cached");
  }
  {
    const res = await get("https://cms-auth.example/callback");
    assert(
      (res.headers.get("Set-Cookie") || "").includes("Max-Age=0"),
      "the CSRF cookie is cleared on the failure path too"
    );
  }

  // =========================================================================
  console.log("\n--- 3. The popup compares full origins, https only ---");
  // =========================================================================
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ access_token: "gho_test_token" }) });
  let callbackHtml;
  try {
    const res = await get(`https://cms-auth.example/callback?code=abc&state=${CSRF}`, {
      Cookie: `csrf-token=github_${CSRF}`
    });
    callbackHtml = await res.text();
  } finally {
    globalThis.fetch = originalFetch;
  }
  const script = extractScript(callbackHtml);

  const trusted = ["https://yallternativeliving.com", "https://www.yallternativeliving.com"];
  trusted.forEach((origin) => {
    const run = runPopup(script, origin);
    const delivered = run.posted.filter((p) => p.targetOrigin === origin);
    assert(
      delivered.length === 1 && delivered[0].message.includes("gho_test_token"),
      `token IS delivered to the allowlisted origin ${origin}`,
      JSON.stringify(run.posted)
    );
    assert(run.closed, `popup closes after delivering to ${origin}`);
    eq(run.beacons.length, 0, `no revocation for the allowlisted origin ${origin}`);
  });

  const untrusted = [
    // Right host, wrong scheme -- trivially spoofable on a hostile network.
    "http://yallternativeliving.com",
    // Right host, explicit port: a different origin as far as postMessage cares.
    "https://yallternativeliving.com:8443",
    // Suffix and prefix lookalikes.
    "https://yallternativeliving.com.evil.example",
    "https://evil-yallternativeliving.com",
    "https://evil.example",
    "null"
  ];
  untrusted.forEach((origin) => {
    const run = runPopup(script, origin);
    const delivered = run.posted.filter((p) => p.message.includes("gho_test_token"));
    eq(delivered.length, 0, `token is NOT delivered to ${origin}`);
    assert(!run.closed, `popup does not report success to ${origin}`);
  });

  // =========================================================================
  console.log("\n--- 4. A token offered to an untrusted opener is revoked ---");
  // =========================================================================
  {
    const run = runPopup(script, "https://evil.example");
    const calls = run.beacons.concat(
      run.fetches.map((f) => ({ url: f.url, body: f.init && f.init.body }))
    );
    eq(calls.length, 1, "exactly one revocation request is made");
    eq(calls[0].url, "/revoke", "revocation is posted to the Worker's /revoke endpoint");
    const payload = JSON.parse(calls[0].body);
    eq(payload.token, "gho_test_token", "the revocation carries the token that was withheld");
    assert(
      typeof payload.reason === "string" && payload.reason.includes("https://evil.example"),
      "the revocation names the untrusted origin"
    );
  }
  {
    // And the endpoint really calls GitHub's token-deletion API.
    const seen = [];
    const originalGlobalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      seen.push({ url, init });
      return { status: 204 };
    };
    let res;
    try {
      res = await worker.fetch(
        new Request("https://cms-auth.example/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "github",
            token: "gho_test_token",
            reason: "untrusted_origin:https://evil.example"
          })
        }),
        ENV
      );
    } finally {
      globalThis.fetch = originalGlobalFetch;
    }

    eq(res.status, 204, "POST /revoke succeeds");
    eq(seen.length, 1, "POST /revoke calls GitHub exactly once");
    eq(
      seen[0].url,
      `https://api.github.com/applications/${ENV.GITHUB_CLIENT_ID}/token`,
      "revocation targets DELETE /applications/{client_id}/token"
    );
    eq(seen[0].init.method, "DELETE", "revocation uses the DELETE verb");
    eq(
      seen[0].init.headers.Authorization,
      `Basic ${Buffer.from(`${ENV.GITHUB_CLIENT_ID}:${ENV.GITHUB_CLIENT_SECRET}`).toString("base64")}`,
      "revocation authenticates as the OAuth app (client_id:client_secret)"
    );
    eq(
      JSON.parse(seen[0].init.body).access_token,
      "gho_test_token",
      "revocation sends the token to delete"
    );
  }
  {
    const res = await worker.fetch(
      new Request("https://cms-auth.example/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "github" })
      }),
      ENV
    );
    eq(res.status, 400, "POST /revoke without a token is a 400");
  }
  {
    const res = await get("https://cms-auth.example/revoke");
    eq(res.status, 404, "GET /revoke is not routed");
  }

  // =========================================================================
  console.log("\n--- 5. Fail-closed when ALLOWED_DOMAINS is empty ---");
  // =========================================================================
  {
    const originalGlobalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ json: async () => ({ access_token: "gho_test_token" }) });
    let html;
    try {
      const res = await worker.fetch(
        new Request(`https://cms-auth.example/callback?code=abc&state=${CSRF}`, {
          headers: { Cookie: `csrf-token=github_${CSRF}` }
        }),
        { ...ENV, ALLOWED_DOMAINS: "" }
      );
      html = await res.text();
    } finally {
      globalThis.fetch = originalGlobalFetch;
    }
    const run = runPopup(extractScript(html), "https://yallternativeliving.com");
    eq(
      run.posted.filter((p) => p.message.includes("gho_test_token")).length,
      0,
      "with no ALLOWED_DOMAINS configured, no origin is trusted"
    );
  }

  console.log("\n==================================================");
  console.log(`cms-auth.test.js: ${passed} passed, ${failed} failed`);
  console.log("==================================================");
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("cms-auth test suite crashed:", err);
  process.exit(1);
});

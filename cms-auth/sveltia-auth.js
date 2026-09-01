/**
 * @fileoverview Cloudflare Worker: GitHub OAuth handler for the Sveltia CMS
 * product editor at /admin (see docs/DEVELOPMENT.md section 20).
 *
 * WHY THIS EXISTS -------------------------------------------------------------
 * Sveltia CMS uses a GitHub backend (admin/config.yml). Committing from the
 * browser needs a GitHub access token, and getting one needs an OAuth flow that
 * knows the app's *client secret* -- which can never live in front-end code.
 * That secret has to sit on a tiny server. This Worker is that server.
 *
 * It is the modern replacement for Netlify's "Git Gateway / OAuth", which
 * Netlify DEPRECATED (that is the exact dead end this repo used to send Savanna
 * to). We already run one Cloudflare Worker for checkout (workers/checkout.js),
 * so hosting the CMS login here too means /admin depends on nothing from
 * Netlify and Savanna gets a normal "Sign in with GitHub" button.
 *
 * This implements the same popup handshake Sveltia/Decap/Netlify CMS expect,
 * and is a clean-room reimplementation of the canonical, MIT-licensed
 * "Sveltia CMS Authenticator" (github.com/sveltia/sveltia-cms-auth) -- kept
 * here in-repo, commented, and pinned so an upstream change can't silently
 * alter our login. If Sveltia ever changes the protocol, re-check this against
 * their current authenticator source.
 *
 * WHAT IT DOES ----------------------------------------------------------------
 *   GET /auth (or /oauth/authorize)  -> set a CSRF cookie, redirect the popup
 *                                       to GitHub's authorize screen.
 *   GET /callback (or /oauth/redirect) -> verify CSRF, swap the code GitHub
 *                                       sent back for an access token, then
 *                                       return an HTML page whose script
 *                                       postMessage()s that token to the
 *                                       /admin window that opened the popup.
 *   POST /revoke                     -> called by that same page when the
 *                                       opener turns out NOT to be a trusted
 *                                       origin: hands the just-issued token
 *                                       straight back to GitHub for deletion
 *                                       instead of leaving it live.
 *   anything else                    -> 404.
 *
 * The GitHub scope is fixed at "public_repo" and the caller's `?scope=` is
 * ignored -- see PROVIDERS.github.scope.
 *
 * SETUP (one-time, done by Steven; see workers/README.md "Sign-in Worker") ----
 *   1. GitHub -> Settings -> Developer settings -> OAuth Apps -> New OAuth App
 *      (this is the short "OAuth App" form -- NOT the long "GitHub App" one).
 *        - Application name:  Y'allternative Living CMS login
 *        - Homepage URL:      https://yallternativeliving.com
 *        - Authorization callback URL:  <THIS-WORKER-URL>/callback
 *      Copy the Client ID, then "Generate a new client secret" and copy that.
 *   2. Deploy this folder (cms-auth) to Cloudflare -- see workers/README.md.
 *   3. In the Worker's Cloudflare dashboard, Settings -> Variables and Secrets,
 *      add two Secrets:  GITHUB_CLIENT_ID  and  GITHUB_CLIENT_SECRET.
 *      (ALLOWED_DOMAINS is set in wrangler.toml, not as a secret -- it's not
 *      sensitive.)
 *   4. Put the Worker's URL into admin/config.yml as  backend.base_url,  and
 *      set that same callback URL in the GitHub OAuth App above.
 *
 * NOTHING SECRET IS COMMITTED. GITHUB_CLIENT_SECRET only ever lives as a
 * Cloudflare Secret. This file, and wrangler.toml, are safe in a public repo.
 */

/**
 * OAuth providers this Worker understands. Only GitHub is wired up (the CMS
 * backend is GitHub), but the shape mirrors the upstream authenticator so
 * adding GitLab later would be a one-object change.
 */
const PROVIDERS = {
  github: {
    hostnameEnv: "GITHUB_HOSTNAME", // optional override for GitHub Enterprise
    defaultHostname: "github.com",
    clientIdEnv: "GITHUB_CLIENT_ID",
    clientSecretEnv: "GITHUB_CLIENT_SECRET",
    authorizePath: "/login/oauth/authorize",
    tokenPath: "/login/oauth/access_token",
    // GitHub API host, only needed to build an authorize URL on Enterprise.
    // For github.com the authorize host and API host share the same domain.
    apiBase: (hostname) =>
      hostname === "github.com" ? "https://api.github.com" : `https://${hostname}/api/v3`,
    /**
     * The scope this Worker requests, always -- the `?scope=` query parameter
     * is deliberately ignored.
     *
     * Two reasons. Classic `repo` grants read AND write to EVERY repository
     * the signed-in account can reach, including private ones that have
     * nothing to do with this shop; the CMS only ever commits JSON to this
     * one public repo, so `public_repo` is the whole job. And the parameter
     * was attacker-controlled: anything that could open this popup could ask
     * for a broader grant than the CMS needs and, if the user clicked
     * Authorize, walk away with it.
     *
     * If this repository is ever made private, `public_repo` stops working
     * and this must become `repo` -- there is no narrower classic scope for
     * private repositories.
     */
    scope: "public_repo",
  },
};

/** Escape a string for safe interpolation into a RegExp source. */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Turn the comma-separated ALLOWED_DOMAINS var into anchored RegExp sources
 * that match a full ORIGIN, not a bare hostname.
 *
 * The check used to compare `new URL(origin).hostname` only, so
 * `http://yallternativeliving.com` (plaintext, trivially spoofed on a hostile
 * network) and `https://yallternativeliving.com:8443` (a different origin, and
 * postMessage treats it as one) both passed. Patterns are therefore anchored
 * as `^https://<host>$`: https only, and no port, because an explicit port
 * makes `url.origin` carry it and the anchor then fails.
 *
 * A "*" in a pattern becomes "[^:/]+" so "*.yallternativeliving.com" still
 * matches any subdomain but cannot swallow a port, a path or a credential.
 * Returns strings, not RegExp objects, so they serialize into the browser
 * script below.
 */
function domainPatternSources(allowedDomains) {
  return (allowedDomains ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `^https://${escapeRegExp(s).replaceAll("\\*", "[^:/]+")}$`);
}

/**
 * JSON-safe serialization for values embedded into the inline <script>. Also
 * escapes "<" so a "</script>" inside any string can't break out of the tag.
 */
function serialize(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/**
 * Build the HTML page returned from /callback. Its script performs the
 * Sveltia/Decap popup handshake:
 *   1. On load it posts "authorizing:<provider>" to its opener (the /admin
 *      window) with target "*", announcing the popup is ready.
 *   2. When the opener echoes "authorizing:<provider>" back, the popup learns
 *      the opener's real origin from the message event, and -- only if that
 *      origin is trusted -- posts the result to it and closes.
 * The result string is  authorization:<provider>:<status>:<json>  where
 * <status> is "success" or "error".
 */
function outputHTML({ provider, status, content, allowedDomains, clearCsrfCookie }) {
  const script = `
    (() => {
      const provider = ${serialize(provider)};
      const status = ${serialize(status)};
      const content = ${serialize(content)};
      const trustedPatterns = ${serialize(domainPatternSources(allowedDomains))};

      const isTrusted = (origin) => {
        // Fail CLOSED: with no ALLOWED_DOMAINS configured, trust NO origin
        // rather than handing a token to anyone (upstream fails open here; we
        // don't). ALLOWED_DOMAINS is set in wrangler.toml, so this only bites a
        // misconfigured deploy -- and then login fails safe instead of leaking
        // a token to any site that opens the popup.
        if (!trustedPatterns.length) return false;
        // Compare the FULL origin -- scheme, host and port -- not just the
        // hostname. postMessage targets an origin, so anything less is a
        // different check than the one that matters.
        let originUrl;
        try { originUrl = new URL(origin); } catch (e) { return false; }
        if (originUrl.protocol !== "https:") return false;
        return trustedPatterns.some((p) => new RegExp(p).test(originUrl.origin));
      };

      /**
       * Hand the token back to GitHub. The token is minted before this page
       * can know who opened the popup, so an untrusted opener means a live
       * token exists that must never be usable -- withholding the
       * postMessage is not enough on its own.
       */
      const revoke = (reason) => {
        if (status !== "success" || !content || !content.token) return;
        const payload = JSON.stringify({ provider, token: content.token, reason });
        try {
          if (navigator.sendBeacon) {
            navigator.sendBeacon("/revoke", new Blob([payload], { type: "application/json" }));
            return;
          }
        } catch (e) { /* fall through to fetch */ }
        fetch("/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true,
        }).catch(() => {});
      };

      const send = (origin) => {
        window.opener?.postMessage(
          "authorization:" + provider + ":" + status + ":" + JSON.stringify(content),
          origin
        );
      };

      window.addEventListener("message", ({ data, origin }) => {
        if (data !== "authorizing:" + provider) return;
        // Only hand a real token to an origin we trust. Errors carry no token,
        // so they may go back to whoever opened the popup for a clear message.
        if (status === "success" && !isTrusted(origin)) {
          revoke("untrusted_origin:" + origin);
          return;
        }
        send(origin);
        window.close();
      });

      // Announce readiness; the opener replies with the same string.
      window.opener?.postMessage("authorizing:" + provider, "*");
    })();
  `;

  const body = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <title>Signing in&hellip;</title>
  </head>
  <body>
    <p>${status === "success" ? "Signed in. You can close this window." : "Sign-in failed. You can close this window and try again."}</p>
    <script>${script}</script>
  </body>
</html>`;

  const headers = {
    "Content-Type": "text/html;charset=UTF-8",
    // The page holds a fresh access token in memory only long enough to
    // postMessage it; never let a proxy or the browser cache it.
    "Cache-Control": "no-store",
  };

  // The CSRF cookie is single-use: it exists to tie one /auth redirect to one
  // /callback. Leaving it set for its full 10-minute Max-Age leaves a valid
  // `state` value sitting in the browser for a second, unrelated callback to
  // replay.
  if (clearCsrfCookie) {
    headers["Set-Cookie"] = "csrf-token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure";
  }

  return new Response(body, { headers });
}

/** GET /auth -- kick off the OAuth flow. */
function handleAuth(request, env) {
  const { searchParams } = new URL(request.url);
  const provider = searchParams.get("provider") || "github";
  const cfg = PROVIDERS[provider];

  if (!cfg) {
    return outputHTML({
      provider,
      status: "error",
      content: { provider, error: "Unsupported OAuth provider.", errorCode: "UNSUPPORTED_PROVIDER" },
      allowedDomains: env.ALLOWED_DOMAINS,
    });
  }

  const clientId = env[cfg.clientIdEnv];
  if (!clientId) {
    return outputHTML({
      provider,
      status: "error",
      content: {
        provider,
        error: "OAuth client ID is not configured on the server.",
        errorCode: "MISCONFIGURED",
      },
      allowedDomains: env.ALLOWED_DOMAINS,
    });
  }

  // The scope is fixed by the server (PROVIDERS[provider].scope) and the
  // caller's `?scope=` is ignored on purpose -- see the comment on that field.
  const scope = cfg.scope;
  const hostname = env[cfg.hostnameEnv] || cfg.defaultHostname;

  // CSRF token: random, remembered in an HttpOnly cookie, echoed as `state`.
  const csrfToken = globalThis.crypto.randomUUID().replaceAll("-", "");

  const params = new URLSearchParams({ client_id: clientId, scope, state: csrfToken });
  // No redirect_uri sent on purpose -- GitHub uses the OAuth App's registered
  // "Authorization callback URL", which must be <this-worker>/callback.
  const authURL = `https://${hostname}${cfg.authorizePath}?${params.toString()}`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: authURL,
      "Set-Cookie": `csrf-token=${provider}_${csrfToken}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax; Secure`,
      "Cache-Control": "no-store",
    },
  });
}

/** GET /callback -- GitHub redirected back here with ?code & ?state. */
async function handleCallback(request, env) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  /* Recover the provider + CSRF token we stashed in the cookie in handleAuth.
     Anchored on a real cookie boundary -- start of the header or "; " -- not
     on \b, which also matches inside another cookie's value: a
     `junk=xcsrf-token=github_<32 hex>` cookie set by any page on the domain
     satisfied the old pattern, and the attacker then knows the `state` they
     need. */
  const [, provider, csrfToken] =
    request.headers
      .get("Cookie")
      ?.match(/(?:^|;\s*)csrf-token=([a-z-]+?)_([0-9a-f]{32})(?:\s*;|\s*$)/) ?? [];

  const cfg = provider && PROVIDERS[provider];

  const fail = (error, errorCode) =>
    outputHTML({
      provider: provider || "github",
      status: "error",
      content: { provider: provider || "github", error, errorCode },
      allowedDomains: env.ALLOWED_DOMAINS,
      clearCsrfCookie: true,
    });

  if (!cfg) return fail("Invalid or missing provider.", "UNSUPPORTED_PROVIDER");
  if (!code || !state) return fail("Failed to receive an authorization code.", "AUTH_CODE_MISSING");
  if (!csrfToken || state !== csrfToken) {
    return fail("Potential CSRF attack detected. Authentication flow aborted.", "CSRF_DETECTED");
  }

  const clientId = env[cfg.clientIdEnv];
  const clientSecret = env[cfg.clientSecretEnv];
  if (!clientId || !clientSecret) {
    return fail("OAuth credentials are not configured on the server.", "MISCONFIGURED");
  }

  const hostname = env[cfg.hostnameEnv] || cfg.defaultHostname;

  let token = "";
  let tokenError = "";
  try {
    const res = await fetch(`https://${hostname}${cfg.tokenPath}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ code, client_id: clientId, client_secret: clientSecret }),
    });
    const data = await res.json();
    token = data.access_token || "";
    tokenError = data.error_description || data.error || "";
  } catch (e) {
    tokenError = "Could not reach the OAuth token endpoint.";
  }

  if (!token) {
    return fail(tokenError || "Failed to retrieve an access token.", "TOKEN_REQUEST_FAILED");
  }

  return outputHTML({
    provider,
    status: "success",
    content: { provider, token },
    allowedDomains: env.ALLOWED_DOMAINS,
    clearCsrfCookie: true,
  });
}

/**
 * POST /revoke -- called by the callback page's own script when it finds that
 * the window which opened the popup is NOT a trusted origin.
 *
 * The token is minted at /callback, before anything can know who the opener
 * is, so by the time the origin check fails a usable GitHub token already
 * exists. Refusing to postMessage it is necessary but not sufficient: it lives
 * until someone revokes it. This asks GitHub to delete it immediately
 * (DELETE /applications/{client_id}/token, authenticated with the OAuth app's
 * own client_id:client_secret) and logs the outcome so the attempt is visible
 * in the Worker's logs.
 *
 * It takes only a token that this Worker just issued; a caller who supplies
 * someone else's token can at worst have that token revoked, which is not a
 * capability worth protecting.
 */
async function handleRevoke(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    return new Response("Bad request", { status: 400 });
  }

  const provider = typeof body.provider === "string" ? body.provider : "github";
  const cfg = PROVIDERS[provider];
  const token = typeof body.token === "string" ? body.token : "";
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 200) : "unspecified";

  if (!cfg || !token) return new Response("Bad request", { status: 400 });

  const clientId = env[cfg.clientIdEnv];
  const clientSecret = env[cfg.clientSecretEnv];
  if (!clientId || !clientSecret) return new Response("Not configured", { status: 500 });

  const hostname = env[cfg.hostnameEnv] || cfg.defaultHostname;
  const url = `${cfg.apiBase(hostname)}/applications/${encodeURIComponent(clientId)}/token`;

  try {
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "yallternative-cms-auth",
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ access_token: token }),
    });
    // 204 = revoked, 404 = already gone. Either way the token is dead.
    console.log(
      `cms-auth: revoked a token that was never delivered (reason=${reason}, github status=${res.status})`
    );
    return new Response(null, { status: 204 });
  } catch (e) {
    console.log(`cms-auth: token revocation FAILED (reason=${reason}): ${e && e.message}`);
    return new Response("Revocation failed", { status: 502 });
  }
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (method === "GET" && ["/auth", "/oauth/authorize"].includes(pathname)) {
      return handleAuth(request, env);
    }
    if (method === "GET" && ["/callback", "/oauth/redirect"].includes(pathname)) {
      return handleCallback(request, env);
    }
    if (method === "POST" && pathname === "/revoke") {
      return handleRevoke(request, env);
    }

    // A friendly root response makes "did my deploy work?" checkable in a
    // browser without exposing anything -- no secrets, no token logic here.
    if (method === "GET" && pathname === "/") {
      return new Response(
        "Y'allternative Living CMS sign-in service. Start at /auth via the /admin login button.",
        { status: 200, headers: { "Content-Type": "text/plain;charset=UTF-8" } }
      );
    }

    return new Response("Not found", { status: 404 });
  },
};

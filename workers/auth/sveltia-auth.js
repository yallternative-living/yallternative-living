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
 *   anything else                    -> 404.
 *
 * SETUP (one-time, done by Steven; see workers/README.md "Sign-in Worker") ----
 *   1. GitHub -> Settings -> Developer settings -> OAuth Apps -> New OAuth App
 *      (this is the short "OAuth App" form -- NOT the long "GitHub App" one).
 *        - Application name:  Y'allternative Living CMS login
 *        - Homepage URL:      https://yallternativeliving.com
 *        - Authorization callback URL:  <THIS-WORKER-URL>/callback
 *      Copy the Client ID, then "Generate a new client secret" and copy that.
 *   2. Deploy this folder (workers/auth) to Cloudflare -- see workers/README.md.
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
  },
};

/** Escape a string for safe interpolation into a RegExp source. */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Turn the comma-separated ALLOWED_DOMAINS var into anchored RegExp sources.
 * A "*" in a pattern becomes ".+" so "*.yallternativeliving.com" matches any
 * subdomain. Returns an array of strings (not RegExp objects) so it can be
 * serialized straight into the browser script below.
 */
function domainPatternSources(allowedDomains) {
  return (allowedDomains ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `^${escapeRegExp(s).replaceAll("\\*", ".+")}$`);
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
function outputHTML({ provider, status, content, allowedDomains }) {
  const script = `
    (() => {
      const provider = ${serialize(provider)};
      const status = ${serialize(status)};
      const content = ${serialize(content)};
      const trustedPatterns = ${serialize(domainPatternSources(allowedDomains))};

      const isTrusted = (origin) => {
        // With no ALLOWED_DOMAINS configured, fall back to trusting the opener
        // (the upstream default). Setting ALLOWED_DOMAINS is strongly advised
        // and IS set for this project -- see wrangler.toml.
        if (!trustedPatterns.length) return true;
        let host = "";
        try { host = new URL(origin).hostname; } catch (e) { return false; }
        return trustedPatterns.some((p) => new RegExp(p).test(host));
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
        if (status === "success" && !isTrusted(origin)) return;
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

  return new Response(body, {
    headers: {
      "Content-Type": "text/html;charset=UTF-8",
      // The page holds a fresh access token in memory only long enough to
      // postMessage it; never let a proxy or the browser cache it.
      "Cache-Control": "no-store",
    },
  });
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

  // Sveltia asks for a "repo" scope by default so it can read+write the repo.
  const scope = searchParams.get("scope") || "repo,user";
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

  // Recover the provider + CSRF token we stashed in the cookie in handleAuth.
  const [, provider, csrfToken] =
    request.headers.get("Cookie")?.match(/\bcsrf-token=([a-z-]+?)_([0-9a-f]{32})\b/) ?? [];

  const cfg = provider && PROVIDERS[provider];

  const fail = (error, errorCode) =>
    outputHTML({
      provider: provider || "github",
      status: "error",
      content: { provider: provider || "github", error, errorCode },
      allowedDomains: env.ALLOWED_DOMAINS,
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
  });
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

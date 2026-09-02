/**
 * @fileoverview Stateless, single-use magic-link tokens (HMAC-SHA-256, WebCrypto).
 *
 * WHY
 * Two audit findings need "prove you own this email" without a password
 * database: C-1 (points may only be spent by the customer who earned them) and
 * H-6 (order status must not hand an order to anyone who types the session id).
 * A signed token emailed to the address is the cheapest honest answer.
 *
 * DESIGN
 * The token carries its own claims and is verified by recomputing the HMAC --
 * no storage read is needed to verify, so the hot path costs zero D1 queries.
 * Storage is used for exactly one thing: burning the token so it works once
 * (`burnToken`). That single INSERT OR IGNORE is the whole state footprint.
 *
 *   token := "v1." + base64url(JSON payload) + "." + base64url(HMAC-SHA-256)
 *   payload := { e: email, p: purpose, iat: seconds, exp: seconds, jti: id }
 *
 * The signature covers "v1.<payload>", so neither the version nor any claim can
 * be edited without invalidating it. Comparison is constant-time: a byte-by-byte
 * early return would leak the correct signature one byte at a time to an
 * attacker who can measure response latency.
 *
 * `purpose` binds a token to one use ("points", "order-status"). A token minted
 * to read an order cannot be replayed to spend points.
 *
 * The secret is a Worker Secret (MAGIC_LINK_SECRET), never a var, never in
 * wrangler.toml. Rotating it invalidates every outstanding link, which is the
 * intended emergency behaviour.
 */

const PREFIX = "v1";
const DEFAULT_TTL_SECONDS = 15 * 60;
/**
 * Default ceiling on a token's life. Deliberately short: an order-status or
 * points link that works for a day is plenty, and a stolen one stops working.
 */
const MAX_TTL_SECONDS = 24 * 60 * 60;
/**
 * A caller may raise its OWN ceiling up to this, and must say so explicitly
 * (`maxTtlSeconds`). The retention emails do -- a "check your points" link at
 * the foot of a day-2 email has to still work when someone digs the email out
 * three weeks later, and a balance read is not a money-moving operation. Nothing
 * on the money path passes it, so order-status keeps its 24h cap.
 */
const ABSOLUTE_MAX_TTL_SECONDS = 180 * 24 * 60 * 60;
const MAX_TOKEN_LENGTH = 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Compares two byte arrays in time that does not depend on where they differ. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hmacKey(secret) {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new TypeError("magic-link: secret must be a string of at least 16 characters.");
  }
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function sign(secret, message) {
  const key = await hmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function randomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Mints a token. The caller emails the link; nothing is stored at this point, so
 * minting is free and an unused token simply expires.
 *
 * @param {string} secret env.MAGIC_LINK_SECRET
 * @param {{email: string, purpose: string, ttlSeconds?: number,
 *   maxTtlSeconds?: number, now?: number}} claims `maxTtlSeconds` raises this
 *   call's own ceiling above the 24h default, up to 180 days.
 * @returns {Promise<{token: string, tokenId: string, expiresAt: number, email: string}>}
 *   `expiresAt` is epoch SECONDS, matching the `exp` claim.
 */
export async function signToken(secret, claims) {
  const params = claims || {};
  if (typeof params.email !== "string" || !params.email.includes("@")) {
    throw new TypeError("magic-link: email is required.");
  }
  if (typeof params.purpose !== "string" || !/^[a-z0-9-]{3,32}$/.test(params.purpose)) {
    throw new TypeError("magic-link: purpose must be a short lowercase slug.");
  }
  const ceiling = Math.min(
    Math.max(Number(params.maxTtlSeconds) || MAX_TTL_SECONDS, 60),
    ABSOLUTE_MAX_TTL_SECONDS
  );
  const ttl = Math.min(Math.max(Number(params.ttlSeconds) || DEFAULT_TTL_SECONDS, 60), ceiling);
  const nowSeconds = Math.floor((params.now || Date.now()) / 1000);
  const email = params.email.trim().toLowerCase();
  const payload = {
    e: email,
    p: params.purpose,
    iat: nowSeconds,
    exp: nowSeconds + ttl,
    jti: randomId()
  };
  const body = `${PREFIX}.${bytesToBase64Url(encoder.encode(JSON.stringify(payload)))}`;
  const signature = await sign(secret, body);
  return {
    token: `${body}.${bytesToBase64Url(signature)}`,
    tokenId: payload.jti,
    expiresAt: payload.exp,
    email
  };
}

/**
 * Verifies signature, structure and expiry. Never throws on bad input -- a
 * malformed token is a normal event on a public endpoint.
 *
 * @param {string} secret
 * @param {string} token
 * @param {{purpose?: string, now?: number}} [options] `purpose` additionally
 *   requires the token to have been minted for that purpose.
 * @returns {Promise<{valid: boolean, reason?: string, email?: string,
 *   purpose?: string, tokenId?: string, expiresAt?: number}>}
 */
export async function verifyToken(secret, token, options = {}) {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { valid: false, reason: "malformed" };
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return { valid: false, reason: "malformed" };

  let expected;
  let provided;
  try {
    expected = await sign(secret, `${parts[0]}.${parts[1]}`);
    provided = base64UrlToBytes(parts[2]);
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (!timingSafeEqual(expected, provided)) return { valid: false, reason: "bad_signature" };

  let payload;
  try {
    payload = JSON.parse(decoder.decode(base64UrlToBytes(parts[1])));
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (!payload || typeof payload.e !== "string" || typeof payload.exp !== "number") {
    return { valid: false, reason: "malformed" };
  }

  const nowSeconds = Math.floor((options.now || Date.now()) / 1000);
  if (payload.exp <= nowSeconds) return { valid: false, reason: "expired" };
  if (options.purpose && payload.p !== options.purpose) {
    return { valid: false, reason: "wrong_purpose" };
  }
  return {
    valid: true,
    email: payload.e,
    purpose: payload.p,
    tokenId: payload.jti,
    expiresAt: payload.exp
  };
}

/**
 * Makes a verified token single-use. Call AFTER verifyToken and BEFORE acting on
 * it; act only when this returns true.
 *
 * @param {object} db D1 binding
 * @param {string} tokenId the `tokenId` from verifyToken
 * @param {number} expiresAt epoch seconds, so the sweeper can drop the row later
 * @returns {Promise<boolean>} true for the first use, false for every replay
 */
export async function burnToken(db, tokenId, expiresAt, now = Date.now()) {
  if (typeof tokenId !== "string" || !/^[a-f0-9]{8,64}$/.test(tokenId)) return false;
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO burned_tokens (token_id, expires_at, burned_at) VALUES (?, ?, ?)`
    )
    .bind(tokenId, Number(expiresAt) || 0, now)
    .run();
  return (res && res.meta && res.meta.changes) === 1;
}

/**
 * Cron housekeeping: a burned token only has to stay burned until it would have
 * expired anyway.
 *
 * @returns {Promise<number>} rows deleted
 */
export async function sweepBurnedTokens(db, now = Date.now()) {
  const res = await db
    .prepare("DELETE FROM burned_tokens WHERE expires_at < ?")
    .bind(Math.floor(now / 1000))
    .run();
  return (res && res.meta && res.meta.changes) || 0;
}

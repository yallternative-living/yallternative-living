/**
 * @fileoverview The four public retention endpoints.
 *
 *   POST /api/unsubscribe     opt out of every marketing send  (token, no PII)
 *   POST /api/welcome-code    mint a single-use welcome discount
 *   POST /api/birthday-club   store an MM/DD birthday + consent
 *   POST /api/loyalty-balance read a points balance (email AND a signed token)
 *
 * SHARED RULES
 * - Every one of them needs `STATE_DB`. Without it they return 503 rather than
 *   pretending: a birthday "saved" nowhere is the failure mode this repo has
 *   been bitten by before (see the restock route's header).
 * - Every one of them is rate-limited by IP through workers/state/rate-limit.js.
 *   A limiter is not the security boundary -- the token is -- but it slows an
 *   enumeration attempt and caps what an abusive caller can spend of the
 *   Stripe/Resend budget.
 * - No response distinguishes "we have never heard of this address" from "done".
 *   These endpoints must not become a way to test whether an address is a
 *   customer.
 */

import { ClientError, clientIp, json, readJson } from "./http.js";
import { checkRateLimit } from "../state/rate-limit.js";
import { ensureSchema } from "../state/migrations.js";
import { verifyToken } from "../state/magic-link.js";
import { balance } from "../state/loyalty.js";
import {
  contactForUnsubId,
  getWelcomeCode,
  hashEmail,
  normalizeEmail,
  normalizeMonthDay,
  saveBirthday,
  saveWelcomeCode,
  suppressEmail,
  verifyUnsubscribeToken
} from "../state/retention.js";
import { createPromotionCode } from "./stripe.js";
import { retentionConfig, WELCOME_CODE_DAYS } from "./retention-emails.js";

export const UNSUBSCRIBE_RATE_LIMIT = { limit: 20, period: 60 };
export const WELCOME_CODE_RATE_LIMIT = { limit: 5, period: 60 };
export const BIRTHDAY_RATE_LIMIT = { limit: 5, period: 60 };
export const LOYALTY_BALANCE_RATE_LIMIT = { limit: 10, period: 60 };

/**
 * Body reader that accepts BOTH a JSON fetch and a plain HTML form post, so
 * every form here still works with JavaScript switched off.
 *
 * @returns {Promise<{data: object, isForm: boolean}>}
 */
async function readBody(request) {
  const type = String(request.headers.get("Content-Type") || "").toLowerCase();
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const form = await request.formData();
    const data = {};
    for (const [key, value] of form.entries()) data[key] = typeof value === "string" ? value : "";
    return { data, isForm: true };
  }
  return { data: await readJson(request), isForm: false };
}

async function limited(request, env, key, limit) {
  const result = await checkRateLimit(env, `${key}:${clientIp(request)}`, {
    ...limit,
    failOpen: true
  });
  return !result.success;
}

function stateUnavailable(origin, env, message) {
  return json({ error: message }, 503, origin, env);
}

/* ------------------------------------------------------ POST /api/unsubscribe */

/**
 * One-click unsubscribe, RFC 8058 style.
 *
 * The URL in every marketing email's `List-Unsubscribe` header points here and
 * carries `?t=<unsub_id>.<signature>` -- an HMAC of the address, never the
 * address. Mail clients POST that URL with a `List-Unsubscribe=One-Click` body,
 * which this handler ignores entirely: the token in the query is the whole
 * request.
 *
 * A token that does not verify is refused before any database read, so this is
 * not a way to enumerate `email_contacts`. A token that verifies but names an
 * address we have never written to reports success anyway -- there is nothing
 * to unsubscribe from, and saying so would confirm the address is unknown.
 */
export async function handleUnsubscribe(request, env, origin) {
  if (!env.STATE_DB) {
    return stateUnavailable(origin, env, "Unsubscribe is temporarily unavailable.");
  }
  const config = retentionConfig(env);
  if (!config.signingSecret) {
    console.error("unsubscribe: MAGIC_LINK_SECRET is not configured");
    return stateUnavailable(origin, env, "Unsubscribe is temporarily unavailable.");
  }

  const url = new URL(request.url);
  let token = url.searchParams.get("t") || "";
  if (!token) {
    // A JSON caller (our own pages, or a support tool) may send it in the body.
    // A form post from a mail client never reaches here: its token is in the URL.
    const type = String(request.headers.get("Content-Type") || "").toLowerCase();
    if (type.includes("application/json")) {
      const body = await readJson(request);
      token = typeof body.token === "string" ? body.token : "";
    }
  }

  const check = await verifyUnsubscribeToken(config.signingSecret, token);
  if (!check.valid) {
    return json({ error: "That unsubscribe link is not valid." }, 400, origin, env);
  }

  if (await limited(request, env, "unsubscribe", UNSUBSCRIBE_RATE_LIMIT)) {
    return json({ error: "Too many requests. Please try again in a minute." }, 429, origin, env);
  }

  await ensureSchema(env.STATE_DB);
  const email = await contactForUnsubId(env.STATE_DB, check.unsubId);
  if (email) await suppressEmail(env.STATE_DB, email, "unsubscribe");

  return json(
    { success: true, message: "You're off the list. No more marketing email from us." },
    200,
    origin,
    env
  );
}

/* ----------------------------------------------------- POST /api/welcome-code */

/**
 * Mints ONE Stripe Promotion Code for a new subscriber.
 *
 * The old welcome discount was a single string in the CMS shown to every
 * visitor forever -- screenshot-and-share bait, not a discount (research-J §3).
 * This mints a fresh code per address against one shared coupon, with
 * `max_redemptions: 1` and `restrictions[first_time_transaction]: true`, so the
 * string is worthless to anyone it was not minted for and worthless to the
 * subscriber a second time.
 *
 * Idempotent by construction: `welcome_codes` is keyed on the address, so a
 * refresh returns the code already minted rather than making another one.
 *
 * When `STRIPE_WELCOME_COUPON_ID` is unset the route answers
 * `{ configured: false }` and welcome.html falls back to the CMS `welcomeCode`
 * field -- the only situation in which that static string is still shown.
 */
export async function handleWelcomeCode(request, env, origin) {
  const body = await readJson(request);
  let email;
  try {
    email = normalizeEmail(body.email);
  } catch {
    throw new ClientError("Please enter the email address you just subscribed with.");
  }

  if (await limited(request, env, "welcome-code", WELCOME_CODE_RATE_LIMIT)) {
    return json({ error: "Too many requests. Please try again in a minute." }, 429, origin, env);
  }

  const config = retentionConfig(env);
  if (!config.welcomeCouponId || !env.STRIPE_SECRET_KEY) {
    // Not an error: it is the documented "not set up yet" state, and the page
    // has a fallback for exactly this.
    return json({ configured: false }, 200, origin, env);
  }
  if (!env.STATE_DB) {
    return stateUnavailable(origin, env, "Welcome codes are temporarily unavailable.");
  }
  await ensureSchema(env.STATE_DB);

  const existing = await getWelcomeCode(env.STATE_DB, email);
  if (existing) {
    return json(
      { configured: true, code: existing.code, expiresAt: existing.expiresAt },
      200,
      origin,
      env
    );
  }

  const hash = await hashEmail(email);
  const expiresAt = Math.floor(Date.now() / 1000) + WELCOME_CODE_DAYS * 86400;
  const promo = await createPromotionCode(
    env,
    {
      couponId: config.welcomeCouponId,
      maxRedemptions: 1,
      expiresAt,
      firstTimeTransaction: true,
      metadata: { purpose: "welcome", email_hash: hash }
    },
    // Same address, same key, same code -- even if two tabs race.
    `welcome-${hash}`
  );
  if (!promo) {
    console.error("welcome-code: Stripe refused the promotion code");
    return json(
      { error: "We could not make your code just now. Please try again shortly." },
      502,
      origin,
      env
    );
  }

  await saveWelcomeCode(env.STATE_DB, {
    email,
    code: promo.code,
    promoId: promo.id,
    expiresAt: promo.expiresAt || expiresAt
  });
  // Re-read rather than trusting the mint: if two tabs raced, the INSERT OR
  // IGNORE above kept the first code and this returns that one to both.
  const stored = await getWelcomeCode(env.STATE_DB, email);
  return json(
    {
      configured: true,
      code: (stored && stored.code) || promo.code,
      expiresAt: (stored && stored.expiresAt) || expiresAt
    },
    200,
    origin,
    env
  );
}

/* ---------------------------------------------------- POST /api/birthday-club */

/**
 * Birthday club membership: an address, MM/DD, and when they said yes.
 *
 * NO YEAR, anywhere -- not in the form, not in the column, not in this handler.
 * A month and day cannot be turned into an age or used as a bank's security
 * question, which is the entire reason the existing form only ever asked for
 * MM/DD (research-J §4).
 *
 * Accepts a JSON fetch or a plain form post, so the form still works with
 * JavaScript off; a form post gets a 303 back to the page instead of JSON.
 */
export async function handleBirthdayClub(request, env, origin) {
  const { data, isForm } = await readBody(request);
  const config = retentionConfig(env);

  const done = (payload, status) => {
    if (!isForm) return json(payload, status, origin, env);
    const state = payload && payload.success ? "saved" : "error";
    return new Response(null, {
      status: 303,
      headers: {
        Location: `${config.siteOrigin}/thank-you.html?birthday=${state}#birthday-club-reward`,
        "Cache-Control": "no-store"
      }
    });
  };

  // Same silent honeypot the restock route uses: a bot that can tell it was
  // caught is a bot that stops filling the field in.
  if (data.website_hp || data.bday_website) {
    return done({ success: true, message: "Birthday saved." }, 200);
  }

  let email;
  let monthDay;
  try {
    email = normalizeEmail(data.email || data.email_address);
  } catch {
    return done({ error: "Please enter a valid email address." }, 400);
  }
  try {
    monthDay = normalizeMonthDay(data.birthday || data.monthDay || data["fields[birthday]"]);
  } catch {
    return done({ error: "Please give your birthday as MM/DD, e.g. 06/14." }, 400);
  }

  if (await limited(request, env, "birthday-club", BIRTHDAY_RATE_LIMIT)) {
    return done({ error: "Too many requests. Please try again in a minute." }, 429);
  }
  if (!env.STATE_DB) {
    return isForm
      ? done({ error: "unavailable" }, 503)
      : stateUnavailable(origin, env, "The birthday club is temporarily unavailable.");
  }
  await ensureSchema(env.STATE_DB);
  await saveBirthday(env.STATE_DB, { email, monthDay, source: "thank-you" });

  return done(
    {
      success: true,
      message: "You're in. We'll send something your way on the day."
    },
    200
  );
}

/* -------------------------------------------------- POST /api/loyalty-balance */

/**
 * Reads an Alt-Points balance.
 *
 * REQUIRES BOTH the address and a signed `points` token that was emailed to
 * that address. Balance-by-email-alone would let anyone type a customer's
 * address into a form and learn what they have spent; that is the shape of the
 * bug audit finding C-1 was about, in read-only form.
 *
 * The token is NOT burned. It reads, it does not spend, and a link at the foot
 * of an email has to keep working on the second click.
 */
export async function handleLoyaltyBalance(request, env, origin) {
  const body = await readJson(request);
  const config = retentionConfig(env);
  if (!env.STATE_DB || !config.signingSecret) {
    return stateUnavailable(origin, env, "Points are temporarily unavailable.");
  }

  if (await limited(request, env, "loyalty-balance", LOYALTY_BALANCE_RATE_LIMIT)) {
    return json({ error: "Too many requests. Please try again in a minute." }, 429, origin, env);
  }

  let email;
  try {
    email = normalizeEmail(body.email);
  } catch {
    throw new ClientError("Please enter a valid email address.");
  }
  const check = await verifyToken(config.signingSecret, String(body.token || ""), {
    purpose: "points"
  });
  // One message for every refusal. Saying "expired" versus "wrong email" tells
  // a caller which half they got right.
  if (!check.valid || check.email !== email) {
    return json({ error: "That points link is not valid any more." }, 403, origin, env);
  }

  await ensureSchema(env.STATE_DB);
  const points = await balance(env.STATE_DB, email);
  return json(
    {
      balance: points,
      threshold: config.loyaltyThreshold,
      rewardCents: config.loyaltyRewardCents,
      // How many more points until the Worker mints a code on its own. There is
      // nothing to click: redemption is automatic (see payOutLoyalty).
      pointsToReward: Math.max(0, config.loyaltyThreshold - points)
    },
    200,
    origin,
    env
  );
}

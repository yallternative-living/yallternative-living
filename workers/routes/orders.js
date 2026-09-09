/**
 * @fileoverview The passwordless order history behind /orders.html.
 *
 *   POST /api/orders/request-link  { email }   -> a one-time link by email
 *   GET  /api/orders?token=...                 -> the orders behind that link
 *
 * NO ACCOUNTS, NO PASSWORDS. A repeat buyer types the address they ordered
 * with; if the shop has orders for it, a signed link lands in that inbox. The
 * link proves the person can read that mailbox, which is the same proof
 * Stripe's receipt already relies on, and it costs the shop no password
 * database to lose.
 *
 * NEUTRALITY. request-link answers the SAME `200` whatever the address --
 * known, unknown, unsubscribed, or one whose email could not be sent. The
 * send itself runs behind ctx.waitUntil so the response time does not
 * change with the answer either. This endpoint must not become a way to test
 * whether an address has shopped here. The only non-200 answers are a
 * malformed address (400 -- the caller typed it and can see it), a rate
 * limit (429, the same for every address) and a missing binding (503).
 *
 * RATE LIMITS. 3 requests per 10 minutes per client AND per address hash, so
 * neither one caller cycling addresses nor many callers hammering one address
 * can spend the Resend budget or flood a mailbox. The list endpoint is
 * limited per client too; a token is single-use so a second call with the
 * same one is refused before the limiter matters.
 *
 * THE TOKEN carries the SHA-256 of the address as its subject, never the
 * address (state/magic-link.js), so the URL a mail client logs, a browser
 * keeps in history and a proxy writes down holds no PII. Purpose `orders`
 * only: a points token or an unsubscribe token cannot be replayed here.
 * 24 hours, then it expires; one use, then it is burned (`burned_tokens`).
 *
 * WHAT COMES BACK. The orders for that hash and nothing else (state/orders.js
 * -- no address, no name, no street, no gift text), plus the points balance
 * when the loyalty switch in /admin is on. `Cache-Control: no-store`, like
 * every JSON answer on this Worker (routes/http.js).
 *
 * The page itself, its wording and its switch (`site.enableOrderHistory`)
 * are the owner's, in content.json and /admin. Off means both endpoints
 * answer 404 and the page shows the contact hand-off instead of a form.
 */

import { ClientError, clientIp, escapeHtml, json, readJson } from "./http.js";
import { checkRateLimit } from "../state/rate-limit.js";
import { ensureSchema } from "../state/migrations.js";
import { burnToken, signToken, verifyToken } from "../state/magic-link.js";
import { balance } from "../state/loyalty.js";
import { hashEmail, isSuppressed, normalizeEmail } from "../state/retention.js";
import { emailForHash, hasOrders, listOrders, MAX_ORDERS_LISTED } from "../state/orders.js";
import { loadSiteSettings } from "../state/site-data.js";
import { fromAddress, sendEmail } from "./gift-cards.js";
import { retentionConfig } from "./retention-emails.js";

export const ORDERS_LINK_RATE_LIMIT = { limit: 3, period: 600 };
export const ORDERS_LIST_RATE_LIMIT = { limit: 10, period: 60 };
export const ORDERS_TOKEN_PURPOSE = "orders";
export const ORDERS_TOKEN_TTL_SECONDS = 24 * 60 * 60;

const REPLY_TO = "contact@yallternativeliving.com";

/** The one answer request-link gives for any address. */
export const NEUTRAL_MESSAGE =
  "If we have orders for that address, a link is on its way. It works once and expires in 24 hours.";

/** The one refusal the list endpoint gives, whatever went wrong with the token. */
const BAD_LINK_MESSAGE = "That link is not valid any more. Ask for a fresh one below.";

function unavailable(origin, env, message) {
  return json({ error: message }, 503, origin, env);
}

function switchedOff(origin, env) {
  return json({ error: "Order history is switched off." }, 404, origin, env);
}

async function historyEnabled(env, ctx) {
  const site = await loadSiteSettings(env, ctx);
  return site.enableOrderHistory !== false;
}

/**
 * The email carrying the link. Plain, transactional, no unsubscribe footer:
 * the customer asked for it thirty seconds ago.
 */
export function orderLinkEmail(linkUrl) {
  const safeUrl = escapeHtml(linkUrl);
  const html =
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; ' +
    'background: #17130f; color: #fff; padding: 32px; border-radius: 12px; border: 2px solid #d69b5c;">' +
    '<h1 style="color:#d69b5c;">Your orders, one click away</h1>' +
    "<p>Somebody -- hopefully you -- asked to see the orders placed with this address. " +
    "Here is the door:</p>" +
    '<div style="text-align:center;margin:28px 0;"><a href="' +
    safeUrl +
    '" style="display:inline-block;background:#d69b5c;color:#17130f;text-decoration:none;' +
    "padding:14px 28px;font-weight:bold;border-radius:4px;text-transform:uppercase;" +
    'letter-spacing:1px;">See my orders</a></div>' +
    '<p style="font-size:13px;color:#c9b8a8;">The link works once and expires in 24 hours. ' +
    "If you did not ask for it, ignore this email -- nothing happens unless it is clicked, " +
    "and it only ever opens for whoever holds this inbox.</p>" +
    "</div>";
  const text =
    "Your orders, one click away.\n\n" +
    "Somebody -- hopefully you -- asked to see the orders placed with this address. " +
    `Here is the door:\n\n${linkUrl}\n\n` +
    "The link works once and expires in 24 hours. If you did not ask for it, ignore this " +
    "email -- nothing happens unless it is clicked, and it only ever opens for whoever holds " +
    "this inbox.";
  return { subject: "Your Y'allternative Living orders", html, text };
}

/**
 * Mints and sends the link for one address, when there is anything to show.
 * Every early return is silent by design -- see NEUTRALITY above.
 *
 * @returns {Promise<{sent: boolean, reason?: string}>} for the log and tests
 */
export async function sendOrderLink(env, email, emailHash, now = Date.now()) {
  const db = env.STATE_DB;
  const config = retentionConfig(env);
  if (!(await hasOrders(db, emailHash))) return { sent: false, reason: "no-orders" };
  if (await isSuppressed(db, email)) return { sent: false, reason: "suppressed" };
  const minted = await signToken(config.signingSecret, {
    subject: emailHash,
    purpose: ORDERS_TOKEN_PURPOSE,
    ttlSeconds: ORDERS_TOKEN_TTL_SECONDS,
    now
  });
  const link = `${config.siteOrigin}/orders.html?token=${encodeURIComponent(minted.token)}`;
  const body = orderLinkEmail(link);
  const delivery = await sendEmail(
    env,
    { from: fromAddress(env), to: email, reply_to: REPLY_TO, ...body },
    `orders-link-${minted.tokenId}`
  );
  if (!delivery.ok) {
    console.error(`orders: Resend refused the link email (${delivery.status})`);
    return { sent: false, reason: "resend-refused" };
  }
  return { sent: true };
}

/* --------------------------------------------- POST /api/orders/request-link */

export async function handleOrdersRequestLink(request, env, origin, ctx) {
  const body = await readJson(request);
  let email;
  try {
    email = normalizeEmail(body.email);
  } catch {
    throw new ClientError("Please enter the email address you ordered with.");
  }

  const config = retentionConfig(env);
  if (!env.STATE_DB || !config.signingSecret) {
    return unavailable(origin, env, "Order history is temporarily unavailable.");
  }
  if (!(await historyEnabled(env, ctx))) return switchedOff(origin, env);

  const emailHash = await hashEmail(email);
  const perClient = await checkRateLimit(env, `orders-link:${clientIp(request)}`, {
    ...ORDERS_LINK_RATE_LIMIT,
    failOpen: true
  });
  const perAddress = await checkRateLimit(env, `orders-link:h:${emailHash}`, {
    ...ORDERS_LINK_RATE_LIMIT,
    failOpen: true
  });
  if (!perClient.success || !perAddress.success) {
    return json(
      { error: "Too many requests. Please try again in ten minutes." },
      429,
      origin,
      env
    );
  }

  await ensureSchema(env.STATE_DB);
  // Behind waitUntil so the answer takes the same time whether or not an
  // email goes out. A ctx without waitUntil (the unit harness) awaits it.
  const work = sendOrderLink(env, email, emailHash).catch((err) => {
    console.error("orders: link send failed:", err && err.message);
    return { sent: false, reason: "threw" };
  });
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(work);
  else await work;

  return json({ ok: true, message: NEUTRAL_MESSAGE }, 200, origin, env);
}

/* ----------------------------------------------------------- GET /api/orders */

export async function handleOrdersList(request, env, origin, ctx) {
  const config = retentionConfig(env);
  if (!env.STATE_DB || !config.signingSecret) {
    return unavailable(origin, env, "Order history is temporarily unavailable.");
  }
  if (!(await historyEnabled(env, ctx))) return switchedOff(origin, env);

  const limit = await checkRateLimit(env, `orders-list:${clientIp(request)}`, {
    ...ORDERS_LIST_RATE_LIMIT,
    failOpen: true
  });
  if (!limit.success) {
    return json({ error: "Too many requests. Please try again in a minute." }, 429, origin, env);
  }

  const token = new URL(request.url).searchParams.get("token") || "";
  const check = await verifyToken(config.signingSecret, token, { purpose: ORDERS_TOKEN_PURPOSE });
  // One message for every refusal: expired, tampered, wrong purpose, a points
  // token, an email-bearing token -- saying which would say something.
  if (!check.valid || !check.subject) {
    return json({ error: BAD_LINK_MESSAGE }, 403, origin, env);
  }

  await ensureSchema(env.STATE_DB);
  const first = await burnToken(env.STATE_DB, check.tokenId, check.expiresAt);
  if (!first) return json({ error: BAD_LINK_MESSAGE }, 403, origin, env);

  const orders = await listOrders(env.STATE_DB, check.subject, MAX_ORDERS_LISTED);

  let loyalty = null;
  const site = await loadSiteSettings(env, ctx);
  if (site.enableLoyaltyPoints !== false) {
    const email = await emailForHash(env.STATE_DB, check.subject);
    if (email) {
      const points = await balance(env.STATE_DB, email);
      loyalty = {
        balance: points,
        threshold: config.loyaltyThreshold,
        rewardCents: config.loyaltyRewardCents,
        pointsToReward: Math.max(0, config.loyaltyThreshold - points)
      };
    }
  }

  return json({ orders, loyalty }, 200, origin, env);
}

/**
 * @fileoverview POST /api/restock -- "email me when this is back".
 *
 * Ported from netlify/functions/submit-restock.js, which forwarded the request
 * to the shop by email through Resend. That is still the whole endpoint: there
 * is no restock table, and inventing one would create a second place the shop
 * has to remember to look.
 *
 * Two behaviours are load-bearing and were kept exactly:
 *   - The honeypot (`website_hp`) gets the SAME success shape a person gets.
 *     A bot that can tell it was caught is a bot that stops filling the field.
 *   - A missing RESEND_API_KEY is a 503, not a cheerful "we'll let you know".
 *     The version before that returned success while sending nothing anywhere,
 *     so every restock request the site ever collected was dropped on the floor
 *     while the shopper was told it had been received.
 *
 * What is new is the rate limit the old file's header comment claimed and did
 * not have.
 */

import { json, readJson, clientIp, escapeHtml, stripControlChars } from "./http.js";
import { checkRateLimit } from "../state/rate-limit.js";

export const RESTOCK_RATE_LIMIT = { limit: 5, period: 60 };
export const DEFAULT_NOTIFY_EMAIL = "contact@yallternativeliving.com";

/** Control characters (CR/LF included) never reach a header or subject line. */
function clean(value) {
  return (
    String(value === null || value === undefined ? "" : value)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F]/g, " ")
      .trim()
  );
}

export async function handleRestock(request, env, origin) {
  const body = await readJson(request, "Invalid request payload.");

  const email = clean(body.email);
  const product = clean(body.product || body.product_id || body.productId).slice(0, 200);
  const honeypot = body.website_hp || body.hp_field;

  // Silent honeypot rejection: same body, same status, nothing sent, nothing
  // logged.
  if (honeypot) {
    return json({ success: true, message: "Request received." }, 200, origin, env);
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "Please enter a valid email address." }, 400, origin, env);
  }

  const limit = await checkRateLimit(env, `restock:${clientIp(request)}`, {
    ...RESTOCK_RATE_LIMIT,
    failOpen: true
  });
  if (!limit.success) {
    return json(
      { error: "Too many requests. Please wait a minute and try again." },
      429,
      origin,
      env
    );
  }

  if (!env.RESEND_API_KEY) {
    console.error("restock: RESEND_API_KEY is not configured; request not forwarded");
    return json(
      { error: "Restock alerts are temporarily unavailable. Please email us instead." },
      503,
      origin,
      env
    );
  }

  const to = env.RESTOCK_NOTIFY_EMAIL || DEFAULT_NOTIFY_EMAIL;
  const from =
    env.RESTOCK_FROM_EMAIL ||
    env.GIFT_CARD_FROM_EMAIL ||
    "Y'allternative Living <orders@yallternativeliving.com>";
  const safeProduct = product || "this item";

  let delivered = false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from,
        to,
        // The requester's address is the reply-to, never the From: it is
        // unverified input and this account's sending reputation is not.
        reply_to: stripControlChars(email),
        subject: `Restock request: ${safeProduct}`,
        html:
          `<p><strong>${escapeHtml(email)}</strong> wants to be told when ` +
          `<strong>${escapeHtml(safeProduct)}</strong> is back in stock.</p>`,
        text: `${email} wants to be told when ${safeProduct} is back in stock.`
      })
    });
    delivered = Boolean(res && res.ok);
  } catch (err) {
    console.error("restock: notification failed to send:", err && err.message);
    delivered = false;
  }

  if (!delivered) {
    return json(
      { error: "We could not record that request just now. Please try again shortly." },
      502,
      origin,
      env
    );
  }

  return json(
    {
      success: true,
      message: `Thank you! We'll notify ${escapeHtml(email)} when ${escapeHtml(safeProduct)} is back in stock.`
    },
    200,
    origin,
    env
  );
}

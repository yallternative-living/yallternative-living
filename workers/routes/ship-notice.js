/**
 * @fileoverview "Your order is on its way" -- the one email between the Stripe
 * receipt and the how-to-use guide.
 *
 * WHAT TRIGGERS IT: THE HOURLY CRON, NOT A WEBHOOK.
 * The shop marks an order shipped the way order-status.html already reads it:
 * three metadata keys typed onto the PaymentIntent in the Stripe Dashboard
 * (`fulfillment_status`, `tracking_url`, `shipped_at` -- see
 * state/stripe-orders.js). Nothing in Stripe fires when that metadata is
 * written -- see runShipNoticeSweep below for the event list that proves it --
 * so the Worker's hourly cron lists recent PaymentIntents and sends for every
 * one that now reads as shipped and has not been told yet. Expect the email
 * within the hour of the save, not within seconds.
 *
 * WHY IT EXISTS
 * thank-you.html has always closed with "we'll follow up once it ships" and
 * policies.html tells a customer whose parcel goes missing to "contact the
 * carrier directly with your tracking number" -- a number nothing had ever
 * sent them. The fulfilment metadata was readable only by someone who
 * remembered the order-status page existed, came back to it unprompted, and
 * still had their `cs_...` reference. This closes that: the status page stays
 * the pull, this is the push.
 *
 * IT IS TRANSACTIONAL, NOT MARKETING.
 * It is a fact about a parcel somebody paid for, so it goes through `sendEmail`
 * and NOT `sendMarketingEmail`: no unsubscribe footer, no suppression check.
 * Someone who opted out of the review request is still owed their tracking
 * number. That is also why it is not queued in `email_queue` -- everything the
 * drain touches is a marketing send by construction.
 *
 * SENT ONCE PER PARCEL, NOT ONCE PER TICK.
 * The sweep sees the same shipped order on every hourly pass for 45 days, and
 * a typo fixed in the tracking link the next day changes nothing about that.
 * `order_emails` (state/order-emails.js) records the send against the
 * PaymentIntent id AFTER Resend accepts it, so every later pass does nothing --
 * and a refused send records nothing, so the next pass retries it.
 */

import { escapeHtml } from "./http.js";
import { buyerEmailOf, findSessionByPaymentIntent, stripeGet } from "./stripe.js";
import { fromAddress, sendEmail } from "./gift-cards.js";
import { safeUrl } from "../state/stripe-orders.js";
import { loadSiteSettings } from "../state/site-data.js";
import { orderEmailSent, recordOrderEmail, SHIP_NOTICE } from "../state/order-emails.js";
import { reanchorOrderSequence } from "./retention-emails.js";

const REPLY_TO = "contact@yallternativeliving.com";

/**
 * The `fulfillment_status` values that mean the parcel is gone.
 *
 * MUST STAY IN STEP WITH `orderStatusPlainWords` in assets/js/main.js, which
 * turns the same three strings into the word "Shipped" on order-status.html. A
 * status that says "Shipped" on the page but sends no email, or the reverse, is
 * the kind of drift nobody notices until a customer asks.
 */
export const SHIPPED_STATUSES = ["shipped", "delivered", "fulfilled"];

/** @returns {boolean} true when this metadata value means "it has left". */
export function isShippedStatus(value) {
  return SHIPPED_STATUSES.includes(
    String(value || "")
      .trim()
      .toLowerCase()
  );
}

/**
 * The buyer's shipping email.
 *
 * `reference` is the `cs_...` the customer already has -- it is on the
 * thank-you page and in Stripe's receipt -- and order-status.html reads
 * `?session_id=` to prefill its lookup form, so the link lands on a page that
 * is one click from answering "where is it".
 */
export function shipNoticeEmail(reference, trackingUrl, siteOrigin) {
  const statusUrl = `${siteOrigin}/order-status.html?session_id=${encodeURIComponent(reference)}`;
  const track = trackingUrl
    ? `<div style="text-align:center;margin:28px 0;"><a href="${escapeHtml(trackingUrl)}" ` +
      'style="display:inline-block;background:#d69b5c;color:#17130f;text-decoration:none;' +
      "padding:14px 28px;font-weight:bold;border-radius:4px;text-transform:uppercase;" +
      'letter-spacing:1px;">Track this shipment</a></div>'
    : '<p style="font-size:13px;color:#c9b8a8;">No tracking link on this one yet. If it has not ' +
      "turned up in a few days, hit reply and we will chase it down.</p>";

  const html =
    '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; ' +
    'background: #17130f; color: #fff; padding: 32px; border-radius: 12px; border: 2px solid #d69b5c;">' +
    '<h1 style="color:#d69b5c;">It is on its way</h1>' +
    "<p>Packed by hand, taped up, and handed over to the carrier. Your order has left Landrum, " +
    "SC and is officially somebody else's problem for a few days.</p>" +
    track +
    '<p style="font-size:13px;color:#c9b8a8;">Your reference is ' +
    `<strong>${escapeHtml(reference)}</strong>. You can check where it stands any time at ` +
    `<a style="color:#d69b5c;" href="${escapeHtml(statusUrl)}">order status</a>.</p>` +
    '<p style="font-size:13px;color:#c9b8a8;">Anything not right when it lands -- wrong item, ' +
    "sad jar, nothing at all -- hit reply. A real person reads it.</p>" +
    "</div>";

  const text =
    "It is on its way.\n\n" +
    "Packed by hand, taped up, and handed over to the carrier. Your order has left Landrum, SC " +
    "and is officially somebody else's problem for a few days.\n\n" +
    (trackingUrl
      ? `Track this shipment: ${trackingUrl}\n\n`
      : "No tracking link on this one yet. If it has not turned up in a few days, hit reply and " +
        "we will chase it down.\n\n") +
    `Your reference is ${reference}. Check where it stands any time:\n${statusUrl}\n\n` +
    "Anything not right when it lands, hit reply. A real person reads it.";

  return { subject: "Your order just left Landrum", html, text };
}

/**
 * Sends the notice for one PaymentIntent, if it is due one.
 *
 * Called for every shipped intent the sweep finds, every hour, so ORDER OF THE
 * CHECKS IS THE COST CONTROL: is the status a shipped one, and has this order
 * already been written to -- both answered before the Stripe session lookup,
 * so an order told last week costs one D1 read and no API call per tick.
 *
 * A REFUSED SEND THROWS, with nothing recorded. The sweep catches it, counts
 * it, carries on with the rest, and the next hourly pass tries this order
 * again. (The dormant webhook branch in stripe-webhook.js catches the same
 * throw as a failure, which would make Stripe redeliver -- if Stripe ever
 * sent the event.)
 *
 * @param {object} intent the PaymentIntent, from the sweep's list
 * @param {object} env    needs STRIPE_SECRET_KEY, RESEND_API_KEY; STATE_DB optional
 * @param {object} [ctx]  the Worker execution context, for the settings fetch
 * @returns {Promise<object>} an outcome for the webhook's own log
 */
export async function emailShipNotice(intent, env, ctx, now = Date.now()) {
  const metadata = (intent && intent.metadata) || {};
  if (!isShippedStatus(metadata.fulfillment_status)) return { skipped: "not-shipped" };

  const intentId = intent && typeof intent.id === "string" ? intent.id : "";
  if (!intentId) return { skipped: "no-payment-intent-id" };

  const db = env.STATE_DB || null;
  if (db && (await orderEmailSent(db, SHIP_NOTICE, intentId))) {
    return { skipped: "already-sent" };
  }

  const session = await findSessionByPaymentIntent(env, intentId);
  if (!session) return { skipped: "no-session" };
  const to = buyerEmailOf(session);
  if (!to) return { skipped: "no-buyer-email" };

  const trackingUrl = safeUrl(metadata.tracking_url);
  const siteOrigin = env.SITE_ORIGIN || "https://yallternativeliving.com";
  const body = shipNoticeEmail(session.id, trackingUrl, siteOrigin);

  const delivery = await sendEmail(
    env,
    { from: fromAddress(env), to, reply_to: REPLY_TO, ...body },
    `ship-notice-${intentId}`
  );
  if (!delivery.ok) {
    // Nothing recorded, so Stripe's redelivery gets a clean run at it.
    throw new Error(`Resend refused the ship notice for ${intentId}`);
  }

  const outcome = { emailed: to, order: session.id, tracking: Boolean(trackingUrl) };
  if (!db) {
    // No claim table means no memory of this send beyond Resend's own
    // idempotency window. The notice still goes -- an order nobody is told
    // about is worse than a duplicate weeks later -- but say so in the log.
    console.warn("ship-notice: STATE_DB is missing; this send is not recorded");
    return { ...outcome, recorded: false, reanchored: null };
  }
  await recordOrderEmail(db, SHIP_NOTICE, intentId, now);

  /* The parcel is gone, so the post-purchase sequence finally has a real
     dispatch time to hang off instead of the pessimistic assumption booked when
     the order was paid (see the header of routes/retention-emails.js).
     Non-fatal: the emails are already scheduled and would still go out on the
     assumed dates, which is not worth replaying a delivered notice for. */
  let reanchored = null;
  try {
    reanchored = await reanchorOrderSequence(
      db,
      session.id,
      now,
      now,
      await loadSiteSettings(env, ctx)
    );
  } catch (err) {
    console.warn("ship-notice: could not re-anchor the sequence:", err && err.message);
  }
  return { ...outcome, recorded: true, reanchored };
}

/* ------------------------------------------------------------- the sweep */

/** How far back the sweep looks. An order older than this that is only now
    being marked shipped is a correction, not a dispatch worth an email. */
export const SWEEP_WINDOW_DAYS = 45;
const SWEEP_PAGE = 100;
const SWEEP_MAX_PAGES = 10;

/**
 * The real trigger for the ship notice.
 *
 * Stripe fires NO event when the metadata on a PaymentIntent is edited --
 * checked against the full snapshot-event list on 2026-09-04: the
 * payment_intent.* events are created, succeeded, payment_failed, canceled,
 * processing, requires_action, amount_capturable_updated and
 * partially_funded, and `payment_intent.updated` does not exist (only
 * `charge.updated` and `transfer.updated` fire on a metadata edit). The
 * webhook branch that listens for it is therefore never reached; this sweep,
 * run from the Worker's hourly cron, is what actually sends the email.
 *
 * It lists the PaymentIntents of the last SWEEP_WINDOW_DAYS and hands every
 * one whose `fulfillment_status` reads shipped to emailShipNotice(), which
 * already refuses to send twice (order_emails) and already returns early for
 * everything that is not a dispatch. A Resend failure for one order is
 * logged and does not stop the rest; the next tick retries it, because
 * nothing was recorded.
 *
 * @param {object} env needs STRIPE_SECRET_KEY, RESEND_API_KEY, STATE_DB
 * @param {object} [ctx]
 * @param {number} [now]
 * @returns {Promise<object>} counts for the cron log
 */
export async function runShipNoticeSweep(env, ctx, now = Date.now()) {
  if (!env || !env.STRIPE_SECRET_KEY) return { skipped: "no-stripe-key" };
  const createdGte = Math.floor(now / 1000) - SWEEP_WINDOW_DAYS * 86400;
  const counts = { scanned: 0, shipped: 0, sent: 0, skipped: 0, failed: 0 };
  let startingAfter = null;
  for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      limit: String(SWEEP_PAGE),
      "created[gte]": String(createdGte)
    });
    if (startingAfter) params.set("starting_after", startingAfter);
    const list = await stripeGet(env, `/payment_intents?${params.toString()}`);
    if (!list || !Array.isArray(list.data)) break;
    for (const intent of list.data) {
      counts.scanned++;
      const metadata = (intent && intent.metadata) || {};
      if (!isShippedStatus(metadata.fulfillment_status)) continue;
      counts.shipped++;
      try {
        const outcome = await emailShipNotice(intent, env, ctx, now);
        if (outcome && outcome.emailed) counts.sent++;
        else counts.skipped++;
      } catch (err) {
        counts.failed++;
        console.error("ship-notice sweep:", intent && intent.id, err && err.message);
      }
    }
    if (!list.has_more || !list.data.length) break;
    startingAfter = list.data[list.data.length - 1].id;
  }
  return counts;
}

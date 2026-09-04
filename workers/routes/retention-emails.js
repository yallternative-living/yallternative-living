/**
 * @fileoverview The retention sends themselves: templates, the one send
 * function every marketing email goes through, and the three jobs the cron
 * handler runs (drain the queue, run the birthday club, pay out loyalty).
 *
 * THE SEQUENCE
 *   checkout.session.completed -> order_signals row
 *                              -> "how to use your <product>"   at dispatch + 4d
 *                              -> review request                at dispatch + 7d
 *                                 (apparel / gift cards) or +12d (salves,
 *                                 soaks, body butter -- long enough for a few
 *                                 real uses; see research-J §6)
 *   hourly ship-notice sweep   -> both of the above re-anchored on the real
 *                                 dispatch moment (routes/ship-notice.js; no
 *                                 Stripe event fires for a metadata edit)
 *   checkout.session.expired   -> recovery link                 at +45 minutes
 *   cron, daily                -> birthday code                 on the day
 *   loyalty balance >= threshold -> $5 code, debited atomically
 *
 * EVERY POST-PURCHASE DELAY IS MEASURED FROM DISPATCH, NOT FROM PAYMENT.
 * These emails talk to someone holding the thing -- "here's how to use it",
 * "how's it treating you" -- so the clock has to start when the parcel leaves,
 * not when the card clears. They were hung off `placed_at` originally, which
 * put "how to get the most out of your salve" in the inbox 2.5 days after
 * checkout while policies.html was still promising to dispatch within 1-3
 * BUSINESS days: a Friday order was asked about a jar that had not been packed
 * yet. Nothing here knows about delivery, so dispatch is the best anchor
 * available, and it arrives two ways -- assumed at enqueue time, then corrected
 * by `reanchorOrderSequence` the moment the shop actually marks the order
 * shipped.
 *
 * EVERY SEND IN THIS FILE IS A MARKETING SEND, and all of them go through
 * `sendMarketingEmail`, which does three things no caller may skip:
 *   1. Refuses if the address is on `email_suppression` -- checked at SEND
 *      time, not at enqueue time, so an unsubscribe on day 3 stops the review
 *      request that was queued on day 0.
 *   2. Adds `List-Unsubscribe` and `List-Unsubscribe-Post` so a one-click
 *      unsubscribe in Gmail or Apple Mail actually works (RFC 8058).
 *   3. Adds the visible opt-out line to the body.
 * The unsubscribe URL carries an HMAC-derived opaque id, never the address:
 * a URL ends up in logs, proxies, referrers and screenshots.
 *
 * REVIEWS ARE NEVER INCENTIVISED, CONDITIONALLY OR OTHERWISE.
 * The FTC's Rule on Consumer Reviews (16 CFR 465, effective 2024-10-21) bans
 * conditioning a reward on the review being positive. The simplest way to stay
 * on the right side of that line at this volume is to offer nothing at all for
 * a review, which is what these templates do -- there is no code, no discount
 * and no "we'd love five stars" anywhere in them. If a reward is ever added it
 * has to be unconditional AND disclosed; do not add one here casually.
 */

import { escapeHtml } from "./http.js";
import { fromAddress, sendEmail } from "./gift-cards.js";
import { createPromotionCode } from "./stripe.js";
import { loadPointsPerDollar, loadProductIndex, loadSiteSettings } from "../state/site-data.js";
import { balance, credit, debit } from "../state/loyalty.js";
import { signToken } from "../state/magic-link.js";
import {
  birthdaysOn,
  dueEmails,
  enqueueEmail,
  getOrderSignal,
  getQueuedEmail,
  hashEmail,
  isSuppressed,
  markEmailFailed,
  markEmailSent,
  markEmailSkipped,
  normalizeEmail,
  rememberContact,
  rescheduleQueuedEmail,
  unsubscribeId,
  unsubscribeToken
} from "../state/retention.js";

const REPLY_TO = "contact@yallternativeliving.com";
const HOUR = 3600000;
const DAY = 24 * HOUR;

/**
 * How long after DISPATCH the how-to-use email waits: research-J §8's day-2-3
 * cadence, plus enough ground transit for the parcel to have landed first.
 * The default behind the `usageGuideDelayDays` CMS field.
 */
export const USAGE_GUIDE_AFTER_DISPATCH_MS = 4 * DAY;

/** The range the CMS field is clamped to. Zero is legitimate: "on dispatch". */
export const USAGE_GUIDE_DELAY_MAX_DAYS = 60;

/**
 * The how-to-use delay Savanna has set, in ms.
 *
 * `site.usageGuideDelayDays` is a number field at /admin. Anything unset, blank
 * or unparseable falls back to the default rather than to zero -- a fat-fingered
 * field must not turn a considered email into one that arrives while the parcel
 * is still on the van.
 *
 * @param {object} site the `site` object from content.json
 */
export function usageGuideDelayMs(site) {
  const raw = (site || {}).usageGuideDelayDays;
  // Tested BEFORE Number(), because Number("") and Number(null) are both 0 --
  // a field the CMS cleared would otherwise read as a deliberate "on dispatch"
  // and mail the guide while the parcel was still on the van.
  if (raw === "" || raw === null || raw === undefined) return USAGE_GUIDE_AFTER_DISPATCH_MS;
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) return USAGE_GUIDE_AFTER_DISPATCH_MS;
  return Math.min(days, USAGE_GUIDE_DELAY_MAX_DAYS) * DAY;
}

/**
 * The how-to-use email's on/off switch (`site.enableUsageGuideEmails`).
 *
 * ABSENT MEANS ON, which is how every other `enable*` switch in content.json
 * behaves and how this email shipped. Read at SEND time, not at enqueue time,
 * for the same reason the suppression list is: turning it off has to stop the
 * guides already sitting in the queue, not just future ones.
 */
export function usageGuideEnabled(site) {
  return (site || {}).enableUsageGuideEmails !== false;
}

/**
 * What we assume dispatch was, until the shop tells us otherwise.
 *
 * The top of the window policies.html promises ("most orders ship in 1-3
 * business days"), so an order nobody ever marks shipped -- the fulfilment
 * metadata is typed by hand, and a busy week is exactly when it gets skipped --
 * still cannot be asked about before the shop's own stated dispatch date.
 * Deliberately pessimistic: an email that lands a day late reads as considered,
 * one that lands before the box does reads as a bot.
 */
export const ASSUMED_DISPATCH_MS = 3 * DAY;

/**
 * Categories that are never packed, so their "dispatch" is the checkout itself.
 *
 * A gift card is minted and emailed by the same webhook that records the order
 * (issuePurchasedCards in routes/stripe-webhook.js); it has no parcel, no
 * tracking and no ship notice to re-anchor it later. Charging it the assumed
 * dispatch window would delay a how-to-use email for something the recipient
 * already had in their inbox before the tab closed.
 */
export const INSTANT_DELIVERY_CATEGORIES = ["gift-cards"];

/**
 * How long to assume this order sat before it was dispatched.
 *
 * A MIXED order is treated as shipped goods even when a gift card is in it:
 * something in the box still has to be packed, and the later email is the safe
 * error in the same way the slow review delay is.
 */
function assumedDispatchMs(categories) {
  const list = String(categories || "")
    .split(",")
    .filter(Boolean);
  if (list.length && list.every((c) => INSTANT_DELIVERY_CATEGORIES.includes(c))) return 0;
  return ASSUMED_DISPATCH_MS;
}

/** Recovery is a "within the hour" touch -- see research-I S1. */
export const RECOVERY_DELAY_MS = 45 * 60 * 1000;

/**
 * Review-request delay, by category. Apparel and gift cards can be judged on
 * arrival; a salve or a soak needs a few uses first.
 */
export const REVIEW_DELAY_DAYS = { fast: 7, slow: 12 };
export const FAST_REVIEW_CATEGORIES = ["apparel", "gift-cards"];

/** The birthday club sends at or after 9am in the shop's own timezone. */
export const SHOP_TIMEZONE = "America/New_York";
export const BIRTHDAY_SEND_HOUR = 9;

/**
 * How long the "check your Alt-Points" token at the foot of a post-purchase
 * email stays valid. Long, because people read these emails weeks late; safe,
 * because the token only reads a balance -- spending is never client-initiated.
 */
export const POINTS_TOKEN_TTL_SECONDS = 120 * 24 * 60 * 60;

/** Promotion-code lifetimes, in days. */
export const WELCOME_CODE_DAYS = 45;
export const REWARD_CODE_DAYS = 30;

/** Defaults for the LOYALTY_* vars. 100 points = $5 at 1 point per dollar. */
export const DEFAULT_LOYALTY_THRESHOLD = 100;
export const DEFAULT_LOYALTY_REWARD_CENTS = 500;

function intVar(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

/**
 * Everything the retention layer reads out of `env`, in one place so the
 * README and the tests have a single list to agree with.
 */
export function retentionConfig(env) {
  const e = env || {};
  return {
    siteOrigin: e.SITE_ORIGIN || "https://yallternativeliving.com",
    from: e.RETENTION_FROM_EMAIL || fromAddress(e),
    signingSecret: e.MAGIC_LINK_SECRET,
    welcomeCouponId: e.STRIPE_WELCOME_COUPON_ID || "",
    birthdayCouponId: e.STRIPE_BIRTHDAY_COUPON_ID || "",
    // One $5-off coupon can back both payouts, so LOYALTY falls back to the
    // birthday coupon rather than silently doing nothing when only one is set.
    loyaltyCouponId: e.STRIPE_LOYALTY_COUPON_ID || e.STRIPE_BIRTHDAY_COUPON_ID || "",
    loyaltyThreshold: intVar(e.LOYALTY_REDEEM_THRESHOLD, DEFAULT_LOYALTY_THRESHOLD),
    loyaltyRewardCents: intVar(e.LOYALTY_REWARD_CENTS, DEFAULT_LOYALTY_REWARD_CENTS)
  };
}

/** `MM-DD` and the hour, both in the shop's timezone rather than UTC. */
export function shopDateParts(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SHOP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false
  }).formatToParts(new Date(now));
  const read = (type) => (parts.find((p) => p.type === type) || {}).value || "";
  // Intl renders midnight as "24" in some ICU versions; normalise it to 0.
  const hour = Number(read("hour")) % 24;
  return { year: Number(read("year")), monthDay: `${read("month")}-${read("day")}`, hour };
}

/* --------------------------------------------------------------- templates */

const SHELL_OPEN =
  '<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; ' +
  'background: #17130f; color: #fff; padding: 32px; border-radius: 12px; border: 2px solid #d69b5c;">';

function shell(inner) {
  return `${SHELL_OPEN}${inner}</div>`;
}

function button(href, label) {
  return (
    `<div style="text-align:center;margin:28px 0;"><a href="${escapeHtml(href)}" ` +
    'style="display:inline-block;background:#d69b5c;color:#17130f;text-decoration:none;' +
    "padding:14px 28px;font-weight:bold;border-radius:4px;text-transform:uppercase;" +
    `letter-spacing:1px;">${escapeHtml(label)}</a></div>`
  );
}

function codeBlock(code, note) {
  return (
    '<div style="text-align:center;background:#fff;color:#000;padding:20px;border-radius:8px;margin:24px 0;">' +
    '<p style="margin:0;text-transform:uppercase;letter-spacing:2px;font-size:13px;color:#666;">Your code</p>' +
    `<h2 style="margin:8px 0 0 0;font-size:30px;letter-spacing:4px;">${escapeHtml(code)}</h2>` +
    `<p style="margin:8px 0 0 0;font-size:13px;color:#666;">${escapeHtml(note)}</p></div>`
  );
}

/**
 * The "check your Alt-Points" link. The token in it is what POST
 * /api/loyalty-balance requires alongside the address, so a balance can never
 * be read by typing somebody else's email into a form.
 *
 * Omitted entirely when no token could be minted -- a dead link is worse than
 * no link.
 */
function pointsLine(pointsUrl) {
  if (!pointsUrl) return "";
  return (
    '<p style="font-size:13px;color:#c9b8a8;">Curious what your Alt-Points are up to? ' +
    `<a style="color:#d69b5c;" href="${escapeHtml(pointsUrl)}">Check your balance</a>.</p>`
  );
}

function pointsLineText(pointsUrl) {
  return pointsUrl ? `Check your Alt-Points balance: ${pointsUrl}\n` : "";
}

/**
 * Day 2-3: how to actually use the thing.
 *
 * The copy comes from `usageGuide` in products.json -- the same object the
 * product page renders -- so the email cannot drift from the label.
 */
export function usageGuideEmail(products, siteOrigin, pointsUrl) {
  const named = products.filter((p) => p && p.usageGuide);
  const lead = named[0] || products[0] || { name: "order", id: "" };
  const sections = named
    .map((p) => {
      const g = p.usageGuide || {};
      const rows = [
        ["How to use it", g.howToApply],
        ["Keeping it happy", g.storage],
        ["Before you go all in", g.patchTest]
      ].filter((row) => typeof row[1] === "string" && row[1].trim());
      if (!rows.length) return "";
      return (
        `<h3 style="color:#d69b5c;margin:24px 0 8px;">${escapeHtml(p.name)}</h3>` +
        rows
          .map(
            (row) =>
              `<p style="margin:0 0 10px;"><strong>${escapeHtml(row[0])}:</strong> ${escapeHtml(row[1])}</p>`
          )
          .join("")
      );
    })
    .join("");

  const html = shell(
    `<h1 style="color:#d69b5c;">Your ${escapeHtml(lead.name)} made it.</h1>` +
      "<p>Here's how to actually use the thing, before you just smell it and put it on a shelf. " +
      "(We see you. We do it too.)</p>" +
      sections +
      button(`${siteOrigin}/faq.html`, "More answers") +
      pointsLine(pointsUrl) +
      '<p style="font-size:13px;color:#c9b8a8;">Questions about anything in this box? Just hit reply -- ' +
      "a real person reads it.</p>"
  );

  const text =
    `Your ${lead.name} made it.\n\n` +
    "Here's how to actually use the thing:\n\n" +
    named
      .map((p) => {
        const g = p.usageGuide || {};
        return (
          `${p.name}\n` +
          (g.howToApply ? `  How to use it: ${g.howToApply}\n` : "") +
          (g.storage ? `  Keeping it happy: ${g.storage}\n` : "") +
          (g.patchTest ? `  Before you go all in: ${g.patchTest}\n` : "")
        );
      })
      .join("\n") +
    `\nMore answers: ${siteOrigin}/faq.html\n` +
    pointsLineText(pointsUrl) +
    "Questions? Just hit reply -- a real person reads it.";

  return { subject: `How to get the most out of your ${lead.name}`, html, text };
}

/**
 * Day 7 / day 12: the review ask.
 *
 * No incentive, conditional or otherwise -- see the file header. The link goes
 * straight to the product's own review block so nobody has to hunt for it.
 */
export function reviewRequestEmail(product, siteOrigin) {
  const name = (product && product.name) || "your order";
  const url =
    product && product.id
      ? `${siteOrigin}/products/${product.id}.html#pdpReviews`
      : `${siteOrigin}/reviews.html`;
  const html = shell(
    `<h1 style="color:#d69b5c;">How's the ${escapeHtml(name)} treating you?</h1>` +
      "<p>You've had it a little while now, so: tell us the truth. Good, bad, or " +
      "&ldquo;it's fine, I guess.&rdquo; We can take it, and the next person reading " +
      "the page genuinely needs to know.</p>" +
      button(url, "Leave a review") +
      '<p style="font-size:13px;color:#c9b8a8;">No code, no bribe, no strings -- we just want the ' +
      "honest version. If something went wrong instead, hit reply and we'll make it right.</p>"
  );
  const text =
    `How's the ${name} treating you?\n\n` +
    'Tell us the truth -- good, bad, or "it\'s fine, I guess." We can take it, and the next ' +
    "person reading the page needs to know.\n\n" +
    `${url}\n\n` +
    "No code, no bribe, no strings. If something went wrong instead, hit reply and we'll make it right.";
  return { subject: `Quick one -- how's the ${name} treating you?`, html, text };
}

/** Abandoned checkout: the Stripe-issued recovery URL, sent once. */
export function recoveryEmail(recoveryUrl) {
  const html = shell(
    '<h1 style="color:#d69b5c;">You left something in your cart</h1>' +
      "<p>No judgment -- checkout is a whole ordeal sometimes. Everything's still where you " +
      "left it, and this link picks it right back up.</p>" +
      button(recoveryUrl, "Finish checking out") +
      '<p style="font-size:13px;color:#c9b8a8;">The link is good for 30 days. If you changed your ' +
      "mind, that's allowed too -- nothing has been charged.</p>"
  );
  const text =
    "You left something in your cart.\n\n" +
    "No judgment -- checkout is a whole ordeal sometimes. Everything's still where you left it:\n\n" +
    `${recoveryUrl}\n\n` +
    "Good for 30 days. Nothing has been charged.";
  return { subject: "You left something in your cart", html, text };
}

/** Birthday club: a single-use $5 code, on the day. */
export function birthdayEmail(code, amountCents, siteOrigin) {
  const amount = (amountCents / 100).toFixed(2);
  const html = shell(
    '<h1 style="color:#d69b5c;">Happy birthday, y\'all</h1>' +
      `<p>Here's $${escapeHtml(amount)} off, because you told us when to celebrate you and we ` +
      "wrote it down.</p>" +
      codeBlock(code, "One use, yours only, good for 30 days") +
      button(`${siteOrigin}/shop.html`, "Go treat yourself") +
      '<p style="font-size:13px;color:#c9b8a8;">Enter it at checkout in the box marked ' +
      "&ldquo;Add promotion code&rdquo;.</p>"
  );
  const text =
    `Happy birthday, y'all.\n\nHere's $${amount} off: ${code}\n` +
    `One use, yours only, good for 30 days. Enter it at checkout.\n\n${siteOrigin}/shop.html`;
  return { subject: `Happy birthday -- here's $${amount} on us`, html, text };
}

/** Loyalty payout: the points turned into a code without anyone asking. */
export function loyaltyRewardEmail(code, amountCents, pointsSpent, siteOrigin, pointsUrl) {
  const amount = (amountCents / 100).toFixed(2);
  const html = shell(
    '<h1 style="color:#d69b5c;">You just earned $' +
      escapeHtml(amount) +
      " off</h1>" +
      `<p>That's ${escapeHtml(String(pointsSpent))} Alt-Points cashed in. No account to log into, ` +
      "no balance to babysit -- we did it for you.</p>" +
      codeBlock(code, "One use, yours only, good for 30 days") +
      button(`${siteOrigin}/shop.html`, "Spend it") +
      pointsLine(pointsUrl) +
      '<p style="font-size:13px;color:#c9b8a8;">Points keep adding up from here; the next ' +
      "code turns up on its own.</p>"
  );
  const text =
    `You just earned $${amount} off -- ${pointsSpent} Alt-Points cashed in.\n\n` +
    `Code: ${code}\nOne use, yours only, good for 30 days.\n\n${siteOrigin}/shop.html\n` +
    pointsLineText(pointsUrl);
  return { subject: `Your Alt-Points just turned into $${amount} off`, html, text };
}

/* -------------------------------------------------------------- the sender */

/**
 * The ONLY way a marketing email leaves this Worker.
 *
 * @param {object} env
 * @param {object} db D1 binding
 * @param {{to: string, subject: string, html: string, text: string,
 *          idempotencyKey: string}} message
 * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>}
 */
export async function sendMarketingEmail(env, db, message) {
  const config = retentionConfig(env);
  let to;
  try {
    to = normalizeEmail(message.to);
  } catch {
    return { ok: false, skipped: true, reason: "invalid_address" };
  }
  if (await isSuppressed(db, to)) {
    return { ok: false, skipped: true, reason: "suppressed" };
  }
  if (!config.signingSecret) {
    // No secret means no unsubscribe link can be signed, and an email without a
    // working opt-out is not one this shop is willing to send. Refusing is the
    // point: a "best effort" send here would be the first CAN-SPAM problem.
    return { ok: false, skipped: true, reason: "unconfigured_signing_secret" };
  }

  const token = await unsubscribeToken(config.signingSecret, to);
  const unsubUrl = `${config.siteOrigin}/api/unsubscribe?t=${token}`;
  await rememberContact(db, await unsubscribeId(config.signingSecret, to), to);

  const footerHtml =
    '<p style="font-size:12px;color:#8d7f72;margin-top:28px;">You are getting this because you ' +
    "ordered from Y'allternative Living or asked us to write to you. " +
    `Use the unsubscribe link in your mail app, or email <a style="color:#8d7f72;" href="mailto:${REPLY_TO}?subject=unsubscribe">${REPLY_TO}</a>, ` +
    "and we will stop. Y'allternative Living, Landrum, SC.</p>";
  const footerText =
    "\n\n---\nYou are getting this because you ordered from Y'allternative Living or asked us to " +
    `write to you. Use the unsubscribe link in your mail app, or email ${REPLY_TO}, and we will ` +
    "stop.\nY'allternative Living, Landrum, SC.";

  return sendEmail(
    env,
    {
      from: config.from,
      to,
      reply_to: REPLY_TO,
      subject: message.subject,
      html: `${message.html}${footerHtml}`,
      text: `${message.text}${footerText}`,
      headers: {
        // RFC 8058 one-click: the mail client POSTs the URL below, which is
        // exactly what POST /api/unsubscribe answers.
        "List-Unsubscribe": `<${unsubUrl}>, <mailto:${REPLY_TO}?subject=unsubscribe>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
      }
    },
    message.idempotencyKey
  );
}

/* ------------------------------------------------------------- the schedule */

function categoryDelayDays(categories) {
  const list = String(categories || "")
    .split(",")
    .filter(Boolean);
  // Mixed orders take the SLOW delay: a shirt can be judged on arrival, a salve
  // cannot, and asking too early about the salve is the mistake that matters.
  if (list.length && list.every((c) => FAST_REVIEW_CATEGORIES.includes(c))) {
    return REVIEW_DELAY_DAYS.fast;
  }
  return REVIEW_DELAY_DAYS.slow;
}

/**
 * When each post-purchase row is due, given the moment the parcel left.
 *
 * The one place the two delays are turned into timestamps, so the enqueue and
 * the later re-anchor cannot drift apart on the arithmetic.
 */
function sequenceDueAt(dispatchAt, categories, guideDelayMs) {
  const guide = Number.isFinite(guideDelayMs) ? guideDelayMs : USAGE_GUIDE_AFTER_DISPATCH_MS;
  return {
    "usage-guide": dispatchAt + guide,
    "review-request": dispatchAt + categoryDelayDays(categories) * DAY
  };
}

/**
 * Queues the post-purchase sequence for one recorded order. Both rows are
 * INSERT OR IGNORE, so a redelivered webhook queues nothing.
 *
 * Scheduled against ASSUMED dispatch, because at this point the order has been
 * paid for and nothing more: it has not been packed, and the shop has not typed
 * a fulfilment status onto it yet. `reanchorOrderSequence` corrects both rows
 * when that happens.
 *
 * @returns {Promise<{usageGuide: boolean, reviewRequest: boolean}>}
 */
export async function scheduleOrderSequence(db, signal, now = Date.now(), site = null) {
  const orderId = signal.order_id || signal.orderId;
  const placedAt = Number(signal.placed_at || signal.placedAt || now);
  const productIds = String(signal.product_ids || signal.productIds || "");
  const categories = String(signal.categories || "");
  const email = signal.email;
  const due = sequenceDueAt(
    placedAt + assumedDispatchMs(categories),
    categories,
    usageGuideDelayMs(site)
  );

  const usage = await enqueueEmail(
    db,
    {
      id: `usage-guide:${orderId}`,
      kind: "usage-guide",
      email,
      payload: { orderId, productIds },
      sendAfter: due["usage-guide"]
    },
    now
  );
  const review = await enqueueEmail(
    db,
    {
      id: `review-request:${orderId}`,
      kind: "review-request",
      email,
      payload: { orderId, productIds },
      sendAfter: due["review-request"]
    },
    now
  );
  return { usageGuide: usage.queued, reviewRequest: review.queued };
}

/**
 * Moves this order's post-purchase rows onto the REAL dispatch moment.
 *
 * Called from the ship notice (routes/ship-notice.js), because that is the one
 * point in the system where somebody has said out loud that the parcel is gone.
 * The passed `dispatchAt` is the moment the notice went out rather than the
 * `shipped_at` metadata string beside it: that field is free text the shop types
 * by hand, and a mistyped date that parses is far more dangerous here than no
 * date at all -- it would pull a review request forward into the week of the
 * order.
 *
 * Both directions are allowed. An order dispatched the same afternoon is asked
 * about EARLIER than the pessimistic assumption booked, and one that sat for a
 * week is asked about later; a `dispatchAt` before the order was even placed is
 * ignored in favour of the original schedule, because it cannot be real.
 *
 * Only pending rows move. A guide already sent stays sent, and a row the drain
 * has given up on is not quietly revived.
 *
 * @returns {Promise<{usageGuide: boolean, reviewRequest: boolean}>} which rows moved
 */
export async function reanchorOrderSequence(
  db,
  orderId,
  dispatchAt,
  now = Date.now(),
  site = null
) {
  const signal = await getOrderSignal(db, orderId);
  if (!signal) return { usageGuide: false, reviewRequest: false };

  const placedAt = Number(signal.placed_at) || now;
  const dispatched = Number(dispatchAt);
  const anchor = Number.isFinite(dispatched) ? Math.max(dispatched, placedAt) : placedAt;
  const due = sequenceDueAt(anchor, signal.categories, usageGuideDelayMs(site));

  const usage = await rescheduleQueuedEmail(db, `usage-guide:${orderId}`, due["usage-guide"]);
  const review = await rescheduleQueuedEmail(
    db,
    `review-request:${orderId}`,
    due["review-request"]
  );
  return { usageGuide: usage.moved, reviewRequest: review.moved };
}

/**
 * Mints the balance link for one recipient. Returns "" when no signing secret
 * is configured, which drops the line rather than emitting a link that cannot
 * be verified.
 */
async function pointsUrlFor(config, email) {
  if (!config.signingSecret) return "";
  try {
    const minted = await signToken(config.signingSecret, {
      email,
      purpose: "points",
      ttlSeconds: POINTS_TOKEN_TTL_SECONDS,
      maxTtlSeconds: POINTS_TOKEN_TTL_SECONDS
    });
    return `${config.siteOrigin}/thank-you.html#points=${minted.token}`;
  } catch (err) {
    console.warn("retention: could not mint a points token:", err && err.message);
    return "";
  }
}

/**
 * Builds the message for one queued row. Returns null when the row can no
 * longer produce a sensible email (a recovery row with no URL, say), which the
 * drain records as `skipped` rather than retrying forever.
 */
async function renderQueuedEmail(env, ctx, row, productIndex, site) {
  const config = retentionConfig(env);
  let payload = {};
  try {
    payload = JSON.parse(row.payload || "{}") || {};
  } catch {
    payload = {};
  }
  const ids = String(payload.productIds || "")
    .split(",")
    .filter(Boolean);
  const products = ids.map((id) => productIndex.get(id)).filter(Boolean);

  if (row.kind === "usage-guide") {
    // Savanna's switch, read here rather than at enqueue time so turning it off
    // stops the guides already queued behind it.
    if (!usageGuideEnabled(site)) return null;
    if (!products.some((p) => p && p.usageGuide)) return null;
    return usageGuideEmail(products, config.siteOrigin, await pointsUrlFor(config, row.email));
  }
  if (row.kind === "review-request") {
    // One ask, about one thing. Asking about five products in one email gets
    // an opinion about none of them.
    const subject = products.find((p) => p && p.id) || null;
    if (!subject) return null;
    return reviewRequestEmail(subject, config.siteOrigin);
  }
  if (row.kind === "recovery") {
    if (!payload.recoveryUrl || !/^https:\/\//.test(String(payload.recoveryUrl))) return null;
    return recoveryEmail(String(payload.recoveryUrl));
  }
  if (row.kind === "birthday") {
    if (!payload.code) return null;
    return birthdayEmail(
      String(payload.code),
      Number(payload.amountCents) || 500,
      config.siteOrigin
    );
  }
  if (row.kind === "loyalty-reward") {
    if (!payload.code) return null;
    return loyaltyRewardEmail(
      String(payload.code),
      Number(payload.amountCents) || 500,
      Number(payload.points) || 0,
      config.siteOrigin,
      await pointsUrlFor(config, row.email)
    );
  }
  console.error(`retention: queued row ${row.id} has unknown kind "${row.kind}"`);
  return null;
}

/**
 * Sends everything that is due. Called from the `scheduled` handler in
 * workers/checkout.js.
 *
 * @returns {Promise<{processed: number, sent: number, skipped: number, failed: number}>}
 */
export async function drainEmailQueue(env, ctx, now = Date.now(), limit = 25) {
  const db = env.STATE_DB;
  const summary = { processed: 0, sent: 0, skipped: 0, failed: 0 };
  if (!db) return summary;

  const rows = await dueEmails(db, now, limit);
  if (!rows.length) return summary;

  // One catalogue fetch for the whole batch, not one per row -- and one
  // settings fetch, for the same reason.
  const productIndex = await loadProductIndex(env, ctx);
  const site = await loadSiteSettings(env, ctx);

  for (const row of rows) {
    summary.processed++;
    const message = await renderQueuedEmail(env, ctx, row, productIndex, site);
    if (!message) {
      await markEmailSkipped(db, row.id, now);
      summary.skipped++;
      continue;
    }
    let result;
    try {
      result = await sendMarketingEmail(env, db, {
        ...message,
        to: row.email,
        idempotencyKey: row.id
      });
    } catch (err) {
      console.error(`retention: send failed for ${row.id}:`, err && err.message);
      result = { ok: false };
    }
    if (result.ok) {
      await markEmailSent(db, row.id, now);
      summary.sent++;
    } else if (result.skipped) {
      // Suppressed, or unsendable by construction. Terminal, never retried.
      await markEmailSkipped(db, row.id, now);
      summary.skipped++;
    } else {
      const state = await markEmailFailed(db, row.id, now);
      summary.failed++;
      if (state.exhausted) {
        console.error(`retention: giving up on ${row.id} after ${state.attempts} attempts`);
      }
    }
  }
  return summary;
}

/* --------------------------------------------------------------- birthdays */

/**
 * Mints and queues today's birthday codes.
 *
 * Idempotent per member per YEAR twice over: the queue row id carries the year,
 * and the Stripe idempotency key does too, so running this every hour (which
 * the cron does) sends exactly one code per person per birthday.
 *
 * @returns {Promise<{monthDay: string, matched: number, queued: number, minted: number}>}
 */
export async function runBirthdayClub(env, ctx, now = Date.now()) {
  const db = env.STATE_DB;
  const { monthDay, year, hour } = shopDateParts(now);
  const result = { monthDay, matched: 0, queued: 0, minted: 0 };
  if (!db) return result;
  // Not before breakfast, local time. The idempotency keys -- not this gate --
  // are what stop a second send, so a missed 9am tick is picked up at 10.
  if (hour < BIRTHDAY_SEND_HOUR) return result;

  const config = retentionConfig(env);
  const members = await birthdaysOn(db, monthDay);
  result.matched = members.length;
  if (!members.length) return result;
  if (!config.birthdayCouponId) {
    console.error(
      "retention: STRIPE_BIRTHDAY_COUPON_ID is not set -- birthday codes cannot be minted"
    );
    return result;
  }

  for (const member of members) {
    const hash = await hashEmail(member.email);
    const queueId = `birthday:${hash}:${year}`;
    if (await getQueuedEmail(db, queueId)) continue; // already handled this year
    if (await isSuppressed(db, member.email)) continue;

    const promo = await createPromotionCode(
      env,
      {
        couponId: config.birthdayCouponId,
        maxRedemptions: 1,
        expiresAt: Math.floor(now / 1000) + REWARD_CODE_DAYS * 86400,
        metadata: { purpose: "birthday", email_hash: hash, year: String(year) }
      },
      `birthday-${hash}-${year}`
    );
    if (!promo) {
      console.error(`retention: Stripe refused the birthday code for ${hash}`);
      continue;
    }
    result.minted++;
    const queued = await enqueueEmail(
      db,
      {
        id: queueId,
        kind: "birthday",
        email: member.email,
        payload: { code: promo.code, amountCents: DEFAULT_LOYALTY_REWARD_CENTS },
        sendAfter: now
      },
      now
    );
    if (queued.queued) result.queued++;
  }
  return result;
}

/* ----------------------------------------------------------------- loyalty */

/**
 * Turns a paid order into points, then pays them out if the balance has
 * reached the threshold.
 *
 * @param {object} env
 * @param {object} ctx
 * @param {{orderId: string, email: string, amountCents: number}} order
 * @returns {Promise<{points: number, credited: boolean, reward: object|null}>}
 */
export async function creditLoyaltyForOrder(env, ctx, order, now = Date.now()) {
  const db = env.STATE_DB;
  if (!db) return { points: 0, credited: false, reward: null };
  const email = normalizeEmail(order.email);
  const rate = await loadPointsPerDollar(env, ctx);
  // Whole dollars only, matching the "Earn N Alt-Points" badge the product
  // card renders from the same rate (assets/js/cart.js).
  const points = Math.floor(Math.floor(Number(order.amountCents) / 100) * rate);
  if (!(points > 0)) return { points: 0, credited: false, reward: null };

  const result = await credit(db, { email, points, orderId: order.orderId, reason: "order" }, now);
  const reward = await payOutLoyalty(env, db, { email, orderId: order.orderId }, now);
  return { points, credited: result.credited, reward };
}

/**
 * Redemption without accounts: once the balance reaches the threshold, the
 * Worker spends it on the customer's behalf and emails the code.
 *
 * ORDER OF OPERATIONS, AND WHY.
 * The debit happens FIRST, because `debit()` is the only atomic step available
 * -- its balance check lives inside the INSERT, so two concurrent webhooks
 * cannot both pay out. Minting after it is safe to retry: a repeated debit
 * returns `duplicate` rather than spending again, and the Stripe idempotency
 * key returns the SAME promotion code, so a webhook that dies between the
 * debit and the email is fully recovered by Stripe's redelivery.
 *
 * @returns {Promise<{paid: boolean, reason?: string, code?: string}|null>}
 */
export async function payOutLoyalty(env, db, args, now = Date.now()) {
  const config = retentionConfig(env);
  const email = normalizeEmail(args.email);
  const orderId = String(args.orderId || "").trim();
  if (!orderId) return null;

  const current = await balance(db, email);
  if (current < config.loyaltyThreshold) return { paid: false, reason: "below_threshold" };
  if (!config.loyaltyCouponId) {
    console.error("retention: STRIPE_LOYALTY_COUPON_ID is not set -- points cannot be paid out");
    return { paid: false, reason: "unconfigured" };
  }

  const refId = `loyalty-${orderId}`;
  const spent = await debit(
    db,
    { email, points: config.loyaltyThreshold, reason: "redemption", refId },
    now
  );
  if (!spent.ok && spent.reason !== "duplicate") {
    return { paid: false, reason: spent.reason };
  }

  const hash = await hashEmail(email);
  const promo = await createPromotionCode(
    env,
    {
      couponId: config.loyaltyCouponId,
      maxRedemptions: 1,
      expiresAt: Math.floor(now / 1000) + REWARD_CODE_DAYS * 86400,
      metadata: { purpose: "loyalty", email_hash: hash, order_id: orderId }
    },
    `loyalty-${hash}-${orderId}`
  );
  if (!promo) {
    // The points are already spent. Throwing puts the whole webhook into
    // Stripe's retry loop, where the duplicate debit is a no-op and this mint
    // is tried again -- which is the only outcome that does not lose the code.
    throw new Error(`Stripe refused the loyalty promotion code for order ${orderId}`);
  }

  await enqueueEmail(
    db,
    {
      id: `loyalty-reward:${hash}:${orderId}`,
      kind: "loyalty-reward",
      email,
      payload: {
        code: promo.code,
        amountCents: config.loyaltyRewardCents,
        points: config.loyaltyThreshold
      },
      sendAfter: now
    },
    now
  );
  return { paid: true, code: promo.code, points: config.loyaltyThreshold };
}

/* ------------------------------------------------------ abandoned checkout */

/**
 * Queues the recovery email for an expired session, once.
 *
 * Three things must all be true: Stripe generated a recovery URL (it only does
 * when `after_expiration[recovery][enabled]` was set on the session), the
 * shopper got as far as entering an email, and they said yes to promotional
 * email in Checkout's own consent box. Consent is not implied by abandoning a
 * cart -- `consent_collection[promotions]=auto` is what asks, and
 * `session.consent.promotions === "opt_in"` is what answers.
 *
 * @returns {Promise<{queued: boolean, reason?: string}>}
 */
export async function scheduleRecoveryEmail(db, session, now = Date.now()) {
  const recovery =
    (session.after_expiration && session.after_expiration.recovery) || session.recovery || {};
  const url = typeof recovery.url === "string" ? recovery.url : "";
  if (!url || !/^https:\/\//.test(url)) return { queued: false, reason: "no_recovery_url" };

  const email =
    (session.customer_details && session.customer_details.email) || session.customer_email || "";
  if (!email) return { queued: false, reason: "no_email" };

  const promotions = (session.consent && session.consent.promotions) || "";
  if (promotions !== "opt_in") return { queued: false, reason: "no_consent" };

  const queued = await enqueueEmail(
    db,
    {
      id: `recovery:${session.id}`,
      kind: "recovery",
      email,
      payload: { recoveryUrl: url },
      sendAfter: now + RECOVERY_DELAY_MS
    },
    now
  );
  return { queued: queued.queued, reason: queued.queued ? undefined : "already_queued" };
}

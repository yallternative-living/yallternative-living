/**
 * @fileoverview POST /api/stripe-webhook -- the only place an order becomes
 * real.
 *
 * Replaces netlify/functions/fulfill-gift-card.js. Three findings shaped it:
 *
 * H-9 (a sub-step failure blocked everything). The old handler ran the
 * redemption rollover and the gift-card minting in ONE try: a rollover error
 * 500'd the whole webhook, Stripe retried forever, and codes the buyer had paid
 * for were never emailed. Each step now runs in its own try/catch and records
 * its failure; the handler still returns non-2xx at the end if anything failed,
 * so Stripe retries -- but the steps that DID work are not re-run for nothing,
 * because every one of them is idempotent.
 *
 * H-5 (refunds). The old code read `gift_card_*` metadata off the CHARGE, where
 * it has never existed, so no refund ever restored a balance; and it restored
 * the full applied amount on every delivery, so wiring it up would have minted
 * money. The session is found from the charge's payment_intent, restoration is
 * capped at what was actually refunded, and only the difference not already
 * restored for that charge is credited.
 *
 * Exactly-once (H-9 again). Stripe delivers at least once and retries for about
 * three days. `claimEvent` writes the event id to D1 with INSERT OR IGNORE
 * BEFORE any side effect: the first delivery gets the claim, every redelivery
 * gets an immediate 200 and does nothing. A handler that throws releases its
 * own claim so the retry can pick the work up again.
 *
 * PROMOTION CODES ARE NOT READ AT ALL. A gift card is a ledger row now, not a
 * Stripe coupon, so there is no rollover, no `session.discounts` inspection and
 * no `YALL-` promotion code to find. `allow_promotion_codes` on the hosted page
 * is for marketing codes only, and this file deliberately ignores them: a
 * marketing discount is Stripe's business, not the ledger's.
 */

import { escapeHtml, json } from "./http.js";
import {
  buyerEmailOf,
  deleteCoupon,
  findSessionByPaymentIntent,
  STRIPE_API_BASE,
  STRIPE_API_VERSION
} from "./stripe.js";
import {
  balanceUpdateEmailBody,
  buyerEmailBody,
  deriveGiftCardCode,
  fromAddress,
  giftCardUnitsFrom,
  recipientEmailBody,
  refundEmailBody,
  sendEmail
} from "./gift-cards.js";
import { giftCardLedger, LedgerError } from "../state/gift-card-ledger.js";
import {
  creditLoyaltyForOrder,
  scheduleOrderSequence,
  scheduleRecoveryEmail
} from "./retention-emails.js";
import { recordOrder } from "../state/retention.js";
import { giftNoteLink, giftNotesOf } from "./gift-note.js";
import { loadOrderCatalog, productsNeedingChoice, sizeConfirmationEmail } from "./order-digest.js";
import { emailShipNotice } from "./ship-notice.js";
import { loadSiteSettings } from "../state/site-data.js";
import { claimEvent, markEventDone, releaseEvent } from "../state/webhook-events.js";
import { ensureSchema } from "../state/migrations.js";
import { buildOrderPaidPayload, sendToUmami } from "./analytics.js";
import { claimAnalyticsSend, ORDER_PAID, releaseAnalyticsSend } from "../state/analytics-sends.js";

/** Stripe tolerates clock drift but nothing older than this, to block replay. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** How long the owner's order copy waits on Stripe for the line items. */
export const OWNER_EMAIL_STRIPE_TIMEOUT_MS = 5000;
/** Pages of 100 line items read for it; the cart allows 50, so one suffices. */
const OWNER_EMAIL_LINE_ITEM_PAGES = 2;

const REPLY_TO = "contact@yallternativeliving.com";

// Logged once per isolate when the optional D1 claim table is not bound.
let warnedNoStateDb = false;

function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/**
 * Verify the `Stripe-Signature` header and return the parsed event.
 *
 * Ported from the Netlify function, with Node's `crypto.timingSafeEqual`
 * replaced by WebCrypto's `subtle.verify` -- which compares the MAC internally
 * and in constant time, so there is no hand-rolled comparison to get wrong.
 *
 * Throws (never returns false) so the caller cannot accidentally treat a
 * refusal as a pass. The caller must NOT echo the reason: telling an
 * unauthenticated poster whether the header was missing, malformed, stale or
 * simply wrong is a free oracle for probing the verification.
 */
export async function verifyStripeSignature(rawBody, signatureHeader, secret, now = Date.now()) {
  if (!signatureHeader) throw new Error("Missing Stripe-Signature header");
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");

  let timestamp = null;
  const v1Signatures = [];
  for (const pair of String(signatureHeader).split(",")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key === "t") timestamp = value;
    if (key === "v1") v1Signatures.push(value);
  }
  if (!timestamp || !v1Signatures.length) throw new Error("Malformed Stripe-Signature header");

  const age = Math.abs(Math.floor(now / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > WEBHOOK_TOLERANCE_SECONDS) {
    throw new Error("Webhook timestamp outside tolerance -- possible replay");
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signed = encoder.encode(`${timestamp}.${rawBody}`);

  let ok = false;
  for (const candidate of v1Signatures) {
    const bytes = hexToBytes(candidate);
    if (!bytes) continue;
    // No early break: every candidate costs the same work either way.
    if (await crypto.subtle.verify("HMAC", key, bytes, signed)) ok = true;
  }
  if (!ok) throw new Error("Signature mismatch");

  return JSON.parse(rawBody);
}

/* ------------------------------------------------------------- handlers */

/**
 * A gift order gets the owner an email with the signed link to the printable
 * gift note (routes/gift-note.js). Nothing is sent when the order carries no
 * gift text, and nothing can be signed without MAGIC_LINK_SECRET -- in that
 * case the note is still readable on the order in Stripe.
 */
export async function emailGiftNoteLink(session, env) {
  const notes = giftNotesOf(session);
  if (!notes.length) return null;
  if (!env || !env.MAGIC_LINK_SECRET) {
    console.error("gift-note: MAGIC_LINK_SECRET is not set; no print link emailed for", session.id);
    return { skipped: "no-secret" };
  }
  const to = env.ORDER_NOTIFY_EMAIL || env.RESTOCK_NOTIFY_EMAIL || REPLY_TO;
  const siteOrigin = env.SITE_ORIGIN || "https://yallternativeliving.com";
  const link = await giftNoteLink(env.MAGIC_LINK_SECRET, session.id, siteOrigin);
  const count = notes.length;
  const subject = `Gift note to print -- order ${session.id}`;
  const text =
    `A gift order just came through with ${count} ${count === 1 ? "note" : "notes"} to print.\n\n` +
    `Open this link, press Print, and slip the card into the parcel:\n${link}\n\n` +
    `The link works for six months and can be printed more than once. The note is also on the order in Stripe.`;
  const html =
    `<p>A gift order just came through with ${count} ${count === 1 ? "note" : "notes"} to print.</p>` +
    `<p><a href="${link}">Open the printable gift note</a>, press Print, and slip the card into the parcel.</p>` +
    `<p style="color:#6b5f52;font-size:13px;">The link works for six months and can be printed more than once. The note is also on the order in Stripe.</p>`;
  await sendEmail(
    env,
    { from: fromAddress(env), to, reply_to: REPLY_TO, subject, text, html },
    `gift-note-email-${session.id}`
  );
  return { emailed: to, notes: count };
}

/**
 * A bundle or a build-your-own box can contain something that comes in more
 * than one size or scent, and neither line lets the shopper pick one: the
 * option is only ever recorded for a plain product line (see checkout.js's
 * findVariantOption). Left alone that becomes a guess at the bench, or a DM
 * days later. This asks, once, while the order is fresh.
 *
 * Transactional -- a question about an order already paid for -- so there is
 * deliberately no unsubscribe link and no suppression check: it is not
 * marketing, and someone who unsubscribed from the newsletter still needs to
 * be asked what size they want.
 *
 * Sends NOTHING for a plain order, for an order whose bundle contents have no
 * variants at all, or when the catalogue is unreachable (an empty index yields
 * an empty list). `size-confirm-<session>` is the Resend idempotency key, so a
 * redelivered webhook asks once.
 */
export async function emailSizeConfirmation(session, env, ctx) {
  const catalog = await loadOrderCatalog(env, ctx);
  const pending = productsNeedingChoice(session, catalog);
  if (!pending.length) return null;
  const to = buyerEmailOf(session);
  if (!to) return { skipped: "no-buyer-email" };

  const site = await loadSiteSettings(env, ctx);
  const automations =
    (site.automations && typeof site.automations === "object" && site.automations) || {};
  const body = sizeConfirmationEmail(pending, automations.sizeConfirmationIntro);
  const delivery = await sendEmail(
    env,
    { from: fromAddress(env), to, reply_to: REPLY_TO, ...body },
    `size-confirm-${session.id}`
  );
  return { emailed: to, products: pending.map((p) => p.id), ok: delivery.ok };
}

/* ---------------------------------------------------- the owner's order copy */

/** Order money is paid or covered by a gift card; both need packing. */
function isFulfillable(session) {
  return session.payment_status === "paid" || session.payment_status === "no_payment_required";
}

/**
 * "$30" for whole dollars, "$12.34" when there are cents -- the same rule every
 * price on the site follows (main.js formatMoney, gift-card-balance.js).
 */
function dollars(cents) {
  const n = Math.round(Number(cents) || 0);
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  return abs % 100 === 0 ? `${sign}$${abs / 100}` : `${sign}$${(abs / 100).toFixed(2)}`;
}

/**
 * A field that must stay on one line. CR and LF survive checkout.js's
 * stripControlChars (it keeps them on purpose, for gift messages), and a buyer
 * name or gift sender that broke onto a line of its own could pass for one of
 * this email's own headings in the plain-text body.
 */
function oneLine(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A free-text block, every line quoted. The message is printed verbatim, but a
 * line that reads "Ship to:" inside it is visibly the buyer's words, never the
 * real address block.
 */
function quoted(value) {
  return String(value === null || value === undefined ? "" : value)
    .split(/\r\n|\r|\n/)
    .map((line) => `  > ${line}`)
    .join("\n");
}

/**
 * The session's line items, and whether there are more than were read.
 *
 * Stripe hands the webhook a session WITHOUT them. `expand[]=line_items` on
 * the session returns ten and a `has_more`, and the cart allows fifty
 * (checkout.js MAX_LINE_ITEMS), so the list endpoint is read in pages of 100
 * instead. A session that arrives with them already expanded (the daily
 * digest's list call) is used as-is.
 *
 * One AbortController deadline covers every page, as the analytics send has.
 * The webhook is not waiting on this -- it runs behind ctx.waitUntil -- but a
 * Stripe that never answers must not hold the isolate open either.
 *
 * @returns {Promise<{items: Array|null, truncated: boolean}>} null items when
 *   nothing could be read; the caller still sends, and says so.
 */
async function lineItemsFor(session, env) {
  const own = session.line_items;
  if (own && Array.isArray(own.data)) return { items: own.data, truncated: own.has_more === true };
  if (!env.STRIPE_SECRET_KEY || typeof session.id !== "string") {
    return { items: null, truncated: false };
  }
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), OWNER_EMAIL_STRIPE_TIMEOUT_MS)
    : null;
  const items = [];
  const partial = () => ({ items: items.length ? items : null, truncated: items.length > 0 });
  try {
    let startingAfter = null;
    for (let page = 0; page < OWNER_EMAIL_LINE_ITEM_PAGES; page++) {
      const params = new URLSearchParams({ limit: "100" });
      if (startingAfter) params.set("starting_after", startingAfter);
      const res = await fetch(
        `${STRIPE_API_BASE}/checkout/sessions/${encodeURIComponent(session.id)}/line_items?${params}`,
        {
          headers: {
            Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
            "Stripe-Version": STRIPE_API_VERSION
          },
          signal: controller ? controller.signal : undefined
        }
      );
      if (!res || !res.ok) return partial();
      const list = await res.json();
      const data = list && Array.isArray(list.data) ? list.data : [];
      items.push(...data);
      if (!list || list.has_more !== true || !data.length) return { items, truncated: false };
      startingAfter = data[data.length - 1].id;
    }
    return { items, truncated: true };
  } catch (err) {
    console.warn(
      "Non-fatal: could not read the line items for",
      session.id,
      err && err.name === "AbortError" ? "(timed out)" : err && err.message
    );
    return partial();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One row per Stripe line: quantity, the label checkout.js wrote (which
 * already carries a chosen size or scent, "Tank Top (M)"), the unit price and
 * the line total BEFORE discounts -- discounts are shown once, on the order.
 */
function describeLineItems(items) {
  return items.map((item) => {
    const rawQty = Number(item && item.quantity);
    const qty = Number.isFinite(rawQty) && rawQty > 0 ? Math.round(rawQty) : 1;
    const label =
      oneLine((item && item.description) || (item && item.price && item.price.nickname)) ||
      "(unnamed line)";
    const subtotal = Number(item && item.amount_subtotal);
    const lineCents = Number.isFinite(subtotal) ? subtotal : Number(item && item.amount_total);
    const unit = Number(item && item.price && item.price.unit_amount);
    const unitCents = Number.isFinite(unit)
      ? unit
      : Number.isFinite(lineCents)
        ? Math.round(lineCents / qty)
        : NaN;
    return { qty, label, unitCents, lineCents };
  });
}

/**
 * What is inside a build-your-own box (`custom_box_N`) and what was chosen
 * inside a gift set (`gift_set_N`) -- both live only in session metadata,
 * because each is one Stripe line. In line order, so box 10 follows box 9.
 */
function contentsOf(session) {
  const metadata = session.metadata || {};
  return Object.keys(metadata)
    .map((key) => /^(custom_box|gift_set)_(\d+)$/.exec(key))
    .filter(Boolean)
    .sort((a, b) => a[1].localeCompare(b[1]) || Number(a[2]) - Number(b[2]))
    .map((m) => ({ kind: m[1], n: m[2], value: oneLine(metadata[m[0]]) }))
    .filter((row) => row.value)
    .map((row) =>
      row.kind === "custom_box"
        ? `Box ${row.n} contents: ${row.value}`
        : `Set choices: ${row.value}`
    );
}

/**
 * Every gift note on the order, for the owner's copy.
 *
 * Wider than gift-note.js's `giftNotesOf`, on purpose: that one feeds a
 * printed card, so it trims a recipient to the part before the "@" and skips
 * a card with no message. This is the fulfilment email, so it carries the
 * recipient address in full and lists a card that has a recipient or sender
 * but no message text -- a gift field is a gift field.
 */
function giftNoteRowsOf(session) {
  const metadata = session.metadata || {};
  const rows = [];
  const orderMessage = String(metadata.gift_message || "").trim();
  if (metadata.is_gift_order === "true" && orderMessage) {
    rows.push({ recipient: "", sender: "", message: orderMessage });
  }
  const prefixes = new Set();
  for (const key of Object.keys(metadata)) {
    const m = /^(gift_card_\d+)_(recipient|sender|message)$/.exec(key);
    if (m) prefixes.add(m[1]);
  }
  for (const prefix of Array.from(prefixes).sort()) {
    const row = {
      recipient: oneLine(metadata[`${prefix}_recipient`]),
      sender: oneLine(metadata[`${prefix}_sender`]),
      message: String(metadata[`${prefix}_message`] || "").trim()
    };
    if (row.recipient || row.sender || row.message) rows.push(row);
  }
  return rows;
}

/**
 * The address Checkout COLLECTED FOR SHIPPING, as lines, or none. Stripe moved
 * it to `collected_information.shipping_details`; older sessions carry the
 * top-level `shipping_details`. Both are read. The billing address under
 * `customer_details` is deliberately NOT a fallback: checkout.js only asks
 * for a shipping address when there is something to ship, so a digital
 * (all-gift-card) order has none, and printing the card's billing address
 * under "Ship to" would send the owner to the post office with nothing.
 */
function shipToLinesOf(session) {
  const collected =
    (session.collected_information && session.collected_information.shipping_details) || null;
  const details = collected || session.shipping_details || null;
  const address = details && details.address;
  if (!address) return [];
  const cityLine =
    [address.city, address.state].filter(Boolean).join(", ") +
    (address.postal_code ? ` ${address.postal_code}` : "");
  return [details.name, address.line1, address.line2, cityLine, address.country]
    .map(oneLine)
    .filter(Boolean);
}

function paymentIntentIdOf(session) {
  const intent = session.payment_intent;
  return typeof intent === "string"
    ? intent
    : intent && typeof intent === "object"
      ? intent.id
      : "";
}

/** "Sep 3, 2026, 2:15 PM ET" -- the shop's own clock. */
function placedAtOf(session) {
  const created = Number(session.created);
  if (!Number.isFinite(created) || created <= 0) return "";
  const date = new Date(created * 1000);
  try {
    return `${date.toLocaleString("en-US", {
      timeZone: "America/New_York",
      dateStyle: "medium",
      timeStyle: "short"
    })} ET`;
  } catch {
    return date.toISOString();
  }
}

/**
 * The owner's copy of one order: plain text is the real one, the HTML mirrors
 * it. Exported so the suites can look at the body without a fetch stub.
 *
 * @param {object} session      the Checkout Session off the event
 * @param {Array|null} items    line items, or null when Stripe could not be read
 * @param {{truncated?: boolean, giftNoteEmailed?: boolean}} [opts]
 *   `truncated`: Stripe had more lines than were read; `giftNoteEmailed`: the
 *   "Gift note to print" email went out for this order, so it can be pointed at
 */
export function ownerOrderEmail(session, items, opts = {}) {
  const metadata = session.metadata || {};
  const lines = Array.isArray(items) ? describeLineItems(items) : null;
  const truncated = opts.truncated === true;
  const totals = session.total_details || {};
  const totalCents = Number(session.amount_total);
  const giftCardCents = Math.max(0, Number(metadata.gift_card_amount_applied_cents || 0));
  const discountCents = Math.max(0, Number(totals.amount_discount || 0) - giftCardCents);
  const shippingCents = Number(totals.amount_shipping || 0);
  const taxCents = Number(totals.amount_tax || 0);
  const discountCode = oneLine(metadata.discount_code);
  const pickupMarket = oneLine(metadata.pickup_market);
  const pickupRejected = metadata.pickup_market_rejected === "true";
  const shipTo = pickupMarket ? [] : shipToLinesOf(session);
  // Nothing collected for shipping and nothing charged for it: a digital order.
  // Nothing collected but shipping charged is a session shape this code does
  // not expect, and says so rather than guessing.
  const isDigital = !pickupMarket && !shipTo.length && !(shippingCents > 0);
  const contents = contentsOf(session);
  const notes = giftNoteRowsOf(session);
  const isGift = metadata.is_gift_order === "true" || notes.length > 0;
  const buyerName = oneLine(session.customer_details && session.customer_details.name);
  const buyerEmail = oneLine(buyerEmailOf(session));
  const paymentIntentId = paymentIntentIdOf(session);
  const dashboardLink = paymentIntentId
    ? `https://dashboard.stripe.com/payments/${encodeURIComponent(paymentIntentId)}`
    : "";
  const placedAt = placedAtOf(session);

  const total = Number.isFinite(totalCents) ? dollars(totalCents) : "";
  const lead = lines && lines.length ? `${lines[0].qty}× ${lines[0].label}` : `order ${session.id}`;
  // "+N more" only when N is known: a truncated read says "more" and no number.
  const more = truncated ? " +more" : lines && lines.length > 1 ? ` +${lines.length - 1} more` : "";
  const headline =
    Number.isFinite(totalCents) && totalCents === 0
      ? "New order (paid by gift card)"
      : `New order${total ? ` ${total}` : ""}`;
  const subject = `${headline} -- ${lead}${more}`;

  const lineText = (line) =>
    `  ${line.qty}× ${line.label}` +
    (Number.isFinite(line.lineCents)
      ? ` -- ${dollars(line.unitCents)} each, ${dollars(line.lineCents)}`
      : "");
  const moneyRows = [];
  if (Number.isFinite(Number(session.amount_subtotal))) {
    moneyRows.push(["Subtotal", dollars(session.amount_subtotal)]);
  }
  if (discountCents > 0) {
    moneyRows.push([
      "Discount",
      `-${dollars(discountCents)}${discountCode ? ` (${discountCode})` : ""}`
    ]);
  }
  if (giftCardCents > 0) moneyRows.push(["Gift card", `-${dollars(giftCardCents)} applied`]);
  if (!pickupMarket && !isDigital) {
    moneyRows.push(["Shipping", shippingCents > 0 ? dollars(shippingCents) : "Free"]);
  }
  if (taxCents > 0) moneyRows.push(["Tax", dollars(taxCents)]);
  if (total) moneyRows.push(["Total", total]);
  const pad = (label) => `${label}:`.padEnd(11);
  const MORE_LINES = "... and more lines -- see the Stripe Dashboard";
  const NO_LINES = "(Line items could not be read from Stripe -- open the order for them.)";
  const PICKUP_REJECTED =
    "Buyer asked for a market pick-up that did not match the calendar -- this order ships.";
  const DIGITAL = "Digital delivery -- no shipping";
  const NO_ADDRESS = "(no address on the session -- see Stripe)";
  const PRINT_POINTER = 'A printable copy is in the "Gift note to print" email.';

  const textParts = [`New order${placedAt ? ` -- ${placedAt}` : ""}`, ""];
  if (lines) textParts.push(...lines.map(lineText));
  else textParts.push(`  ${NO_LINES}`);
  if (truncated) textParts.push(`  ${MORE_LINES}`);
  textParts.push(...contents.map((row) => `  ${row}`));
  textParts.push("", ...moneyRows.map(([label, value]) => `${pad(label)} ${value}`), "");
  textParts.push(
    `Buyer: ${[buyerName, buyerEmail ? `<${buyerEmail}>` : ""].filter(Boolean).join(" ") || "(no details)"}`
  );
  if (isGift) {
    textParts.push("", "Gift note");
    if (!notes.length) textParts.push("  Marked as a gift -- no note text.");
    notes.forEach((note, i) => {
      if (i) textParts.push("");
      if (note.recipient) textParts.push(`  To: ${note.recipient}`);
      if (note.sender) textParts.push(`  From: ${note.sender}`);
      if (note.message) textParts.push(quoted(note.message));
    });
    if (opts.giftNoteEmailed) textParts.push(`  (${PRINT_POINTER})`);
  }
  textParts.push("");
  if (pickupRejected) textParts.push(PICKUP_REJECTED);
  if (pickupMarket) textParts.push(`Local pick-up at ${pickupMarket}`);
  else if (shipTo.length) textParts.push("Ship to:", ...shipTo.map((part) => `  ${part}`));
  else if (isDigital) textParts.push(DIGITAL);
  else textParts.push(`Ship to: ${NO_ADDRESS}`);
  textParts.push("");
  if (dashboardLink) textParts.push(`Stripe: ${dashboardLink}`);
  textParts.push(`Session: ${session.id}`);
  const text = textParts.join("\n") + "\n";

  const p = (body, style) => `<p style="margin:6px 0;${style || ""}">${body}</p>`;
  const h2 = (label) => `<h2 style="font-size:15px;margin:16px 0 6px;">${label}</h2>`;
  const htmlLines = lines
    ? lines
        .map(
          (line) =>
            `<li>${escapeHtml(`${line.qty}× ${line.label}`)}` +
            (Number.isFinite(line.lineCents)
              ? ` <span style="color:#6b5f52;">-- ${escapeHtml(dollars(line.unitCents))} each, ${escapeHtml(dollars(line.lineCents))}</span>`
              : "") +
            "</li>"
        )
        .join("")
    : `<li>${escapeHtml(NO_LINES)}</li>`;
  const htmlMore = truncated ? `<li>${escapeHtml(MORE_LINES)}</li>` : "";
  const htmlContents = contents.map((row) => `<li>${escapeHtml(row)}</li>`).join("");
  const htmlMoney = moneyRows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:2px 12px 2px 0;color:#6b5f52;">${escapeHtml(label)}</td>` +
        `<td style="padding:2px 0;${label === "Total" ? "font-weight:bold;" : ""}">${escapeHtml(value)}</td></tr>`
    )
    .join("");
  const htmlGift = isGift
    ? h2("Gift note") +
      (notes.length
        ? notes
            .map(
              (note) =>
                '<div style="margin:0 0 10px;padding:8px 12px;border-left:3px solid #d69b5c;">' +
                (note.recipient ? p(`<strong>To:</strong> ${escapeHtml(note.recipient)}`) : "") +
                (note.sender ? p(`<strong>From:</strong> ${escapeHtml(note.sender)}`) : "") +
                (note.message ? p(escapeHtml(note.message), "white-space:pre-wrap;") : "") +
                "</div>"
            )
            .join("")
        : p("Marked as a gift -- no note text.")) +
      (opts.giftNoteEmailed ? p(escapeHtml(PRINT_POINTER), "color:#6b5f52;font-size:13px;") : "")
    : "";
  const htmlShip =
    (pickupRejected ? p(escapeHtml(PICKUP_REJECTED), "color:#8a3b12;") : "") +
    (pickupMarket
      ? p(`<strong>Local pick-up at</strong> ${escapeHtml(pickupMarket)}`)
      : shipTo.length
        ? h2("Ship to") + p(shipTo.map((part) => escapeHtml(part)).join("<br>"))
        : isDigital
          ? p(`<strong>${escapeHtml(DIGITAL)}</strong>`)
          : p(`<strong>Ship to:</strong> ${escapeHtml(NO_ADDRESS)}`));

  const html =
    '<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#1b1712;">' +
    `<h1 style="font-size:19px;">${escapeHtml(subject)}</h1>` +
    (placedAt ? p(escapeHtml(placedAt), "color:#6b5f52;") : "") +
    `<ul style="margin:0;padding-left:18px;">${htmlLines}${htmlMore}${htmlContents}</ul>` +
    `<table style="margin:12px 0;border-collapse:collapse;font-size:14px;">${htmlMoney}</table>` +
    p(
      `<strong>Buyer:</strong> ${escapeHtml(buyerName || "(no name)")}` +
        (buyerEmail
          ? ` &lt;<a href="mailto:${escapeHtml(buyerEmail)}">${escapeHtml(buyerEmail)}</a>&gt;`
          : "")
    ) +
    htmlGift +
    htmlShip +
    (dashboardLink
      ? p(
          `<a href="${escapeHtml(dashboardLink)}">Open the payment in Stripe</a>`,
          "margin-top:16px;"
        )
      : "") +
    p(`Session: ${escapeHtml(session.id)}`, "color:#6b5f52;font-size:13px;") +
    "</div>";

  return { subject, text, html };
}

/**
 * The deferred half of emailOwnerOrderNotice: the switch, the line items, the
 * send. NEVER REJECTS -- every failure is logged and becomes an outcome,
 * because this runs behind ctx.waitUntil where nothing would catch it.
 */
async function sendOwnerOrderNotice(session, env, ctx, to) {
  try {
    const site = await loadSiteSettings(env, ctx);
    if (site.enableOrderEmails === false) return { skipped: "disabled" };
    const { items, truncated } = await lineItemsFor(session, env);
    const body = ownerOrderEmail(session, items, {
      truncated,
      // The same condition emailGiftNoteLink sends on: note TEXT, and a secret
      // to sign the link with. A recipient or sender alone gets no print email.
      giftNoteEmailed: giftNotesOf(session).length > 0 && Boolean(env.MAGIC_LINK_SECRET)
    });
    const delivery = await sendEmail(
      env,
      { from: fromAddress(env), to, reply_to: REPLY_TO, ...body },
      `owner-order-email-${session.id}`
    );
    if (!delivery.ok) {
      console.warn(
        `Non-fatal: Resend refused the owner copy of ${session.id} (${delivery.status})`
      );
    }
    return { emailed: to, ok: delivery.ok, lines: items ? items.length : null };
  } catch (err) {
    console.warn("Non-fatal: owner order email failed:", err && err.message);
    return { emailed: to, ok: false };
  }
}

/**
 * Every paid order gets the owner one email with what the bench needs: each
 * line with its quantity, size or scent and price, what was discounted, what
 * shipping cost, the total, the buyer, the gift note itself, the FULL shipping
 * address (or the pick-up market, or "digital delivery"), and the payment in
 * the Stripe Dashboard. The public order-status route and the daily digest
 * stop at city and state on purpose; this is the fulfilment copy, and it goes
 * to the shop inbox only.
 *
 * OFF THE MONEY PATH, like reportRevenue: the checks that need nothing from
 * the network run here, and everything else -- the CMS switch, the line-item
 * read, the send -- is handed to ctx.waitUntil, so Stripe gets its 200 as fast
 * as it did before this email existed and a slow Stripe or Resend can neither
 * delay nor fail the webhook. sendOwnerOrderNotice never rejects; a refusal is
 * logged and swallowed, like the buyer's backup copy of a gift card. The owner
 * also has Stripe's own merchant notice, so a lost courtesy email is not worth
 * replaying the money path for. `owner-order-email-<session>` is the Resend
 * idempotency key, so a redelivered event sends one copy.
 *
 * Without a ctx there is nothing to hand the work to, so it is awaited -- that
 * is the test harness, never production.
 *
 * Gated by `site.enableOrderEmails` (default on) and by the recipient, which
 * walks the same ladder as the gift-note email and ends at the contact address.
 */
export async function emailOwnerOrderNotice(session, env, ctx) {
  if (!isFulfillable(session)) {
    return { skipped: `payment-status-${session.payment_status || "unknown"}` };
  }
  const to = env.ORDER_NOTIFY_EMAIL || env.RESTOCK_NOTIFY_EMAIL || REPLY_TO;
  if (!to) return { skipped: "no-recipient" };
  if (!env.RESEND_API_KEY) {
    console.error(
      "stripe-webhook: RESEND_API_KEY is not configured; no owner copy for",
      session.id
    );
    return { skipped: "no-resend-key" };
  }
  const attempt = sendOwnerOrderNotice(session, env, ctx, to);
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(attempt);
    return { queued: true, emailed: to };
  }
  return attempt;
}

/**
 * The card the shopper spent, settled.
 *
 * The reservation was taken when the session was created (see
 * applyGiftCard in workers/checkout.js); paying turns it into a permanent
 * debit. `commit` is idempotent, so a redelivery moves no money.
 *
 * A missing reservation is logged and NOT retried. It means the money was
 * discounted without a hold -- which this code path cannot produce, since a
 * failed hold expires the session before anyone can pay it -- and retrying
 * forever would only bury the anomaly under three days of 500s.
 */
async function settleRedemption(session, env) {
  const metadata = session.metadata || {};
  const code = metadata.gift_card_redeemed_code;
  const appliedCents = Number(metadata.gift_card_amount_applied_cents || 0);
  if (!code || !(appliedCents > 0)) return null;

  const ledger = giftCardLedger(env, code);
  let committed;
  try {
    committed = await ledger.commit({ sessionId: session.id });
  } catch (err) {
    if (err instanceof LedgerError && err.code === "reservation_not_found") {
      console.error(
        `Gift card ${code} was applied to ${session.id} with no reservation on the ledger`
      );
      return null;
    }
    throw err;
  }
  if (committed.alreadyCommitted) return committed;

  const snapshot = await ledger.getBalance();
  const to = snapshot.recipientEmail || buyerEmailOf(session);
  if (to) {
    const body = balanceUpdateEmailBody(ledger.code, committed.cents, snapshot.balanceCents);
    await sendEmail(
      env,
      { from: fromAddress(env), to, reply_to: REPLY_TO, ...body },
      `gift-balance-email-${session.id}-${ledger.code}`
    );
  }
  return committed;
}

/**
 * Cards bought in this order: minted on the ledger and emailed.
 *
 * The code is DERIVED, not drawn (see deriveGiftCardCode), so a redelivery
 * re-derives the same string, `issue` no-ops on it, and Resend's idempotency
 * key suppresses the duplicate email. One retry therefore cannot turn one
 * purchased card into two.
 */
async function issuePurchasedCards(session, env) {
  const units = giftCardUnitsFrom(session.metadata);
  if (!units.length) return [];

  const buyer = buyerEmailOf(session);
  const issued = [];
  for (const unit of units) {
    if (!unit.recipientEmail || !Number.isFinite(unit.amountCents) || unit.amountCents <= 0) {
      console.error(`Gift card metadata incomplete for ${session.id}, unit ${unit.unitKey}`);
      continue;
    }
    const code = await deriveGiftCardCode(session.id, unit.unitKey, env.STRIPE_WEBHOOK_SECRET);
    await giftCardLedger(env, code).issue({
      initialCents: unit.amountCents,
      recipientEmail: unit.recipientEmail,
      source: "checkout"
    });

    const recipientBody = recipientEmailBody(
      code,
      unit.amountCents,
      unit.senderName,
      unit.personalMessage
    );
    const delivery = await sendEmail(
      env,
      {
        from: fromAddress(env),
        to: unit.recipientEmail,
        reply_to: REPLY_TO,
        ...recipientBody
      },
      `gift-email-${session.id}-${unit.unitKey}`
    );
    if (!delivery.ok) {
      // The card exists on the ledger and nobody has been told its code. That
      // is worth a retry, so it throws.
      throw new Error(`Resend refused the gift-card email for ${session.id}/${unit.unitKey}`);
    }

    if (buyer) {
      const isSelfGift = buyer.toLowerCase() === String(unit.recipientEmail).trim().toLowerCase();
      const backup = buyerEmailBody(
        code,
        unit.amountCents,
        unit.recipientEmail,
        unit.personalMessage,
        isSelfGift
      );
      try {
        // Non-fatal: the recipient already has the card. A failed backup copy
        // must not put the whole webhook into Stripe's retry loop.
        await sendEmail(
          env,
          { from: fromAddress(env), to: buyer, reply_to: REPLY_TO, ...backup },
          `gift-buyer-email-${session.id}-${unit.unitKey}`
        );
      } catch (err) {
        console.warn("Non-fatal: buyer confirmation email failed:", err && err.message);
      }
    }
    issued.push({ code, unitKey: unit.unitKey, amountCents: unit.amountCents });
  }
  return issued;
}

/**
 * An abandoned checkout. The hold goes back on the card and the ephemeral
 * coupon is deleted -- left alone it is a live `amount_off` coupon in the
 * Stripe account, usable by anyone who learns its id, for money the shopper
 * still has.
 */
async function handleSessionExpired(session, env) {
  const metadata = session.metadata || {};
  const results = {};
  const code = metadata.gift_card_redeemed_code;
  if (code) {
    results.release = await giftCardLedger(env, code).release({
      sessionId: session.id,
      reason: "session_expired"
    });
  }
  if (metadata.gift_card_ephemeral_coupon_id) {
    results.couponDeleted = await deleteCoupon(env, metadata.gift_card_ephemeral_coupon_id);
    if (!results.couponDeleted) {
      throw new Error(
        `Could not delete ephemeral coupon ${metadata.gift_card_ephemeral_coupon_id}`
      );
    }
  }
  return results;
}

/**
 * A refunded order puts its gift-card share back on the card.
 *
 * Never more than the card paid, never more than has actually been refunded,
 * and never twice for the same money. Stripe re-sends `charge.refunded` for
 * each partial refund as well as on retry, so the amount already restored for
 * THIS charge is read back off the ledger and only the difference is credited.
 */
async function handleChargeRefunded(charge, env) {
  const paymentIntentId =
    charge.payment_intent && typeof charge.payment_intent === "object"
      ? charge.payment_intent.id
      : charge.payment_intent;
  if (!paymentIntentId) return null;

  const session = await findSessionByPaymentIntent(env, paymentIntentId);
  if (!session) return null;

  const metadata = session.metadata || {};
  const code = metadata.gift_card_redeemed_code;
  const appliedCents = Number(metadata.gift_card_amount_applied_cents || 0);
  if (!code || !(appliedCents > 0)) return null;

  const refundedCents = Number(charge.amount_refunded || 0);
  if (!(refundedCents > 0)) return null;
  const restorableCents = Math.min(appliedCents, refundedCents);

  const ledger = giftCardLedger(env, code);
  const history = await ledger.history();
  const alreadyRestored = (history.ledger || [])
    .filter(
      (row) =>
        row.kind === "restore" &&
        typeof row.external_id === "string" &&
        (row.external_id === charge.id || row.external_id.startsWith(`${charge.id}-`))
    )
    .reduce((sum, row) => sum + Number(row.delta_cents || 0), 0);

  const deltaCents = restorableCents - alreadyRestored;
  if (deltaCents <= 0) return { code: ledger.code, restoredCents: 0, alreadyRestored: true };

  // The key carries the cumulative restorable total, so a redelivery of the
  // same refund is an exact no-op while a LARGER later refund is a new claim
  // for its own difference.
  const result = await ledger.restore({
    chargeId: `${charge.id}-${restorableCents}`,
    cents: deltaCents
  });

  const to =
    result.recipientEmail || (charge.billing_details && charge.billing_details.email) || null;
  if (to) {
    const body = refundEmailBody(ledger.code, deltaCents, result.balanceCents);
    try {
      await sendEmail(
        env,
        { from: fromAddress(env), to, reply_to: REPLY_TO, ...body },
        `gift-refund-email-${charge.id}-${restorableCents}`
      );
    } catch (err) {
      // The money is back on the card; an unsent notice is not worth replaying
      // the whole event for.
      console.warn("Non-fatal: refund notification email failed:", err && err.message);
    }
  }
  return { code: ledger.code, restoredCents: deltaCents, balanceCents: result.balanceCents };
}

/**
 * The order signal the whole retention sequence hangs off.
 *
 * ONE LIGHTWEIGHT ROW, not a copy of the order -- Stripe stays the system of
 * record (docs/STATE-LAYER.md). What is stored is the address, its hash, the
 * product ids and categories, and the timestamp: exactly what a delayed email
 * needs to be written days later without calling Stripe back.
 *
 * The product ids come from session metadata written at checkout
 * (`retention_product_ids` / `retention_categories` in workers/checkout.js), so
 * this costs no extra Stripe request. Both writes are INSERT OR IGNORE, so a
 * redelivered event records nothing and queues nothing.
 */
async function recordAndSchedule(session, env, ctx, now = Date.now()) {
  if (!env.STATE_DB) return null;
  const email = buyerEmailOf(session);
  if (!email) return null;
  const metadata = session.metadata || {};
  const splitList = (value) =>
    String(value || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

  const signal = await recordOrder(
    env.STATE_DB,
    {
      orderId: session.id,
      email,
      productIds: splitList(metadata.retention_product_ids),
      categories: splitList(metadata.retention_categories)
    },
    now
  );
  const queued = await scheduleOrderSequence(
    env.STATE_DB,
    {
      order_id: session.id,
      email,
      placed_at: now,
      product_ids: splitList(metadata.retention_product_ids).join(","),
      categories: splitList(metadata.retention_categories).join(",")
    },
    now,
    // `usageGuideDelayDays` at /admin. The switch beside it is read at send
    // time by the drain, not here -- turning it off has to stop what is
    // already queued.
    await loadSiteSettings(env, ctx)
  );
  return { recorded: signal.recorded, queued };
}

/**
 * Points for this order, and a payout if the balance has reached the threshold.
 *
 * Runs off the webhook and nowhere else: a credit on the strength of a request
 * body is exactly the hole audit finding C-1 closed. `credit` is idempotent on
 * the order id, so a redelivery pays nothing twice.
 */
async function creditPoints(session, env, ctx, now = Date.now()) {
  if (!env.STATE_DB) return null;
  const email = buyerEmailOf(session);
  if (!email) return null;
  // `amount_subtotal` is the goods before shipping and tax -- points are earned
  // on what was bought, not on the postage.
  const cents = Number(
    session.amount_subtotal !== undefined && session.amount_subtotal !== null
      ? session.amount_subtotal
      : session.amount_total
  );
  if (!Number.isFinite(cents) || cents <= 0) return null;
  return creditLoyaltyForOrder(env, ctx, { orderId: session.id, email, amountCents: cents }, now);
}

/**
 * Books this order's revenue in Umami, once, from the server.
 *
 * THIS FUNCTION MUST NEVER THROW AND MUST NEVER BE AWAITED IN A WAY THAT CAN
 * FAIL THE WEBHOOK. It is the only step here that talks to a third party that
 * has nothing to do with the order being fulfilled. Everything it can go wrong
 * about -- no binding, no website id, an unusable amount, a timeout, a rejected
 * User-Agent -- returns a reason and logs it. A thrown error here would make
 * the webhook answer non-2xx, which makes Stripe redeliver, which re-runs the
 * money path. Analytics is not allowed to cost that.
 *
 * `payment_status` is checked explicitly rather than trusted from the event
 * type: `checkout.session.completed` fires for a session that COMPLETED, which
 * for an asynchronous payment method can mean "unpaid, we will tell you later".
 * Only "paid" is money. ("no_payment_required" -- a 100%-gift-card order -- is
 * deliberately NOT reported: Stripe captured nothing, so booking it as revenue
 * would inflate the takings by the value of a card the shop had already been
 * paid for once.)
 *
 * @returns {Promise<object|null>} an outcome for the webhook's own log/response.
 */
async function reportRevenue(session, env, ctx) {
  if (!env.STATE_DB) return { sent: false, reason: "no-state-db" };
  if (session.payment_status !== "paid") {
    return { sent: false, reason: `payment-status-${session.payment_status || "unknown"}` };
  }
  const websiteId = String(env.UMAMI_WEBSITE_ID || "").trim();
  /* Read from the Worker's own env, never from the site build: the Worker has
     no filesystem and no access to assets/data/content.json, and a Worker that
     silently stopped reporting revenue because a static build changed would be
     the worst kind of failure. Unset is a defined state -- log once and do
     nothing, exactly like the unset coupon ids. */
  if (!websiteId) {
    console.warn("stripe-webhook: UMAMI_WEBSITE_ID is not set -- revenue is not being reported");
    return { sent: false, reason: "not-configured" };
  }

  const body = buildOrderPaidPayload(session, websiteId);
  if (!body) return { sent: false, reason: "unusable-amount" };

  /* Claimed BEFORE the send and never released afterwards. A redelivered
     Stripe event (or a retry after some later step threw) must not book the
     same money twice -- an analytics send is not idempotent at the far end,
     and an overstated Revenue report is worse than a missing row because it
     looks right. */
  let claimed = false;
  try {
    claimed = await claimAnalyticsSend(env.STATE_DB, ORDER_PAID, session.id);
  } catch (err) {
    console.error("analytics: could not claim the revenue send:", err && err.message);
    return { sent: false, reason: "claim-failed" };
  }
  if (!claimed) return { sent: false, reason: "already-sent" };

  /* Fire and forget. waitUntil keeps the isolate alive until the POST settles
     without holding the webhook's response, so Stripe gets its 200 at the same
     speed it did before analytics existed. */
  const attempt = sendToUmami(body).then(async (outcome) => {
    if (!outcome.sent) {
      console.error(`analytics: "Order Paid" was not recorded (${outcome.reason})`);
      /* Only give the claim back when the request provably never left. A send
         that timed out or returned a bad status may well have been recorded at
         the other end, and re-sending it would double-count. */
      if (outcome.reason === "no-fetch") {
        try {
          await releaseAnalyticsSend(env.STATE_DB, ORDER_PAID, session.id);
        } catch {
          /* best-effort */
        }
      }
    }
    return outcome;
  });
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(attempt);
  return { sent: true, queued: true, revenue: body.payload.data.revenue };
}

/**
 * Runs the sub-handlers for one verified event. Each is isolated: a failure is
 * collected, not propagated immediately, so one broken step cannot stop the
 * others from running. Anything collected is re-thrown at the end so Stripe
 * retries the event as a whole -- which is safe because every step is
 * idempotent.
 */
export async function processStripeEvent(event, env, ctx) {
  const failures = [];
  const outcome = { type: event.type };

  if (event.type === "checkout.session.completed") {
    const session = event.data.object || {};
    try {
      outcome.redemption = await settleRedemption(session, env);
    } catch (err) {
      failures.push(`redemption: ${err && err.message}`);
    }
    try {
      outcome.issued = await issuePurchasedCards(session, env);
    } catch (err) {
      failures.push(`gift-card issue: ${err && err.message}`);
    }
    try {
      outcome.retention = await recordAndSchedule(session, env, ctx);
    } catch (err) {
      failures.push(`retention: ${err && err.message}`);
    }
    try {
      outcome.loyalty = await creditPoints(session, env, ctx);
    } catch (err) {
      failures.push(`loyalty: ${err && err.message}`);
    }
    try {
      outcome.giftNote = await emailGiftNoteLink(session, env);
    } catch (err) {
      failures.push(`gift-note: ${err && err.message}`);
    }
    try {
      outcome.sizeConfirmation = await emailSizeConfirmation(session, env, ctx);
    } catch (err) {
      failures.push(`size-confirmation: ${err && err.message}`);
    }
    /* Deliberately NOT pushed to `failures`, for the same reason as the
       revenue step below: the owner's copy is a courtesy on top of Stripe's
       own merchant notice, and a lost one must never make Stripe replay the
       money path. The work itself runs behind ctx.waitUntil and swallows its
       own failures; the catch is here because "does not throw" is a promise
       the next edit could break. After the gift-card steps on purpose: the
       cards are minted and the buyer told before anything is queued. */
    try {
      outcome.ownerNotice = await emailOwnerOrderNotice(session, env, ctx);
    } catch (err) {
      console.warn("Non-fatal: owner order email threw (ignored):", err && err.message);
      outcome.ownerNotice = { ok: false, reason: "threw" };
    }
    /* Deliberately NOT pushed to `failures`. Every other step above is part of
       fulfilling the order, so a failure there should make Stripe redeliver.
       This one is a number on a dashboard: it must never be the reason the
       money path runs again. reportRevenue does not throw, and the catch is
       here anyway because "does not throw" is a promise the next edit could
       break. */
    try {
      outcome.revenue = await reportRevenue(session, env, ctx);
    } catch (err) {
      console.error("analytics: revenue reporting threw (ignored):", err && err.message);
      outcome.revenue = { sent: false, reason: "threw" };
    }
  } else if (event.type === "payment_intent.updated") {
    /* NOTE: Stripe does not send this event -- a metadata edit on a
       PaymentIntent fires nothing (verified against the event list,
       2026-09-04). The ship notice is really sent by the hourly cron sweep in
       routes/ship-notice.js. This branch stays so that, should Stripe ever
       add the event, the notice arrives within seconds instead of within the
       hour; it costs nothing while it never fires.

       PUSHED TO `failures` ON PURPOSE, unlike the owner's copy and the revenue
       ping in the branch above. This one is the customer's only push
       notification that their parcel exists, and a Resend outage must make
       Stripe redeliver rather than leave them watching a mailbox. */
    try {
      outcome.shipNotice = await emailShipNotice(event.data.object || {}, env, ctx);
    } catch (err) {
      failures.push(`ship-notice: ${err && err.message}`);
    }
  } else if (event.type === "checkout.session.expired") {
    const session = event.data.object || {};
    try {
      outcome.expired = await handleSessionExpired(session, env);
    } catch (err) {
      failures.push(`expiry: ${err && err.message}`);
    }
    try {
      // Only when Stripe issued a recovery URL, the shopper left an address,
      // AND they opted in to promotional email in Checkout's own consent box.
      outcome.recovery = env.STATE_DB ? await scheduleRecoveryEmail(env.STATE_DB, session) : null;
    } catch (err) {
      failures.push(`recovery: ${err && err.message}`);
    }
  } else if (event.type === "charge.refunded") {
    try {
      outcome.refund = await handleChargeRefunded(event.data.object || {}, env);
    } catch (err) {
      failures.push(`refund: ${err && err.message}`);
    }
  } else {
    outcome.ignored = true;
  }

  if (failures.length) {
    const error = new Error(failures.join("; "));
    error.partial = outcome;
    throw error;
  }
  return outcome;
}

export async function handleStripeWebhook(request, env, origin, ctx) {
  // Startup guard. Without the ledger there is nowhere to record a gift card,
  // and processing an order without it is worse than not processing it: 503
  // is a retryable status, so Stripe holds the event for us.
  //
  // STATE_DB (D1) is different: it only backs the exactly-once claim. Every
  // effect below is idempotent on its own (the ledger keys issue/commit/
  // release/restore on session or charge ids; Resend sends carry idempotency
  // keys), so a redelivery without the claim table is harmless. The binding
  // is optional until the owner has run `wrangler d1 create` (see
  // workers/README.md); the Worker logs once per isolate and carries on.
  if (!env.GIFT_CARD_LEDGER) {
    console.error("stripe-webhook: GIFT_CARD_LEDGER binding is missing");
    return json({ received: false, error: "state_unavailable" }, 503, origin, env);
  }
  const hasClaimTable = Boolean(env.STATE_DB);
  if (!hasClaimTable && !warnedNoStateDb) {
    warnedNoStateDb = true;
    console.warn(
      "stripe-webhook: STATE_DB binding is missing -- processing without the exactly-once claim table"
    );
  }

  const rawBody = await request.text();
  let event;
  try {
    event = await verifyStripeSignature(
      rawBody,
      request.headers.get("Stripe-Signature"),
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    // Real reason to the log, fixed string to the caller.
    console.error("Webhook signature verification failed:", err && err.message);
    return json({ error: "Invalid signature" }, 400, origin, env);
  }

  if (!event || typeof event.id !== "string") {
    return json({ error: "Invalid signature" }, 400, origin, env);
  }

  let claimed = false;
  try {
    if (hasClaimTable) {
      // Lazily, once per isolate: the Worker has no filesystem, so the schema
      // is applied from migrations.js rather than read from workers/schema.sql.
      await ensureSchema(env.STATE_DB);

      claimed = await claimEvent(env.STATE_DB, event.id, event.type);
      if (!claimed) {
        // A redelivery. Everything this event was going to do has already
        // been started or finished; doing it again is exactly what the claim
        // exists to prevent.
        return json({ received: true, duplicate: true }, 200, origin, env);
      }
    }

    await processStripeEvent(event, env, ctx);
    if (hasClaimTable) await markEventDone(env.STATE_DB, event.id);
    return json({ received: true }, 200, origin, env);
  } catch (err) {
    console.error("Webhook processing error:", err && (err.stack || err.message));
    if (claimed) {
      // Give the claim back, or Stripe's retries all no-op against a row that
      // says "someone is already handling this".
      try {
        await releaseEvent(env.STATE_DB, event.id);
      } catch (releaseErr) {
        console.error("Could not release the webhook claim:", releaseErr && releaseErr.message);
      }
    }
    return json({ received: false, error: "processing_failed" }, 500, origin, env);
  }
}

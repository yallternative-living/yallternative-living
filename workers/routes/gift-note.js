/**
 * @fileoverview GET /api/gift-note -- a printable gift card for the owner.
 *
 * WHY
 * The cart collects a gift note twice over (an order-level "this is a gift"
 * message, and a recipient / sender / message for each digital gift card) and
 * checkout.js writes all of it into the Stripe Checkout session's metadata.
 * Savanna could read it in the Stripe dashboard, but nothing turned it into
 * something she could slip into the parcel. This route renders that note as
 * a 4x6 card page with a Print button.
 *
 * WHO MAY OPEN IT
 * Only the owner: the link carries an HMAC token bound to the session id and
 * an expiry, signed with MAGIC_LINK_SECRET (the same secret that signs the
 * shop's other links, so rotating it invalidates every outstanding print link
 * too). The link is emailed to the owner by the Stripe webhook for every
 * order that carries gift text; nothing on the public site links here. The
 * token is not single-use on purpose -- a card may need printing twice.
 *
 * WHAT IT NEVER SHOWS
 * No prices, no card codes, no addresses beyond the first names the shopper
 * typed. The recipient email of a gift card is only used to greet by name
 * when no name was given (the part before the @).
 */

import { STRIPE_API_BASE, STRIPE_API_VERSION } from "./stripe.js";
import { escapeHtml } from "./http.js";

const SESSION_ID_RE = /^cs_(live|test)_[A-Za-z0-9]{8,}$/;
const DEFAULT_LINK_TTL_SECONDS = 180 * 24 * 60 * 60;
const encoder = new TextEncoder();

function bytesToBase64Url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return bytesToBase64Url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)))
  );
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Mint the print link for a session. Used by the webhook when it emails the
 * owner about a gift order.
 * @param {string} secret MAGIC_LINK_SECRET
 * @param {string} sessionId
 * @param {string} siteOrigin e.g. https://yallternativeliving.com
 * @param {{now?: number, ttlSeconds?: number}} [opts]
 */
export async function giftNoteLink(secret, sessionId, siteOrigin, opts = {}) {
  if (!secret) throw new Error("gift-note: MAGIC_LINK_SECRET is not configured.");
  if (!SESSION_ID_RE.test(String(sessionId || ""))) {
    throw new TypeError("gift-note: not a Checkout Session id.");
  }
  const now = Math.floor((opts.now || Date.now()) / 1000);
  const exp = now + Math.max(60, Number(opts.ttlSeconds) || DEFAULT_LINK_TTL_SECONDS);
  const sig = await hmac(secret, `gift-note|${sessionId}|${exp}`);
  const base = String(siteOrigin || "").replace(/\/+$/, "");
  return `${base}/api/gift-note?session_id=${encodeURIComponent(sessionId)}&t=${exp}.${sig}`;
}

async function verifyGiftNoteToken(secret, sessionId, token, now = Date.now()) {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{20,})$/.exec(String(token || ""));
  if (!m) return false;
  const exp = Number(m[1]);
  if (!Number.isFinite(exp) || exp * 1000 < now) return false;
  const expected = await hmac(secret, `gift-note|${sessionId}|${exp}`);
  return timingSafeEqual(expected, m[2]);
}

/** Does this session carry anything worth printing? Shared with the webhook. */
export function giftNotesOf(session) {
  const metadata = (session && session.metadata) || {};
  const notes = [];
  const orderMessage = String(metadata.gift_message || "").trim();
  if (metadata.is_gift_order === "true" && orderMessage) {
    notes.push({ kind: "order", message: orderMessage, recipient: "", sender: "" });
  }
  Object.keys(metadata).forEach((key) => {
    const mm = /^(gift_card_\d+)_message$/.exec(key);
    if (!mm) return;
    const message = String(metadata[key] || "").trim();
    if (!message) return;
    const prefix = mm[1];
    const recipientEmail = String(metadata[`${prefix}_recipient`] || "").trim();
    notes.push({
      kind: "gift-card",
      message,
      recipient: recipientEmail ? recipientEmail.split("@")[0] : "",
      sender: String(metadata[`${prefix}_sender`] || "").trim()
    });
  });
  return notes;
}

function firstNameOf(session) {
  const details = (session && session.customer_details) || {};
  const name = String(details.name || "").trim();
  return name ? name.split(/\s+/)[0] : "";
}

function htmlResponse(html, status) {
  return new Response(html, {
    status: status || 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'"
    }
  });
}

const PAGE_STYLE = `
  @page { size: 4in 6in; margin: 0.25in; }
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #ece6d8; color: #1b1712; font-family: Georgia, "Times New Roman", serif; }
  .toolbar { display: flex; gap: 12px; align-items: center; padding: 14px 18px; font-family: system-ui, sans-serif; font-size: 14px; background: #fff; border-bottom: 1px solid #d8cfbd; }
  .toolbar button { font: inherit; padding: 8px 16px; border-radius: 999px; border: 1px solid #7f4a13; background: #7f4a13; color: #fff; cursor: pointer; }
  .toolbar .muted { color: #6b5f52; }
  .sheet { display: grid; gap: 24px; padding: 24px; justify-items: center; }
  .card { width: 4in; min-height: 6in; background: #fbf7ee; border: 1px solid #cdbf9f; border-radius: 6px; padding: 0.45in 0.4in; display: flex; flex-direction: column; justify-content: space-between; box-shadow: 0 6px 24px rgba(20, 15, 8, 0.12); }
  .mark { font-family: system-ui, sans-serif; font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; color: #7f4a13; text-align: center; }
  .brand { font-size: 18px; text-align: center; margin: 6px 0 0; }
  .for { font-family: system-ui, sans-serif; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #6b5f52; margin: 0.35in 0 0.12in; }
  .msg { font-size: 15px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
  .from { font-style: italic; font-size: 14px; margin: 0.3in 0 0; }
  .foot { font-family: system-ui, sans-serif; font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase; color: #8a7d6d; text-align: center; margin-top: 0.3in; }
  .empty { max-width: 32em; margin: 48px auto; padding: 0 24px; font-family: system-ui, sans-serif; line-height: 1.5; }
  @media print { .toolbar { display: none; } body { background: #fff; } .sheet { padding: 0; gap: 0; } .card { box-shadow: none; border: none; page-break-after: always; min-height: 5.5in; } }
`;

export function renderGiftNoteHtml(session, notes) {
  const buyer = firstNameOf(session);
  const cards = notes
    .map((n) => {
      const to = n.recipient ? escapeHtml(n.recipient) : "";
      const from = n.sender || buyer;
      return (
        '<article class="card" aria-label="Gift note">' +
        '<div><p class="mark">Handmade in Landrum, SC</p><p class="brand">Y&#39;allternative Living</p>' +
        '<p class="for">' +
        (to ? "For " + to : "A little something for you") +
        "</p>" +
        '<p class="msg">' +
        escapeHtml(n.message) +
        "</p>" +
        (from ? '<p class="from">&mdash; ' + escapeHtml(from) + "</p>" : "") +
        "</div>" +
        '<p class="foot">Small-batch self-care &middot; y&#39;all means all</p>' +
        "</article>"
      );
    })
    .join("");
  const ref = escapeHtml(String((session && session.id) || ""));
  return (
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow"><title>Gift note to print</title>' +
    "<style>" +
    PAGE_STYLE +
    "</style></head><body>" +
    '<div class="toolbar"><button type="button" onclick="window.print()">Print</button>' +
    '<span class="muted">' +
    notes.length +
    (notes.length === 1 ? " card" : " cards") +
    " &middot; order " +
    ref +
    " &middot; 4&times;6 in, one per page</span></div>" +
    '<main class="sheet">' +
    cards +
    "</main></body></html>"
  );
}

function renderMessage(title, body, status) {
  return htmlResponse(
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>' +
      escapeHtml(title) +
      "</title><style>" +
      PAGE_STYLE +
      '</style></head><body><div class="empty"><h1>' +
      escapeHtml(title) +
      "</h1><p>" +
      escapeHtml(body) +
      "</p></div></body></html>",
    status
  );
}

/**
 * GET /api/gift-note?session_id=cs_...&t=<exp>.<sig>
 * @param {Request} request
 * @param {Object} env
 */
export async function handleGiftNote(request, env) {
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }
  const url = new URL(request.url);
  const sessionId = String(url.searchParams.get("session_id") || "").trim();
  const token = String(url.searchParams.get("t") || "").trim();
  const secret = env && env.MAGIC_LINK_SECRET;
  if (!secret) {
    return renderMessage(
      "Print links are not set up yet",
      "MAGIC_LINK_SECRET is not configured on the Worker, so gift-note links cannot be checked. The note is still on the order in Stripe.",
      503
    );
  }
  if (!SESSION_ID_RE.test(sessionId) || !(await verifyGiftNoteToken(secret, sessionId, token))) {
    return renderMessage(
      "This link is not valid",
      "It may have expired, or it was not the link from the order email. Open the order in Stripe to read the note, or ask for a fresh link.",
      403
    );
  }

  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("gift-note: STRIPE_SECRET_KEY is not configured.");
  const doFetch = env.fetchImpl || fetch;
  const res = await doFetch(
    `${STRIPE_API_BASE}/checkout/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_API_VERSION }
    }
  );
  if (!res || !res.ok) {
    if (res && (res.status === 404 || res.status === 400)) {
      return renderMessage("No such order", "Stripe has no Checkout Session with that id.", 404);
    }
    throw new Error(`gift-note: Stripe returned ${res ? res.status : "no response"}.`);
  }
  const session = await res.json();
  if (!session || session.error || session.id !== sessionId) {
    return renderMessage("No such order", "Stripe has no Checkout Session with that id.", 404);
  }
  const notes = giftNotesOf(session);
  if (!notes.length) {
    return renderMessage(
      "Nothing to print for this order",
      "The shopper did not leave a gift message on this order.",
      200
    );
  }
  return htmlResponse(renderGiftNoteHtml(session, notes), 200);
}

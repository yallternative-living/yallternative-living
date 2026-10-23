/**
 * @fileoverview OPTIONAL Cloudflare Worker: contact/review form handler.
 *
 * This is a SCAFFOLD, not wired into the live site. The live site currently
 * posts forms to Formspree. Deploy this only if you want to move form handling
 * off Formspree onto your own domain (Resend for delivery, Turnstile for bot
 * defense -- both have free tiers; see workers/README.md).
 *
 * Corrections applied vs. the original SOTA-report draft:
 *   - User input is HTML-escaped before being placed in the email body
 *     (the original interpolated name/email/message straight into HTML --
 *     an HTML/markup-injection hole).
 *   - CORS is locked to the real site origin(s), NOT "*".
 *   - Basic length caps and a required-field check.
 *   - Reply-To set to the submitter so replies work from your inbox.
 *
 * THE CONFIRMATION EMAIL
 * Formspree sends an autoresponse only on its paid plan. This Worker does it
 * for free: once the shop's notification has been accepted by Resend, the
 * person who wrote in gets a short plain-text note saying it arrived.
 *   - Never before, and never instead. If the notification fails the caller
 *     sees the failure (main.js then shows the mailto fallback) and no
 *     confirmation goes out -- telling someone "we got it" when nobody did is
 *     the one thing this must not do.
 *   - A failed confirmation is logged and swallowed. The message already
 *     reached the shop, so the visitor is told the truth: it was sent.
 *   - The text is fixed. Nothing the visitor typed is copied into it, so this
 *     Worker cannot be used to put someone else's words in an email from the
 *     shop's domain. Every promise in it is one the site already makes on the
 *     page the form sits on (contact.html, reviews.html) -- do not add one the
 *     site does not make.
 *   - reply_to is the shop mailbox, so answering the confirmation reaches a
 *     person, not the sending-only From address.
 *
 * Because the Worker now mails an address it was handed, it is rate-limited
 * twice, through the same checkRateLimit the checkout Worker's routes use: per
 * client IP (caps one sender) and per recipient address (caps how often anyone
 * can make the shop mail one inbox it does not own).
 *
 * Accepts both field spellings: the live forms' Formspree names (`_replyto`,
 * `_gotcha`) and this file's original ones (`email`, `website_hp`), so the
 * cutover is a change to each form's `action` and nothing else on the form.
 * A review (`review` field) may leave email blank, exactly as reviews.html
 * allows; it is still delivered, and simply gets no confirmation.
 *
 * Required Worker secrets / vars:
 *   - RESEND_API_KEY        (secret)
 *   - TURNSTILE_SECRET_KEY  (secret)
 *   - TO_EMAIL              (var)  where inquiries are delivered
 *   - FROM_EMAIL            (var)  a verified Resend sender, e.g.
 *                                  "Y'allternative Living <forms@yallternativeliving.com>"
 * Optional binding:
 *   - RATE_LIMIT_COUNTER    the checkout Worker's RateLimitCounter Durable
 *                           Object (bind it with script_name; see README).
 *                           Without it the limiter fails open and says so.
 *
 * Resend free tier (as of 2026): 3,000 emails/month AND 100 emails/day. Each
 * submission with an email address now costs TWO of those.
 */

import { checkRateLimit } from "./state/rate-limit.js";
import { clientIp, stripControlChars } from "./routes/http.js";
import { hashEmail } from "./state/retention.js";

const ALLOWED_ORIGINS = ["https://yallternativeliving.com", "https://www.yallternativeliving.com"];

const MAX_FIELD = 5000;
const MAX_EMAIL = 254;
const MAX_SUBJECT_NAME = 100;

/** Per client IP: a person sending a message and a review is fine; a script is not. */
export const FORM_IP_RATE_LIMIT = { limit: 5, period: 600 };
/** Per recipient: how often anyone can make the shop mail one address. */
export const FORM_RECIPIENT_RATE_LIMIT = { limit: 3, period: 3600 };

const SIGNATURE = ["", "Y'allternative Living", "Landrum, SC"];

// Every promise below is quoted from the page the form sits on:
//   contact -- contact.html / content.json contact.sections.formDesc:
//              "We typically respond within two business days."
//   review  -- reviews.html: "Savanna reads every one before it's posted, so it
//              might take a few days to show up." and the email field's
//              "(private -- we never publish this)".
export const CONFIRMATIONS = {
  contact: {
    subject: "We got your message",
    text: [
      "Thanks, y'all!",
      "",
      "This is an automatic note to let you know your message arrived.",
      "We typically respond within two business days.",
      "",
      "If you want to add anything before then, just reply to this email.",
      ...SIGNATURE
    ].join("\n")
  },
  review: {
    subject: "We got your review",
    text: [
      "Thanks, y'all!",
      "",
      "This is an automatic note to let you know your review arrived.",
      "Savanna reads every one before it's posted, so it might take a few days",
      "to show up. Your email address stays private: we never publish it.",
      ...SIGNATURE
    ].join("\n")
  }
};

function corsHeaders(origin, env) {
  const isAllowed =
    ALLOWED_ORIGINS.includes(origin) || (env && env.SITE_ORIGIN && origin === env.SITE_ORIGIN);
  const allow = isAllowed ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin"
  };
}

function json(body, status, origin, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin, env) }
  });
}

// Escape the five HTML-significant characters so submitted text can never
// inject markup into the notification email.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Form encoding turns every newline into CRLF; normalise back to LF so the
// plain-text body does not carry stray carriage returns.
function field(form, ...names) {
  for (const name of names) {
    const value = form.get(name);
    if (typeof value === "string" && value.trim()) {
      return value.replace(/\r\n?/g, "\n").slice(0, MAX_FIELD).trim();
    }
  }
  return "";
}

/** A value that is about to go into a header (subject, reply_to): one line. */
function oneLine(s) {
  return stripControlChars(s).replace(/[\r\n\t]+/g, " ");
}

function sendEmail(env, message) {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(message)
  });
}

const FAILED = { error: "An error occurred while sending your message. Please try again." };

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }
    if (request.method !== "POST") {
      return json({ error: "Method Not Allowed" }, 405, origin, env);
    }
    const isAllowedOrigin =
      ALLOWED_ORIGINS.includes(origin) || (env.SITE_ORIGIN && origin === env.SITE_ORIGIN);
    if (origin && !isAllowedOrigin) {
      return json({ error: "Forbidden origin" }, 403, origin, env);
    }

    try {
      const form = await request.formData();
      const honeypot = field(form, "website_hp", "_gotcha");

      // Honeypot: pretend success so bots don't learn they were caught.
      if (honeypot) {
        return json({ success: true, message: "Thanks! Your message was sent." }, 200, origin, env);
      }

      const isReview = Boolean(field(form, "review"));
      const kind = isReview ? "review" : "contact";
      const name = field(form, "name");
      const email = oneLine(field(form, "email", "_replyto"));
      const message = field(form, "message", "review");
      const product = field(form, "product");
      const rating = field(form, "rating");
      const turnstileToken = field(form, "cf-turnstile-response");

      // A review may leave email blank (reviews.html does not require it);
      // a contact message cannot -- there would be nobody to answer.
      if (!name || !message || (!isReview && !email)) {
        return json({ error: "Please fill in your name, email, and message." }, 400, origin, env);
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (email && (!emailRegex.test(email) || email.length > MAX_EMAIL)) {
        return json({ error: "Please provide a valid email address." }, 400, origin, env);
      }

      if (!env.RESEND_API_KEY || !env.TO_EMAIL || !env.FROM_EMAIL || !env.TURNSTILE_SECRET_KEY) {
        // Refusing to pretend: without these nothing can be checked or sent.
        console.error(
          "submit-form: RESEND_API_KEY, TO_EMAIL, FROM_EMAIL or TURNSTILE_SECRET_KEY is not configured"
        );
        return json(
          { error: "The form is temporarily unavailable. Please email us instead." },
          503,
          origin,
          env
        );
      }

      // Two keys. The recipient is keyed by its hash, as orders.js does, so no
      // raw address becomes a Durable Object name. The recipient one is checked only when there is a recipient,
      // and only after the IP one passes, so a blocked client cannot spend
      // somebody else's allowance.
      const tooMany = () =>
        json({ error: "Too many requests. Please wait a bit and try again." }, 429, origin, env);
      const byIp = await checkRateLimit(env, `form:ip:${clientIp(request)}`, {
        ...FORM_IP_RATE_LIMIT,
        failOpen: true
      });
      if (!byIp.success) return tooMany();
      if (email) {
        const byRecipient = await checkRateLimit(env, `form:to:${await hashEmail(email)}`, {
          ...FORM_RECIPIENT_RATE_LIMIT,
          failOpen: true
        });
        if (!byRecipient.success) return tooMany();
      }

      // Verify the Turnstile token.
      const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET_KEY,
          response: turnstileToken || "",
          remoteip: request.headers.get("CF-Connecting-IP") || ""
        })
      });
      const outcome = await verify.json();
      if (!outcome.success) {
        return json({ error: "Bot check failed. Please try again." }, 400, origin, env);
      }

      const subjectName = oneLine(name).slice(0, MAX_SUBJECT_NAME);
      const details = [
        ["Name", name],
        ["Email", email || "(not given)"],
        ...(isReview
          ? [
              ["Product", product],
              ["Rating", rating]
            ]
          : [])
      ].filter(([, value]) => value);
      const label = isReview ? "Review" : "Message";

      // 1. The notification to the shop. The submitter's address is the
      //    reply_to, never the From: it is unverified input.
      let delivered = null;
      try {
        delivered = await sendEmail(env, {
          from: env.FROM_EMAIL,
          to: [env.TO_EMAIL],
          ...(email ? { reply_to: email } : {}),
          subject: isReview ? `New review from ${subjectName}` : `New inquiry from ${subjectName}`,
          html:
            details.map(([k, v]) => `<p><strong>${k}:</strong> ${escapeHtml(v)}</p>`).join("") +
            `<p><strong>${label}:</strong></p><p>${escapeHtml(message).replace(/\n/g, "<br>")}</p>`,
          text: details.map(([k, v]) => `${k}: ${v}`).join("\n") + `\n\n${label}:\n${message}`
        });
      } catch (err) {
        console.error("submit-form: notification failed to send:", err && err.message);
      }
      if (!delivered || !delivered.ok) {
        throw new Error("Email delivery failed");
      }

      // 2. The confirmation, only now that the shop has the message.
      if (email) {
        const confirmation = CONFIRMATIONS[kind];
        try {
          const res = await sendEmail(env, {
            from: env.FROM_EMAIL,
            to: [email],
            reply_to: env.TO_EMAIL,
            subject: confirmation.subject,
            text: confirmation.text
          });
          if (!res || !res.ok) {
            console.error(
              `submit-form: ${kind} confirmation was not accepted (status ${res && res.status})`
            );
          }
        } catch (err) {
          console.error(`submit-form: ${kind} confirmation failed to send:`, err && err.message);
        }
      }

      return json({ success: true, message: "Thanks! Your message was sent." }, 200, origin, env);
    } catch (_err) {
      return json(FAILED, 500, origin, env);
    }
  }
};

export { escapeHtml, corsHeaders };

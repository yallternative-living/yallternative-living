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
 * Required Worker secrets / vars:
 *   - RESEND_API_KEY        (secret)
 *   - TURNSTILE_SECRET_KEY  (secret)
 *   - TO_EMAIL              (var)  where inquiries are delivered
 *   - FROM_EMAIL            (var)  a verified Resend sender, e.g.
 *                                  "Y'allternative Living <forms@yallternativeliving.com>"
 *
 * Resend free tier (as of 2026): 3,000 emails/month AND 100 emails/day.
 */

const ALLOWED_ORIGINS = [
  "https://yallternativeliving.com",
  "https://www.yallternativeliving.com",
];

const MAX_FIELD = 5000;

function corsHeaders(origin, env) {
  const isAllowed = ALLOWED_ORIGINS.includes(origin) || (env && env.SITE_ORIGIN && origin === env.SITE_ORIGIN);
  const allow = isAllowed ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function json(body, status, origin, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin, env) },
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }
    if (request.method !== "POST") {
      return json({ error: "Method Not Allowed" }, 405, origin, env);
    }
    const isAllowedOrigin = ALLOWED_ORIGINS.includes(origin) || (env.SITE_ORIGIN && origin === env.SITE_ORIGIN);
    if (origin && !isAllowedOrigin) {
      return json({ error: "Forbidden origin" }, 403, origin, env);
    }

    try {
      const form = await request.formData();
      const name = (form.get("name") || "").slice(0, MAX_FIELD);
      const email = (form.get("email") || "").slice(0, MAX_FIELD);
      const message = (form.get("message") || "").slice(0, MAX_FIELD);
      const honeypot = form.get("website_hp");
      const turnstileToken = form.get("cf-turnstile-response");

      // Honeypot: pretend success so bots don't learn they were caught.
      if (honeypot) {
        return json({ success: true, message: "Thanks! Your message was sent." }, 200, origin, env);
      }

      if (!name || !email || !message) {
        return json({ error: "Please fill in your name, email, and message." }, 400, origin, env);
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return json({ error: "Please provide a valid email address." }, 400, origin, env);
      }

      // Verify the Turnstile token.
      const verify = await fetch(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            secret: env.TURNSTILE_SECRET_KEY,
            response: turnstileToken || "",
            remoteip: request.headers.get("CF-Connecting-IP") || "",
          }),
        }
      );
      const outcome = await verify.json();
      if (!outcome.success) {
        return json({ error: "Bot check failed. Please try again." }, 400, origin, env);
      }

      const safeName = escapeHtml(name);
      const safeEmail = escapeHtml(email);
      const safeMessage = escapeHtml(message).replace(/\n/g, "<br>");

      const resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: env.FROM_EMAIL,
          to: [env.TO_EMAIL],
          reply_to: email,
          subject: `New inquiry from ${safeName}`,
          html:
            `<p><strong>Name:</strong> ${safeName}</p>` +
            `<p><strong>Email:</strong> ${safeEmail}</p>` +
            `<p><strong>Message:</strong></p><p>${safeMessage}</p>`,
        }),
      });
      if (!resendRes.ok) {
        throw new Error("Email delivery failed");
      }

      return json({ success: true, message: "Thanks! Your message was sent." }, 200, origin, env);
    } catch (_err) {
      return json({ error: "An error occurred while sending your message. Please try again." }, 500, origin, env);
    }
  },
};

export { escapeHtml };


/**
 * @fileoverview Netlify Function: Restock Alert & Product Review Handler.
 *
 * First-party endpoint for the "email me when this is back" form. It takes a
 * requester's email plus the product they're waiting on and FORWARDS it to
 * the shop by email (Resend), which is the whole point of the endpoint: the
 * previous version validated the address and then returned
 * "Thank you! We'll notify you..." without sending anything anywhere. Every
 * restock request the site ever collected was dropped on the floor while the
 * shopper was told it had been received.
 *
 * It also used to advertise "rate limiting" in this header. There is none:
 * Netlify Functions are stateless and this project has no shared store to
 * count attempts in. The honeypot below is the only bot defense here, and
 * that is now what the comment says. See workers/README.md.
 *
 * Env:
 *   RESEND_API_KEY        (required) -- without it the endpoint returns 503
 *                                       rather than pretending to succeed.
 *   RESTOCK_NOTIFY_EMAIL  (optional) -- where alerts go; defaults to
 *                                       contact@yallternativeliving.com.
 *   RESTOCK_FROM_EMAIL /
 *   GIFT_CARD_FROM_EMAIL  (optional) -- verified Resend sender.
 */

const ALLOWED_ORIGINS = ["https://yallternativeliving.com", "https://www.yallternativeliving.com"];

const DEFAULT_NOTIFY_EMAIL = "contact@yallternativeliving.com";

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Strip control characters (CR/LF included) before anything reaches an email
// header or subject line.
function clean(str) {
  return (
    String(str === null || str === undefined ? "" : str)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F]/g, " ")
      .trim()
  );
}

/**
 * Forward one restock request to the shop. Same transport as the other
 * Netlify function in this folder: a plain fetch to Resend, no SDK.
 * Returns { ok: true } or { ok: false, status } -- the caller decides what
 * the shopper is told, and is never told "sent" unless it was.
 */
async function sendRestockNotification(email, product, apiKey) {
  const key = apiKey || process.env.RESEND_API_KEY;
  if (!key) return { ok: false, status: 503 };

  const to = process.env.RESTOCK_NOTIFY_EMAIL || DEFAULT_NOTIFY_EMAIL;
  const from =
    process.env.RESTOCK_FROM_EMAIL ||
    process.env.GIFT_CARD_FROM_EMAIL ||
    "Y'allternative Living <orders@yallternativeliving.com>";
  const safeProduct = product || "this item";

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to,
      reply_to: email,
      subject: `Restock request: ${safeProduct}`,
      html:
        `<p><strong>${escapeHtml(email)}</strong> wants to be told when ` +
        `<strong>${escapeHtml(safeProduct)}</strong> is back in stock.</p>`,
      text: `${email} wants to be told when ${safeProduct} is back in stock.`
    })
  });

  return { ok: Boolean(res && res.ok), status: res && res.status ? res.status : 502 };
}

exports.handler = async function (event) {
  const origin = event.headers.origin || event.headers.Origin || "";
  const isAllowed = ALLOWED_ORIGINS.includes(origin) || process.env.SITE_ORIGIN === origin;
  const allowOrigin = isAllowed ? origin : ALLOWED_ORIGINS[0];

  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Vary: "Origin"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method Not Allowed" })
    };
  }

  let email = "";
  let product = "";
  try {
    let params = {};
    if (event.headers["content-type"]?.includes("application/x-www-form-urlencoded")) {
      params = Object.fromEntries(new URLSearchParams(event.body));
    } else {
      params = JSON.parse(event.body || "{}");
    }

    email = clean(params.email);
    product = clean(params.product || params.product_id).slice(0, 200);
    const honeypot = params.website_hp || params.hp_field;

    // Silent honeypot rejection for bots: they get the same success shape a
    // person gets, and nothing is sent or logged.
    if (honeypot) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, message: "Request received." })
      };
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Please enter a valid email address." })
      };
    }
  } catch (err) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid request payload." })
    };
  }

  // An unconfigured mailer is an outage, not a success. Saying "we'll let you
  // know" when nothing was recorded anywhere is the bug this endpoint had.
  if (!process.env.RESEND_API_KEY) {
    console.error("submit-restock: RESEND_API_KEY is not configured; request not forwarded");
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({
        error: "Restock alerts are temporarily unavailable. Please email us instead."
      })
    };
  }

  let delivery;
  try {
    delivery = await sendRestockNotification(email, product);
  } catch (err) {
    console.error("submit-restock: restock notification failed to send:", err && err.message);
    delivery = { ok: false, status: 502 };
  }

  if (!delivery.ok) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: "We could not record that request just now. Please try again shortly."
      })
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      message: `Thank you! We'll notify ${escapeHtml(email)} when ${escapeHtml(product) || "this item"} is back in stock.`
    })
  };
};

exports.sendRestockNotification = sendRestockNotification;
exports.escapeHtml = escapeHtml;

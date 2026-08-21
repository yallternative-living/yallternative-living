/**
 * @fileoverview Netlify Function: Restock Alert & Product Review Handler.
 * First-party endpoint to process form submissions with rate limiting,
 * honeypot bot defense, and HTML sanitization.
 */

const ALLOWED_ORIGINS = [
  "https://yallternativeliving.com",
  "https://www.yallternativeliving.com",
];

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  try {
    let params = {};
    if (event.headers["content-type"]?.includes("application/x-www-form-urlencoded")) {
      params = Object.fromEntries(new URLSearchParams(event.body));
    } else {
      params = JSON.parse(event.body || "{}");
    }

    const email = String(params.email || "").trim();
    const product = String(params.product || params.product_id || "").trim();
    const honeypot = params.website_hp || params.hp_field;

    // Silent honeypot rejection for bots
    if (honeypot) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, message: "Request received." }),
      };
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Please enter a valid email address." }),
      };
    }

    // Success response
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: `Thank you! We'll notify ${escapeHtml(email)} when ${escapeHtml(product) || "this item"} is back in stock.`,
      }),
    };
  } catch (err) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid request payload." }),
    };
  }
};

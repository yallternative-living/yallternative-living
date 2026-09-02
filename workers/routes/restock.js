/**
 * @fileoverview POST /api/restock -- "email me when this is back" -- plus the
 * two hourly cron jobs that make that promise true.
 *
 * Ported from netlify/functions/submit-restock.js, which forwarded the request
 * to the shop by email through Resend. That is STILL what the route does, and
 * on purpose: the owner's mailbox is where a "people want this" signal is
 * actually noticed. What has been added is the other half -- the request is now
 * also written to `restock_signups`, so `runRestockAlerts` can write back to the
 * SHOPPER once the product is on the shelf again. Before this, the only thing
 * standing between a signup and a sale was the owner remembering.
 *
 * Three behaviours from the original are load-bearing and were kept exactly:
 *   - The honeypot (`website_hp`) gets the SAME success shape a person gets,
 *     and stores nothing. A bot that can tell it was caught is a bot that
 *     stops filling the field.
 *   - A missing RESEND_API_KEY is a 503, not a cheerful "we'll let you know".
 *     The version before that returned success while sending nothing anywhere,
 *     so every restock request the site ever collected was dropped on the floor
 *     while the shopper was told it had been received.
 *   - The response body shape (`{success, message}` / `{error}`) is what the
 *     restock modal in assets/js/main.js reads. It did not change.
 *
 * What is new besides the row: the rate limit the old file's header comment
 * claimed and did not have, and a product-id check -- a signup for a product
 * that is not in the catalogue can never be matched to a restock, so it is
 * refused at the door rather than stored somewhere nothing will ever read it.
 *
 * THE TWO JOBS (called hourly from the `scheduled` handler in checkout.js):
 *   runRestockAlerts   -- emails every pending signup whose product is back in
 *                         stock. A marketing send, so it goes through
 *                         `sendMarketingEmail`: suppression list honoured, a
 *                         signed unsubscribe link, RFC 8058 headers.
 *   runLowStockCheck   -- one note to the owner, once a day, listing what is
 *                         running out and how many people are waiting on it.
 *                         Transactional (owner's own mailbox), so it does not
 *                         carry an unsubscribe link.
 *
 * Both are switchable from /admin without a deploy: `site.enableRestockAlerts`
 * and `site.enableLowStockAlerts` in assets/data/content.json.
 *
 * NOTHING HERE LOGS AN EMAIL ADDRESS. The jobs log product ids and counts; the
 * idempotency keys carry a SHA-256 of the address, never the address.
 */

import { json, readJson, clientIp, escapeHtml, stripControlChars } from "./http.js";
import { checkRateLimit } from "../state/rate-limit.js";
import { loadProductIndex, loadSiteSettings } from "../state/site-data.js";
import { fromAddress, sendEmail } from "./gift-cards.js";
import {
  RESTOCK_BATCH_LIMIT,
  addRestockSignup,
  markRestockNotified,
  pendingRestockCount,
  pendingRestockCounts,
  pendingRestockSignups
} from "../state/restock-signups.js";

export const RESTOCK_RATE_LIMIT = { limit: 5, period: 60 };
export const DEFAULT_NOTIFY_EMAIL = "contact@yallternativeliving.com";

/** `site.automations.lowStockThreshold` when the CMS field is unset. */
export const DEFAULT_LOW_STOCK_THRESHOLD = 3;

/** `site.automations.restockEmailIntro` when the CMS field is unset. */
export const DEFAULT_RESTOCK_INTRO =
  "Good news: the thing you asked us to watch is back on the shelf.";

/** The `job_state` key and the New York hour the daily low-stock note runs at. */
export const LOW_STOCK_JOB = "low-stock";
export const LOW_STOCK_HOUR = 8;

const SITE_ORIGIN_FALLBACK = "https://yallternativeliving.com";

/** A product id, as the catalogue spells them: `sleep-salve`, `tank-top`. */
const PRODUCT_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

/** Control characters (CR/LF included) never reach a header or subject line. */
function clean(value) {
  return (
    String(value === null || value === undefined ? "" : value)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F]/g, " ")
      .trim()
  );
}

function siteOriginOf(env) {
  return (env && env.SITE_ORIGIN) || SITE_ORIGIN_FALLBACK;
}

/** `site.automations` from content.json, or `{}`. */
function automationsOf(site) {
  const a = site && site.automations;
  return a && typeof a === "object" ? a : {};
}

/**
 * The numeric unit count for a product, or `null` when it does not track units.
 *
 * `undefined`, `null` and `""` all mean "not counted" -- which is NOT zero. A
 * salve with no `stock` field is made to order and always available; reading
 * that as "0 left" would silence every alert on the shop's best sellers.
 */
export function stockLevel(entry) {
  const raw = entry ? entry.stock : undefined;
  if (raw === null || raw === undefined || raw === "") return null;
  const count = Number(raw);
  return Number.isFinite(count) ? count : null;
}

/**
 * Is this product buyable right now? The same three fields the product card
 * reads, in the same order: `comingSoon` wins, then an explicit
 * `inStock: false`, then the unit count if there is one.
 */
export function isInStock(entry) {
  if (!entry) return false;
  if (entry.comingSoon) return false;
  if (entry.inStock === false) return false;
  const count = stockLevel(entry);
  return count === null || count > 0;
}

/**
 * Resolves what the form posted to a catalogue entry. Ids are how the modal
 * identifies a product (`<input name="product_id">`), but the name is accepted
 * as a fallback because the JSON contract documented in workers/README.md is
 * `{email, product}` and a caller may well send the display name there.
 *
 * @returns {object|null}
 */
export function findProduct(index, candidates) {
  if (!index || !index.size) return null;
  const wanted = candidates.map((c) => clean(c)).filter(Boolean);
  for (const value of wanted) {
    const hit = index.get(value);
    if (hit) return hit;
  }
  const lowered = wanted.map((v) => v.toLowerCase());
  for (const entry of index.values()) {
    if (lowered.includes(String(entry.name || "").toLowerCase())) return entry;
  }
  return null;
}

/* ------------------------------------------------------------- the emails */

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

/**
 * The back-in-stock note itself. The opening line is `restockEmailIntro` from
 * the CMS, so the owner can rewrite the pitch without a deploy; everything
 * around it is fixed, because the product name and the link have to be right.
 */
export function restockAlertEmail(product, intro, siteOrigin) {
  const name = (product && product.name) || "the thing you asked about";
  const url = `${siteOrigin}/products/${(product && product.id) || ""}.html`;
  const lead = clean(intro) || DEFAULT_RESTOCK_INTRO;
  const html = shell(
    `<h1 style="color:#d69b5c;">${escapeHtml(name)} is back</h1>` +
      `<p>${escapeHtml(lead)}</p>` +
      "<p>You asked us to tell you when it turned up again, so here we are. " +
      "Everything is made in small batches, so this is not a huge pile.</p>" +
      button(url, "Take a look") +
      '<p style="font-size:13px;color:#c9b8a8;">If you have already moved on, no hard ' +
      "feelings -- this is the only email you get about it.</p>"
  );
  const text =
    `${name} is back.\n\n${lead}\n\n` +
    "You asked us to tell you when it turned up again, so here we are. " +
    `Small batches, so it is not a huge pile:\n\n${url}\n\n` +
    "This is the only email you get about it.";
  return { subject: `Back in stock: ${name}`, html, text };
}

/**
 * The owner's daily "you are running out" note. One email listing everything at
 * or under the threshold, with the waiting-list count beside each row, because
 * "3 left and 11 people waiting" is a different decision from "3 left".
 *
 * @param {Array<{name: string, id: string, stock: number, waiting: number}>} rows
 */
export function lowStockEmail(rows, threshold, siteOrigin) {
  const count = rows.length;
  const listHtml = rows
    .map(
      (row) =>
        `<li style="margin-bottom:8px;"><strong>${escapeHtml(row.name)}</strong> -- ` +
        `${escapeHtml(String(row.stock))} left` +
        (row.waiting > 0
          ? `, <strong>${escapeHtml(String(row.waiting))}</strong> waiting on a restock alert`
          : ", nobody on the waiting list") +
        "</li>"
    )
    .join("");
  const html = shell(
    `<h1 style="color:#d69b5c;">${escapeHtml(String(count))} item${count === 1 ? " is" : "s are"} running low</h1>` +
      `<p>At or under ${escapeHtml(String(threshold))} left, as of this morning:</p>` +
      `<ul style="padding-left:20px;">${listHtml}</ul>` +
      button(`${siteOrigin}/admin/`, "Update stock in the CMS") +
      '<p style="font-size:13px;color:#c9b8a8;">Anyone on a waiting list is emailed ' +
      "automatically the next hour after the count goes back up. You do not have to do it.</p>"
  );
  const text =
    `${count} item${count === 1 ? " is" : "s are"} running low (at or under ${threshold} left):\n\n` +
    rows
      .map(
        (row) =>
          `- ${row.name}: ${row.stock} left, ` +
          (row.waiting > 0 ? `${row.waiting} waiting on a restock alert` : "nobody waiting")
      )
      .join("\n") +
    `\n\nUpdate stock: ${siteOrigin}/admin/\n` +
    "Waiting lists are emailed automatically once the count goes back up.";
  return {
    subject: `Low stock: ${count} item${count === 1 ? "" : "s"} at or under ${threshold}`,
    html,
    text
  };
}

/* ---------------------------------------------------------------- the route */

export async function handleRestock(request, env, origin) {
  const body = await readJson(request, "Invalid request payload.");

  const email = clean(body.email);
  const product = clean(
    body.product || body.product_name || body.product_id || body.productId
  ).slice(0, 200);
  const honeypot = body.website_hp || body.hp_field;

  // Silent honeypot rejection: same body, same status, nothing sent, nothing
  // stored, nothing logged.
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

  // Which product is this? The catalogue is the authority; an id it does not
  // know can never be matched to a restock, so storing one would be a row that
  // is read forever and acted on never.
  let index = new Map();
  try {
    index = await loadProductIndex(env, null);
  } catch (err) {
    console.warn("restock: product catalogue lookup failed:", err && err.message);
  }
  const entry = findProduct(index, [
    body.product_id,
    body.productId,
    body.product,
    body.product_name
  ]);
  if (index.size && !entry) {
    // The catalogue loaded and does not contain it. Refuse rather than pretend.
    return json(
      { error: "We could not find that product. Please refresh the page and try again." },
      400,
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

  // The row the hourly alert job reads. A repeat signup is a no-op thanks to
  // UNIQUE(product_id, email) -- it is a success, not an error, and the shopper
  // is told the same thing either way.
  //
  // Never fatal: if the state layer is missing or unhappy, the owner still gets
  // the notification below and the shopper still gets a straight answer. The
  // route degrading to exactly what it did before this table existed is the
  // whole point of the try/catch.
  const productId =
    (entry && entry.id) ||
    (PRODUCT_ID_RE.test(clean(body.product_id || body.productId || body.product))
      ? clean(body.product_id || body.productId || body.product)
      : "");
  if (!env.STATE_DB) {
    console.warn(
      "restock: STATE_DB is not bound; the shop was notified but no back-in-stock " +
        "signup was stored, so nobody will be emailed automatically"
    );
  } else if (!productId) {
    console.warn("restock: no usable product id on the request; signup not stored");
  } else {
    try {
      const stored = await addRestockSignup(env.STATE_DB, { productId, email });
      console.log(
        `restock: signup for ${productId} ${stored.duplicate ? "already on file" : "stored"}`
      );
    } catch (err) {
      console.error(`restock: could not store the signup for ${productId}:`, err && err.message);
    }
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

/* ----------------------------------------------------------------- the jobs */

/**
 * Hourly: email every pending signup whose product is in stock again.
 *
 * Ordering is deliberate. `notified_at` is set only AFTER the send comes back
 * ok, so a Resend outage is retried on the next tick rather than swallowed --
 * and it IS set for a suppressed or unmailable address, because reconsidering
 * an unsubscribed shopper every hour forever is its own kind of bug.
 *
 * At most RESTOCK_BATCH_LIMIT signups are handled per tick; a big list drains
 * over the next few hours. The cap is on rows handled, not sends, so a list
 * that is mostly suppressed addresses cannot turn one tick into a full scan.
 *
 * @returns {Promise<object>} a summary; never throws.
 */
export async function runRestockAlerts(env, ctx, now = Date.now()) {
  const db = env && env.STATE_DB;
  if (!db) {
    console.log("restock alerts: STATE_DB is not bound; nothing to send");
    return { skipped: "no-state-db" };
  }

  const site = await loadSiteSettings(env, ctx);
  if (site.enableRestockAlerts === false) {
    console.log("restock alerts: switched off in the CMS (site.enableRestockAlerts)");
    return { skipped: "disabled" };
  }
  if (!env.MAGIC_LINK_SECRET || !env.RESEND_API_KEY) {
    // Same rule the retention layer holds: no signing secret means no working
    // unsubscribe link, and no API key means no send at all. Both are quiet
    // configuration facts, not errors to page anyone about.
    console.log("restock alerts: MAGIC_LINK_SECRET and RESEND_API_KEY are both required; skipping");
    return { skipped: "unconfigured" };
  }

  const pending = await pendingRestockCounts(db);
  if (!pending.length) return { sent: 0, skipped: 0, failed: 0, products: 0 };

  const index = await loadProductIndex(env, ctx);
  if (!index.size) {
    console.warn("restock alerts: the product catalogue is unreachable; skipping this tick");
    return { skipped: "no-catalog" };
  }

  const { sendMarketingEmail } = await import("./retention-emails.js");
  const { hashEmail } = await import("../state/retention.js");
  const siteOrigin = siteOriginOf(env);
  const intro = automationsOf(site).restockEmailIntro;

  let budget = RESTOCK_BATCH_LIMIT;
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const products = [];

  for (const row of pending) {
    if (budget <= 0) break;
    const product = index.get(row.productId);
    if (!product || !isInStock(product)) continue;

    const signups = await pendingRestockSignups(db, row.productId, budget);
    if (!signups.length) continue;
    products.push(row.productId);

    const message = restockAlertEmail(product, intro, siteOrigin);
    for (const signup of signups) {
      if (budget <= 0) break;
      budget -= 1;
      let result;
      try {
        result = await sendMarketingEmail(env, db, {
          to: signup.email,
          subject: message.subject,
          html: message.html,
          text: message.text,
          // A SHA-256 of the address, never the address: this string ends up in
          // Resend's dashboard and in this Worker's logs.
          idempotencyKey: `restock-${product.id}-${await hashEmail(signup.email)}`
        });
      } catch (err) {
        console.error(`restock alerts: send failed for ${product.id}:`, err && err.message);
        result = { ok: false };
      }
      if (result && result.ok) {
        sent += 1;
        await markRestockNotified(db, signup.id, now);
      } else if (result && result.skipped) {
        // Suppressed or unmailable. Terminal, not a failure: close the row.
        skipped += 1;
        await markRestockNotified(db, signup.id, now);
      } else {
        failed += 1;
      }
    }
  }

  if (sent || skipped || failed) {
    console.log(
      `restock alerts: ${sent} sent, ${skipped} skipped, ${failed} deferred across ` +
        `${products.length} product(s): ${products.join(", ")}`
    );
  }
  return { sent, skipped, failed, products: products.length };
}

/**
 * Once a day at 08:00 America/New_York: one note to the owner listing every
 * product at or under `site.automations.lowStockThreshold`, with the number of
 * shoppers waiting on a restock alert for it.
 *
 * Nothing low means no email. An inbox that gets a daily "all fine" is an inbox
 * that stops reading the ones that are not.
 *
 * @returns {Promise<object>} a summary; never throws.
 */
export async function runLowStockCheck(env, ctx, now = Date.now()) {
  const db = env && env.STATE_DB;
  if (!db) {
    console.log("low-stock: STATE_DB is not bound; nothing to check");
    return { skipped: "no-state-db" };
  }

  const { claimDaily, nyClock } = await import("../state/job-state.js");
  const clock = nyClock(now);
  // The hour gate first, so 23 of the 24 daily ticks cost nothing at all -- no
  // catalogue fetch, no D1 read.
  if (clock.hour < LOW_STOCK_HOUR) return { skipped: "too-early" };

  const site = await loadSiteSettings(env, ctx);
  if (site.enableLowStockAlerts === false) {
    console.log("low-stock: switched off in the CMS (site.enableLowStockAlerts)");
    return { skipped: "disabled" };
  }
  if (!env.RESEND_API_KEY) {
    console.log("low-stock: RESEND_API_KEY is not configured; skipping");
    return { skipped: "unconfigured" };
  }

  if (!(await claimDaily(db, LOW_STOCK_JOB, LOW_STOCK_HOUR, now))) {
    return { skipped: "already-ran-today" };
  }

  const index = await loadProductIndex(env, ctx);
  if (!index.size) {
    console.error("low-stock: the product catalogue is unreachable; no note sent today");
    return { skipped: "no-catalog" };
  }

  const configured = Number(automationsOf(site).lowStockThreshold);
  const threshold =
    Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_LOW_STOCK_THRESHOLD;

  const low = [];
  for (const entry of index.values()) {
    if (entry.comingSoon) continue;
    const count = stockLevel(entry);
    if (count === null || count > threshold) continue;
    low.push({ id: entry.id, name: entry.name, stock: count, waiting: 0 });
  }
  if (!low.length) {
    console.log(`low-stock: nothing at or under ${threshold}; no note sent`);
    return { sent: 0, low: 0 };
  }
  low.sort((a, b) => a.stock - b.stock || a.id.localeCompare(b.id));
  for (const row of low) {
    row.waiting = await pendingRestockCount(db, row.id);
  }

  const message = lowStockEmail(low, threshold, siteOriginOf(env));
  const to = env.ORDER_NOTIFY_EMAIL || env.RESTOCK_NOTIFY_EMAIL || DEFAULT_NOTIFY_EMAIL;
  let ok = false;
  try {
    const res = await sendEmail(
      env,
      {
        from: env.RESTOCK_FROM_EMAIL || fromAddress(env),
        to,
        reply_to: DEFAULT_NOTIFY_EMAIL,
        subject: message.subject,
        html: message.html,
        text: message.text
      },
      `low-stock-${clock.day}`
    );
    ok = Boolean(res && res.ok);
  } catch (err) {
    console.error("low-stock: the owner note failed to send:", err && err.message);
  }
  if (!ok) console.error("low-stock: the owner note was not delivered");
  console.log(
    `low-stock: ${low.length} product(s) at or under ${threshold}: ${low.map((r) => r.id).join(", ")}`
  );
  return { sent: ok ? 1 : 0, low: low.length, threshold };
}

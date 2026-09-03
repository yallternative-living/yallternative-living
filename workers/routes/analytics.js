/**
 * @fileoverview Server-side revenue reporting to Umami.
 *
 * WHY THIS EXISTS
 * The browser used to book the money. `assets/js/thank-you.js` fired a
 * "Purchase" event carrying `revenue` once /api/order-summary confirmed the
 * order -- which is honest as far as it goes, and reaches Umami for maybe two
 * thirds of orders. It misses every shopper who closes the tab on the Stripe
 * redirect, every shopper who blocks the tracker, and every shopper whose
 * network filters it. Those are real orders with real money in them, and a
 * Revenue report that silently omits them is worse than no Revenue report: it
 * looks complete.
 *
 * So the money is reported from here, off `amount_total` on the Stripe session
 * that Stripe itself says was paid. `thank-you.js` still fires "Purchase" as
 * the funnel's last step, but with no properties at all, so the two can never
 * double-count.
 *
 * WHAT IS SENT, AND NOTHING ELSE
 *   { type: "event", payload: {
 *       website, hostname, url: "/thank-you.html",
 *       name: "Order Paid",
 *       data: { revenue: <dollars>, currency: <ISO 4217, upper case> } } }
 *
 * No email, no name, no address, no line items, and NOT the Stripe session id
 * -- the session id is the token /api/order-summary looks an order up with,
 * and the whole point of the URL scrubber on the client side is that it never
 * reaches a third-party dashboard. It is used here only as the local claim key
 * (workers/state/analytics-sends.js), which never leaves D1.
 *
 * WHY IT CAN NEVER BREAK THE WEBHOOK
 * Fire-and-forget behind ctx.waitUntil, with an AbortController timeout, and
 * every failure logged rather than thrown. The webhook's own contract is that
 * a non-2xx makes Stripe retry the whole event; an analytics outage must never
 * be able to trigger that, because the retry would re-run the money path. The
 * caller treats a rejected promise from here as "nothing happened".
 *
 * THE USER-AGENT IS LOAD-BEARING
 * Umami's collection endpoint runs every request through the npm `isbot`
 * package and answers `{beep:"boop"}` -- a 200, with nothing recorded -- for
 * anything it classifies as a bot (umami-software/umami
 * src/app/api/send/route.ts). Umami's own docs example, "Mozilla/5.0 (Server)",
 * IS classified as a bot by isbot 5.2.2, as is almost any bare
 * "Name/1.0" token: isbot has a catch-all pattern for user agents that do not
 * look like a browser. ORDER_PAID_USER_AGENT below was chosen by testing
 * candidates against the real package, and scripts/worker-analytics.test.js
 * re-tests it on every run so an isbot update cannot silently switch revenue
 * reporting off.
 */

/**
 * Identifies this Worker honestly and is not classified as a bot by isbot.
 * Verified against isbot 5.2.2. Do not "tidy" this string -- see the file
 * comment; the parenthetical after the version is what keeps it out of
 * isbot's catch-all `^[\w .\-():%]+(?:/v?\d+...)?(?:,|$)` pattern.
 */
export const ORDER_PAID_USER_AGENT = "YallternativeLiving/1.0 (order webhook)";

/** Umami Cloud's collection endpoint. The browser reaches this through the
    first-party proxy (scripts/lib/analytics-proxy.js); the Worker, which no
    blocker can see, talks to it directly. */
export const UMAMI_SEND_URL = "https://gateway.umami.is/api/send";

/** The site's own hostname, so the event lands on the same website row the
    browser's events do rather than inventing a second one. */
export const ANALYTICS_HOSTNAME = "yallternativeliving.com";

/** Where the shopper would have been when this fired. Matches the client
    "Purchase" event's page so funnels and journeys line up. */
export const ANALYTICS_URL = "/thank-you.html";

/** The event name. Deliberately NOT "Purchase": that name belongs to the
    client-side funnel step, and giving the two the same name would make every
    paid order look like two conversions in a funnel. */
export const ORDER_PAID_EVENT = "Order Paid";

/** Analytics must never hold the webhook open. */
export const ANALYTICS_TIMEOUT_MS = 3000;

/**
 * Dollars from Stripe's integer minor units.
 *
 * Stripe reports `amount_total` in the currency's smallest unit, which is
 * cents for USD but is the WHOLE unit for zero-decimal currencies (JPY, KRW).
 * This shop sells in USD only and the Worker only ever creates usd sessions,
 * so dividing by 100 is correct here -- but it is wrong in general, which is
 * why it is one named function with this comment rather than an inline `/100`
 * that gets copied somewhere it does not belong.
 *
 * @returns {number|null} the amount in major units, or null if unusable.
 */
export function revenueFromSession(session) {
  const cents = Number(session && session.amount_total);
  if (!Number.isFinite(cents) || cents <= 0) return null;
  return Math.round(cents) / 100;
}

/**
 * The ISO 4217 code, upper case.
 *
 * Umami "will default to USD" for a code it does not recognise (its Revenue
 * docs), so a junk value cannot corrupt the figures -- but it can put junk in
 * the record, so anything that is not three letters is refused outright rather
 * than guessed at.
 *
 * @returns {string|null}
 */
export function currencyFromSession(session) {
  const raw = String((session && session.currency) || "").toUpperCase();
  return /^[A-Z]{3}$/.test(raw) ? raw : null;
}

/**
 * Builds the exact payload Umami's collection API expects. Separated from the
 * sending so a test can assert the shape without a network.
 *
 * @returns {object|null} null when this session cannot be reported honestly.
 */
export function buildOrderPaidPayload(session, websiteId) {
  if (!websiteId) return null;
  const revenue = revenueFromSession(session);
  const currency = currencyFromSession(session);
  if (revenue === null || currency === null) return null;
  return {
    type: "event",
    payload: {
      website: websiteId,
      hostname: ANALYTICS_HOSTNAME,
      url: ANALYTICS_URL,
      name: ORDER_PAID_EVENT,
      data: { revenue, currency }
    }
  };
}

/**
 * POSTs one event to Umami. Resolves to a short outcome object; never throws.
 *
 * @param {object} body the payload from buildOrderPaidPayload
 * @param {object} [deps] test seam: { fetch, timeoutMs }
 */
export async function sendToUmami(body, deps = {}) {
  const doFetch = deps.fetch || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return { sent: false, reason: "no-fetch" };

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeoutMs = Number(deps.timeoutMs) || ANALYTICS_TIMEOUT_MS;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await doFetch(UMAMI_SEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Required. Umami rejects a request with no User-Agent, and treats a
        // bot-shaped one as a bot: see the file comment.
        "User-Agent": ORDER_PAID_USER_AGENT
      },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined
    });
    if (!res || !res.ok) {
      return { sent: false, reason: `http-${(res && res.status) || "none"}` };
    }
    /* A 200 is not proof it was recorded. Umami answers 200 with the body
       {"beep":"boop"} when its isbot check rejects the User-Agent, which is
       exactly the failure that would otherwise be invisible -- revenue simply
       stops appearing and nothing anywhere says why. Read the body and say so.
       A body we cannot read is not treated as a failure: the send went out. */
    let beeped = false;
    try {
      const text = await res.text();
      beeped = text.indexOf("beep") !== -1;
    } catch {
      /* unreadable body -- the POST still succeeded */
    }
    if (beeped) return { sent: false, reason: "bot-filtered" };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: (err && err.name === "AbortError" && "timeout") || "network" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

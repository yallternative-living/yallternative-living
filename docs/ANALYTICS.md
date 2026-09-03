# Analytics — Y'allternative Living

Everything the shop sends to Umami, what to set up in the Umami Cloud dashboard,
and the link-tagging convention for Instagram, Etsy and market QR codes.

Umami Cloud, website id `a134e5d8-e8e5-4a8e-90e9-c21e9dba5acb`, free **Hobby**
plan. The id lives in the CMS (`/admin` → Site Settings → `umamiWebsiteId`, i.e.
`assets/data/content.json` → `site.umamiWebsiteId`). Clearing it removes the
tracker from every page on the next `npm run build-data` — nothing loads and
nothing is counted.

---

## 1. What the site sends

### Page views

One per page load, automatically. Each carries the page URL, the page title, the
referrer, screen size, browser language, and a country/region derived from the
visitor's IP — which Umami uses to build a session hash and then discards. No
cookies, no advertising id, nothing that identifies a person.

**The query string is stripped before anything is sent.** This matters more here
than on most sites: the shop puts a Stripe Checkout Session id in
`thank-you.html?session_id=…` (that value is effectively an order-lookup token),
a subscriber's email address can arrive at `welcome.html?email=…`, and a reaction
report's reference number lands on `safety.html?report=received&ref=…`. None of
it reaches Umami. The `#fragment` is dropped too.

The one exception is deliberate: the five `utm_*` campaign parameters are put
back, so the UTM report below actually works. Everything else — including the
`gclid` / `fbclid` ad-click ids that Umami would otherwise collect for its
Attribution report — is dropped.

### Events

Nineteen events. Property names are exact; Goals and Funnels match on the event
**name**, so the names below are the contract.

| Event | Properties | Fires when |
| --- | --- | --- |
| `Product View` | `product` (id) | A product page loads |
| `Variant Selected` | `product`, `variant` | A size/scent is picked on a card or PDP |
| `Add to Cart` | `product` (name) | Any Add to Cart button |
| `Wishlist Add` | `product` (id) | A product is saved to the wishlist (adds only) |
| `Cart Opened` | `itemCount` | The shopper opens the cart drawer deliberately |
| `Cart Shared` | `itemCount` | The "share cart" button is used |
| `Gift Card Applied` | — | A gift card is successfully applied to a cart |
| `Checkout Start` | `itemCount`, `subtotalCents`, `isPickup` | The checkout POST leaves the browser |
| `Checkout Failed` | `reason` | The Worker or the network refused the checkout |
| `Purchase` | `revenue`, `currency` | **Only** after `/api/order-summary` confirms the order is paid and complete |
| `Site Search` | `length`, `hasResults` | A shop search settles (the text is never sent) |
| `Quiz Completed` | `result` (product id) | The apothecary quiz paints a recommendation |
| `Newsletter Signup` | — | The Kit redirect lands back with `?subscribed=1` |
| `Restock Alert` | `product` | A confirmed back-in-stock signup |
| `Market Alert Signup` | — | A confirmed market-reminder signup |
| `Outbound Click` | `destination` | A link to Etsy / Instagram / TikTok / Facebook / elsewhere |
| `404` | `path` | A dead link was followed |
| `PWA Installed` | — | The site is installed as an app |
| `App Updated` | — | The "new version" prompt is accepted |
| `Language Changed` | `language` | The translator switches language |

`Checkout Failed`'s `reason` is one of a fixed set — `timeout`, `gift-card`,
`network`, `no-session-url`, `rejected`, `rate-limited`, `server-error`, or
`http-<status>`. It is never the server's own error text, because that text can
quote something the shopper typed.

**No event carries an email address, a name, an address, a gift message, a gift
card code, an order reference or a search query.** This is enforced in code, not
by convention: `window.ylAnalyticsBeforeSend` in `assets/js/main.js` deletes any
property whose key or value looks personal, and `scripts/analytics.test.js`
fails the build if a call site starts passing one.

### Watch the event budget

Hobby includes **100,000 events a month**, and Umami counts **each stored event
property as its own event**. A `Checkout Start` with three properties costs four,
not one. That is why events here carry one to three properties and never the
whole cart. If the shop grows into the limit, drop properties before dropping
events.

---

## 2. Set these up in the Umami dashboard

All of these are on the free Hobby plan.

**Goals** (Reports → Goals). A goal matches an event name or a URL — it cannot
match a property value.

- `Add to Cart`
- `Checkout Start`
- `Purchase`
- `Newsletter Signup`
- `Restock Alert` and `Market Alert Signup`
- `404` — this one is a goal you want to go *down*

**Funnel** (Reports → Funnel). Steps are URLs or event names, with a time window.
The shop's funnel:

1. Event `Product View`
2. Event `Add to Cart`
3. Event `Cart Opened`
4. Event `Checkout Start`
5. Event `Purchase`

A 30-minute window fits how people actually shop here. Build a second, shorter
funnel of `Checkout Start` → `Purchase` and watch it against `Checkout Failed`:
if the gap between them is wide and `Checkout Failed` is flat, people are
abandoning; if `Checkout Failed` tracks the gap, something is broken.

**Revenue** (Reports → Revenue) reads the `revenue` and `currency` properties on
the `Purchase` event and needs nothing else configured. Revenue is only ever
booked from the Worker's confirmed figure and is claimed once per Stripe session,
so a refreshed thank-you page cannot double-count.

**Retention** (Reports → Retention) groups visitors by the day they first
arrived. Most useful in the week after a market or a post.

**Journey** (Reports → Journey) wants three to seven steps of pages or events.
A good first one: `/index.html` → `/shop.html` → `Product View` → `Add to Cart`.

**UTM** (Reports → UTM) breaks views down by the five campaign parameters. It is
populated straight off the landing URL, so it only ever shows what you tagged —
see the next section.

**Attribution** (Reports → Attribution) offers first-click and last-click. It
will work off UTM tags. It will *not* show paid-click attribution, because the
ad-click ids are deliberately stripped; nothing is being bought today, so nothing
is lost. If the shop ever runs paid ads, add `gclid` / `fbclid` to
`ANALYTICS_ALLOWED_PARAMS` in `assets/js/main.js` and say so on the privacy page.

---

## 3. Link tagging (UTM)

Only these five parameters survive the scrubber, so any other tagging scheme will
silently vanish. Lower case, hyphens, no spaces.

| Parameter | Use |
| --- | --- |
| `utm_source` | Where the link lives: `instagram`, `tiktok`, `facebook`, `etsy`, `market-qr`, `email` |
| `utm_medium` | What kind of link: `bio`, `story`, `post`, `reel`, `dm`, `qr`, `newsletter`, `listing` |
| `utm_campaign` | What it is for: `fall-2026`, `pride-2026`, `sleep-salve-launch`, `restock` |
| `utm_content` | Which version, when there is more than one: `story-1`, `story-2`, `blue-flyer` |
| `utm_term` | Optional. The product or theme: `sleep-salve` |

Worked examples:

```
Instagram bio link
https://yallternativeliving.com/shop.html?utm_source=instagram&utm_medium=bio&utm_campaign=fall-2026

Instagram story about one product
https://yallternativeliving.com/products/sleep-salve.html?utm_source=instagram&utm_medium=story&utm_campaign=sleep-salve-launch&utm_content=story-1

Etsy shop announcement pointing at the site
https://yallternativeliving.com/?utm_source=etsy&utm_medium=listing&utm_campaign=send-them-home

Newsletter
https://yallternativeliving.com/shop.html?utm_source=email&utm_medium=newsletter&utm_campaign=restock
```

**Market QR codes.** Give every market its own code so the report tells you which
booth worked:

```
https://yallternativeliving.com/?utm_source=market-qr&utm_medium=qr&utm_campaign=<market-slug>
```

with `<market-slug>` matching the event id in `assets/data/events.json` — e.g.
`utm_campaign=landrum-fall-market`. Print a fresh code per market rather than
reusing one; the code costs nothing and the answer to "was that market worth it"
is otherwise unknowable. If the QR should drop someone straight into pickup for
that market, keep the existing `?pickup_market=` parameter on the link too — it
still works, it is simply not reported.

---

## 4. Keeping your own visits out

**Your own browsing.** Open the site, open the browser console, and run:

```js
localStorage.setItem("umami.disabled", 1);
```

That browser stops being counted on this site, permanently, until you run
`localStorage.removeItem("umami.disabled")`. Do it once per browser and per
device you browse the shop from. This is the only self-exclusion Umami offers on
the Hobby plan — dashboard IP filters start at the Pro plan.

Worth knowing: if your home network's router blocks ads and trackers at the DNS
level, your visits are already invisible to Umami, and so is every visitor whose
network or browser does the same. Analytics here is a floor on real traffic, not
a count of it.

**Development, testing and previews.** Handled automatically. The tracker tag
carries `data-domains="yallternativeliving.com,www.yallternativeliving.com"`, and
Umami disables itself entirely on any other hostname. That covers `localhost`,
the `127.0.0.1` port the Puppeteer suites serve on, and Netlify deploy previews
at `*.netlify.app`. This is load-bearing rather than tidy: Umami's server-side
bot filter matches User-Agent strings, and modern headless Chrome sends an
ordinary Chrome User-Agent, so a test run would otherwise have posted hundreds of
real page views into the production dataset. `scripts/analytics.test.js` fails if
the attribute goes missing.

**Do Not Track** is honoured (`data-do-not-track="true"`). Umami ignores the
browser's DNT signal unless that attribute is set explicitly.

**Pages that are never counted:** `offline.html` (the no-network fallback) and
`/admin` (the CMS carries no tracker at all).

---

## 5. If the dashboard goes quiet

Check the browser console on the live site for a Content-Security-Policy
violation **first**.

The tracker is downloaded from `cloud.umami.is` but posts its data to a different
host, `gateway.umami.is`. Both need to be in the CSP —
`script-src` for the first, `connect-src` for the second. When only the script
origin was allowed, the tracker loaded perfectly and every single page view and
event was refused by the browser; the dashboard read zero and nothing anywhere
reported an error.

Umami has moved that collection host repeatedly without a changelog or a
migration notice (`analytics.umami.is` → `api-gateway-eu.umami.dev` →
`api-gateway.umami.dev` → `gateway.umami.is`) and does not document it. If
analytics stops with no other change, read the host literal back out of
`https://cloud.umami.is/script.js`, then update `scripts/build-security-headers.js`
and run `npm run build-security-headers`. `npm test` asserts that `connect-src`
names the host.

To verify a deploy by hand: open the live site with DevTools on the Network tab,
add something to the cart, and confirm the `POST` to `/api/send` returns 200 with
no CSP violation in the console.

---

## 6. Known limits

- **Ad and tracker blockers** block `script.js` and `/api/send` by name. Umami's
  documented workaround is a same-origin proxy that re-serves the script under
  another path. Not implemented here: it is a deliberate call, since dodging a
  blocker the visitor chose to install sits badly next to the privacy page.
- **`Purchase` is sent from the browser**, so a shopper who closes the tab on the
  Stripe redirect, or who blocks the tracker, is not counted and their revenue is
  not booked. The robust fix is to send it server-side from the Stripe webhook in
  `workers/routes/stripe-webhook.js` (Umami's `@umami/node` package, or a plain
  POST with a User-Agent header). Worth doing if revenue reporting starts
  mattering.
- **Prerendering.** The site prerenders links on hover via Speculation Rules, and
  the tracker has no prerender awareness of its own, so a hovered-but-never-opened
  page would have counted as a visit. `main.js` drops anything sent while
  `document.prerendering` is true and re-fires the page view on activation. In
  browsers that do not expose `document.prerendering`, prerendered views may
  still be counted.
- **Hobby data retention is six months.** Export anything you want to keep
  year-on-year (Data export is available on Hobby).

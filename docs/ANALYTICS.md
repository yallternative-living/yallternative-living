# Analytics — Y'allternative Living

Everything the shop sends to Umami, what to set up in the Umami Cloud dashboard,
and the link-tagging convention for Instagram, Etsy and market QR codes.

Umami Cloud, website id `a134e5d8-e8e5-4a8e-90e9-c21e9dba5acb`, free **Hobby**
plan. The id lives in two places on purpose:

- the CMS (`/admin` → Site Settings → `umamiWebsiteId`, i.e.
  `assets/data/content.json` → `site.umamiWebsiteId`) — this is what puts the
  tracker on every page. Clearing it removes the tracker on the next
  `npm run build-data`: nothing loads and nothing is counted.
- `UMAMI_WEBSITE_ID` in `workers/wrangler.toml` — this is what lets the Stripe
  webhook book revenue. The Worker has no filesystem and cannot read the CMS.

**Change one, change the other, in the same commit.** `npm test` fails when they
disagree, because revenue landing in a dashboard nobody reads is exactly the kind
of failure that goes unnoticed for months.

---

## 0. Defaults and why

Every one of these is a deliberate choice with a cost on the other side. They
are written down so the next person can disagree with the reasoning rather than
guess at it.

### The tracker is loaded direct first, and proxied only if that fails

Every page loads one script of ours, `/assets/js/porch-light.js`, carrying the
tracker's `data-*` attributes. That loader injects **exactly one** of two copies:

1. **Direct** — `https://cloud.umami.is/script.js` with **no** `data-host-url`,
   so it posts straight to `gateway.umami.is` from the visitor's own browser.
2. **First-party**, only if the direct copy fires an `error` event —
   `/porch-light/script.js` with `data-host-url="/porch-light"`, proxied to Umami
   by `status = 200` rewrites in `netlify.toml` and `vercel.json`, and marked
   `data-tag="fallback"`.

**Why the fallback exists.** List-based blockers match **hostnames**. Both Umami
hosts are on those lists, and the shop owner's own router blocks them at DNS —
so without route 2, every visitor running a blocker or a filtering resolver
counted exactly nothing. A `<script>` fires `error` when the request is refused
*and* when it fails to resolve, so one handler catches both without a timer.

**Why it is the fallback and not the default.** Route 2 is not free: Umami builds
the session id from the IP that opened the connection and geolocates the same
address, which through a Netlify proxy is Netlify's edge. Proxying everybody
would have traded correct visitor counts and correct geography **for everybody**
to recover the blocked minority. Direct-first pays that cost only for the
visitors who would otherwise be invisible. §7 has the measurements and the
upstream references.

**Why these path names.** A first-party proxy at `/analytics/…` or `/umami/…`
would be caught by the same lists' generic path rules within a release or two.
`/porch-light/` carries none of the words those rules key on and is specific
enough to this shop that no list will ever ship a rule for it. The `/api/send`
suffix is not a choice: the tracker hardcodes `<data-host-url>/api/send`. All of
it is defined once, in `scripts/lib/analytics-proxy.js`, because the loader, the
emitted tag, the rewrite rules and the CSP all have to agree — and a
disagreement is silent in the worst way. A missing `cloud.umami.is` in
`script-src` does not break analytics; it quietly demotes **every** visitor to
route 2.

**The CSP allows both routes**, and all four entries are mandatory:
`script-src 'self' https://cloud.umami.is` and
`connect-src 'self' https://gateway.umami.is`. `npm test` asserts each one
separately, with the reason it matters in the failure message.

The direct route costs nothing extra. The fallback route does not cost a round
trip per page view either: `cloud.umami.is` serves the script with
`cache-control: public, max-age=86400, must-revalidate`, Netlify passes an
upstream response's own headers through on a proxy rule, and nothing in
`_headers` matches `/porch-light/…` to override it.

`sw.js` has an explicit skip for `/porch-light/`: the script ends in `.js`, and
the service worker's network-first branch would otherwise refetch it with
`cache: "reload"` on **every** page load — bypassing that 24-hour cache — and
then keep a third-party script in this site's own cache across deploys. A test
pins the skip.


### Do Not Track and Global Privacy Control are not honoured

`data-do-not-track` is absent from the tag, and the before-send hook does not
check `navigator.globalPrivacyControl`. Umami ignores DNT by default, so this is
the default rather than a suppression.

**Why.** DNT was retired by the browsers that shipped it (Firefox removed the
setting; Safari removed it in 2018) and neither signal carries legal force over
cookieless, aggregate measurement that stores no personal data about anybody.
Honouring them was measurably only costing the shop numbers.

**What is done instead** is not collecting the data in the first place: no
cookies, no cross-site identity, no `identify()`, no personal data in any
payload, and the query string stripped before anything is sent. `privacy.html`
says all of this in plain words, including that the counter is loaded from
Umami directly and from this site’s own address if something blocks that, so a
domain blocker will not stop it. A privacy page that promised DNT and a site that
ignored it would be worse than either choice; a page that quietly stopped being
true would be worse still.

The visitor-side off switch that **is** honoured, by the tracker itself, is
`localStorage.setItem("umami.disabled", 1)` — see §5.

### Revenue comes from the server, not the browser

The Stripe webhook books it (`workers/routes/analytics.js`), off `amount_total`
on the session Stripe says was paid.

**Why.** The browser only reports orders whose shopper comes back to
`thank-you.html` with the tracker working. Everyone who closes the tab on the
Stripe redirect, or blocks the tracker, or is behind a filtering resolver, was a
real order with real money that the Revenue report silently omitted while looking
complete.

The client `Purchase` event still fires, as the funnel's last step, but now
carries **no properties at all** — otherwise every order that did reach the page
would be counted twice.

### Deliberately still not done

- **No `umami.identify()`.** A persistent per-visitor id is the one change that
  would make the privacy page's "no cookies, no tracking" untrue, and it buys
  only better returning-visitor accuracy. The Retention report already gives
  cohorts without it.
- **No search text.** `Site Search` reports the length of a query and whether it
  found anything, never the words. People type symptoms into that box.
- **No cart contents, no order references, no addresses**, anywhere, ever.
- **No event property that is free text.** The before-send hook drops any value
  over 120 characters, anything that looks like an email address, and anything
  shaped like a Stripe id — so a future call site cannot quietly publish one.

---

## 1. What the site sends

### Page views

One per page load, automatically, plus one **performance** event per page load
(`data-performance="true"`) carrying Core Web Vitals — LCP, INP, CLS, FCP, TTFB
and the page's duration — measured on the visitor's real device. Each pageview
carries the page URL, the page title, the referrer, screen size, browser
language, and a country/region derived from an IP address Umami hashes and
discards. No cookies, no advertising id, nothing that identifies a person.

**The query string is stripped before anything is sent.** This matters more here
than on most sites: the shop puts a Stripe Checkout Session id in
`thank-you.html?session_id=…` (that value is effectively an order-lookup token),
a subscriber's email address can arrive at `welcome.html?email=…`, and a reaction
report's reference number lands on `safety.html?report=received&ref=…`. None of
it reaches Umami. The `#fragment` is dropped too.

What is added back is a short, fixed allow-list
(`ANALYTICS_ALLOWED_PARAMS` in `assets/js/main.js`):

| Kept                                         | Why                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| `utm_source` `utm_medium` `utm_campaign` `utm_content` `utm_term` | the UTM and Attribution reports read these off the landing URL |
| `category` `concern`                          | which shop filter someone landed on. A fixed vocabulary from the site's own nav, so it cannot carry anything a shopper typed |
| `gclid` `fbclid` `msclkid` `ttclid` `li_fat_id` `twclid` | the six ad-click ids Umami's Attribution report reads automatically |

The click ids are the one entry that is per-click random. They are here because
**Facebook and Instagram append `fbclid` to ordinary organic links** — this is
not only an ads thing, and stripping it was throwing away the attribution for the
shop's biggest referrer. They do not fragment the Pages report: Umami stores
`url_path` and `url_query` in separate columns, so `/shop.html` stays one row.
They identify a click, not a person, and nothing here ever links them to one.
`privacy.html` names them.

**Everything else is dropped**, including `?session_id=`, `?email=`, `?ref=`,
`?cart=`, `?pickup_market=` and `?subscribed=`.

### Events

Twenty-one from the browser, one from the server.

| Event                | Properties                             | Fires when                                             |
| -------------------- | -------------------------------------- | ------------------------------------------------------ |
| `Product View`       | `product` (id)                         | A product page loads                                   |
| `Variant Selected`   | `product`, `variant`                   | A size/scent is picked on a card or PDP                |
| `Add to Cart`        | `product` (name)                       | Any Add to Cart button                                 |
| `Wishlist Add`       | `product` (id)                         | A product is saved to the wishlist (adds only)         |
| `Cart Opened`        | `itemCount`                            | The shopper opens the cart drawer deliberately         |
| `Cart Shared`        | `itemCount`                            | The "share cart" button is used                        |
| `Shared Cart Opened` | `itemCount`                            | Someone arrives on a `?cart=` link. `itemCount` 0 means the link had gone stale |
| `Gift Card Applied`  | —                                      | A gift card is successfully applied to a cart          |
| `Checkout Start`     | `itemCount`, `subtotalCents`, `isPickup` | The checkout POST leaves the browser                 |
| `Checkout Failed`    | `reason`                               | The Worker or the network refused the checkout         |
| `Purchase`           | **none**                               | The funnel's last step, after `/api/order-summary` confirms the order is paid and complete |
| `Order Paid`         | `revenue`, `currency`                  | **Sent by the Stripe webhook, not the browser.** The money |
| `Site Search`        | `length`, `hasResults`                 | A shop search settles (the text is never sent)         |
| `Quiz Completed`     | `result` (product id)                  | The apothecary quiz paints a recommendation            |
| `Newsletter Signup`  | —                                      | The Kit redirect lands back with `?subscribed=1`       |
| `Restock Alert`      | `product`                              | A confirmed back-in-stock signup                       |
| `Market Alert Signup`| —                                      | A confirmed market-reminder signup                     |
| `Outbound Click`     | `destination`                          | A link to Etsy / Instagram / TikTok / Facebook / elsewhere |
| `404`                | `path`                                 | A dead link was followed                               |
| `PWA Installed`      | —                                      | The site is installed as an app                        |
| `App Updated`        | —                                      | The "new version" prompt is accepted                   |
| `Language Changed`   | `language`                             | The translator switches language                       |

`Checkout Failed`'s `reason` is one of a fixed set — `timeout`, `gift-card`,
`network`, `no-session-url`, `rejected`, `rate-limited`, `server-error`, or
`http-<status>`. It is never the server's own error text, because that text can
quote something the shopper typed.

**No event carries an email address, a name, an address, a gift message, a gift
card code, an order reference or a search query.** This is enforced in code, not
by convention: `window.ylAnalyticsBeforeSend` in `assets/js/main.js` deletes any
property whose key or value looks personal, and `scripts/analytics.test.js` fails
the build if a call site starts passing one. The server-side `Order Paid` event
is pinned the same way by `scripts/worker-analytics.test.js`, which asserts the
payload contains no address, no name and not even the Stripe session id.

### Watch the event budget

Hobby includes **100,000 events a month**, and Umami counts **each stored event
property as its own event**. A `Checkout Start` with three properties costs four,
not one.

`data-performance="true"` roughly **doubles the pageview spend**: one extra event
per page load, carrying five vitals. It is on because this shop's visitors are
mostly on phones on rural connections and a slow product page is a lost sale that
otherwise leaves no trace. **To turn it off**, drop `data-performance="true"` from
`umamiScriptHtml()` in `scripts/build-site-data.js` and run `npm run build-data`
(and update the pin in `scripts/analytics.test.js`, which asserts the attribute is
present so it cannot vanish by accident).

If the shop grows into the limit, drop properties before dropping events, and
drop performance before either.

---

## 2. Set these up in the Umami dashboard

**All by hand, once.** Umami Cloud's API is a Pro-plan feature; on Hobby there is
no way to script any of this, so it is a checklist rather than a config file.
Every report below is included on the free plan.

**Goals** (Reports → Goals). A goal matches an event name or a URL — it cannot
match a property value.

- `Add to Cart`
- `Checkout Start`
- `Order Paid` — the one that means money
- `Newsletter Signup`
- `Restock Alert` and `Market Alert Signup`
- `404` — this one is a goal you want to go _down_

**Funnel** (Reports → Funnel). Steps are URLs or event names, with a time window.
The shop's funnel:

1. Event `Product View`
2. Event `Add to Cart`
3. Event `Cart Opened`
4. Event `Checkout Start`
5. Event `Purchase`

A 30-minute window fits how people actually shop here. Use `Purchase` and not
`Order Paid` as the last step: `Order Paid` is sent by the Worker and has no
session in common with the shopper's own, so it can never complete a funnel.

Build a second, shorter funnel of `Checkout Start` → `Purchase` and watch it
against `Checkout Failed`: if the gap between them is wide and `Checkout Failed`
is flat, people are abandoning; if `Checkout Failed` tracks the gap, something is
broken.

**Revenue** (Reports → Revenue) reads the `revenue` and `currency` properties and
needs nothing configured. It is now fed entirely by `Order Paid` from the Stripe
webhook, off the amount Stripe actually captured, claimed once per Checkout
Session in D1 — so a redelivered webhook, a refreshed thank-you page and a
blocked tracker all book exactly the same thing: the truth, once.

**Retention** (Reports → Retention) groups visitors by the day they first
arrived. Most useful in the week after a market or a post. Read it with the
`fallback` tag filtered **out** — see §7 for why those sessions are not really
sessions.

**Journey** (Reports → Journey) wants three to seven steps of pages or events.
A good first one: `/index.html` → `/shop.html` → `Product View` → `Add to Cart`.

**UTM** (Reports → UTM) breaks views down by the five campaign parameters. It is
populated straight off the landing URL, so it only ever shows what you tagged —
see §3.

**Attribution** (Reports → Attribution) offers first-click and last-click, and
reads both the UTM tags and the six click ids. Since `fbclid` now survives the
scrubber, organic Instagram and Facebook traffic is attributable here without the
shop buying a single ad.

---

## 3. Link tagging (UTM)

Only these five parameters survive as campaign tags, so any other tagging scheme
will silently vanish. Lower case, hyphens, no spaces.

| Parameter      | Use                                                                                   |
| -------------- | ------------------------------------------------------------------------------------- |
| `utm_source`   | Where the link lives: `instagram`, `tiktok`, `facebook`, `etsy`, `market-qr`, `email` |
| `utm_medium`   | What kind of link: `bio`, `story`, `post`, `reel`, `dm`, `qr`, `newsletter`, `listing` |
| `utm_campaign` | What it is for: `fall-2026`, `pride-2026`, `sleep-salve-launch`, `restock`            |
| `utm_content`  | Which version, when there is more than one: `story-1`, `story-2`, `blue-flyer`        |
| `utm_term`     | Optional. The product or theme: `sleep-salve`                                          |

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

Shop filter links (`?category=apparel`, `?concern=eczema`) are now reported as
well, so a story that points at one concern shows up as such in the Pages report
without needing its own campaign tag.

---

## 4. After a deploy: the one check that matters

A local test cannot prove this. Two minutes on the live site can.

1. Open **https://yallternativeliving.com** with DevTools on the **Network** tab.
2. Add something to the cart.
3. Find the `POST` that carries the event. On an ordinary browser with no
   blocker it goes to **`https://gateway.umami.is/api/send`** — that is the
   healthy default, and it means your own IP and country reached Umami. It must
   return **200**, with **no** `Refused to connect` / `Refused to load` in the
   Console.
4. Open the Umami dashboard's **Realtime** view. Your visit should be there
   within a few seconds, along with an `Add to Cart` event.
5. **Now check the other route.** In DevTools → Network, right-click the
   `cloud.umami.is` script request → **Block request domain**, and reload. The
   POST must now go to **`/porch-light/api/send`** and return **200**, and the
   event must still land in Realtime — this time tagged `fallback`. Unblock it
   afterwards. Both routes are load-bearing; only testing the one your own
   browser happens to take is how half of this goes unnoticed.

If step 3 goes to `/porch-light/api/send` on a browser with **no** blocker,
something is stopping `cloud.umami.is` for you — often a DNS filter on your
network — and every visitor behind the same filter is on the fallback too.
If step 5 shows a 404, the proxy rule did not deploy — check `netlify.toml`.
If either step shows a CSP violation, the policy lost one of its four required
entries; see §6.
If a POST is 200 but Realtime is empty, see §6.

**Revenue needs its own check, and it needs a real order.** After the first live
purchase since this change, confirm the Revenue report shows the order's amount
exactly once. If it shows nothing, tail the Worker log
(`npx wrangler tail yallternative-checkout`) around the order and look for a line
beginning `analytics:` — `bot-filtered`, `not-configured`, `timeout` and
`http-…` are all reported explicitly.

---

## 5. Keeping your own visits out

**Your own browsing.** Open the site, open the browser console, and run:

```js
localStorage.setItem("umami.disabled", 1);
```

That browser stops being counted on this site, permanently, until you run
`localStorage.removeItem("umami.disabled")`. Do it once per browser and per
device you browse the shop from. This is the only self-exclusion Umami offers on
the Hobby plan — dashboard IP filters start at the Pro plan.

**This matters more than it used to.** A DNS-blocking router used to keep the
owner's own visits out for free. It no longer does: when the direct copy of the
tracker fails to load, the loader falls back to serving it from the shop's own
domain, which a domain blocker cannot see. Run the line above — it is honoured
by the tracker itself, on either route.

**Development, testing and previews.** Handled automatically. The tracker tag
carries `data-domains="yallternativeliving.com,www.yallternativeliving.com"`, and
Umami disables itself entirely on any other hostname. That covers `localhost`,
the `127.0.0.1` port the Puppeteer suites serve on, and Netlify deploy previews at
`*.netlify.app`. This is load-bearing rather than tidy: Umami's server-side bot
filter matches User-Agent strings, and modern headless Chrome sends an ordinary
Chrome User-Agent, so a test run would otherwise have posted hundreds of real
page views into the production dataset. `scripts/analytics.test.js` fails if the
attribute goes missing.

**Pages that are never counted:** `offline.html` (the no-network fallback) and
`/admin` (the CMS carries no tracker at all).

---

## 6. If the dashboard goes quiet

Two routes means two ways for it to go quiet, and one of them is silent.

1. **Which route is the browser taking?** Load the site with DevTools open. A
   `POST` to `gateway.umami.is` is the direct route; one to
   `/porch-light/api/send` is the fallback. Neither, and nothing loaded at all —
   check the `<script src="/assets/js/porch-light.js">` tag is on the page and
   that `data-domains` names the hostname you are actually on.

2. **CSP.** Four entries, all mandatory:
   `script-src 'self' https://cloud.umami.is` and
   `connect-src 'self' https://gateway.umami.is`. Losing the `cloud.umami.is`
   entry does **not** show up as an outage — every visitor is silently demoted
   to the fallback route and the dashboard keeps filling up with proxied
   sessions. Losing `gateway.umami.is` blocks every direct send with a console
   violation. `npm test` asserts each of the four separately.

3. **Has Umami moved its collection host again?** Umami has moved it repeatedly
   with no changelog and no migration notice — `analytics.umami.is`, then
   `api-gateway-eu.umami.dev`, then `api-gateway.umami.dev`, now
   `gateway.umami.is` (umami-software/umami discussion #2719; still
   undocumented). Re-read the host literal out of
   `https://cloud.umami.is/script.js`, then update **both**
   `UMAMI_SEND_ORIGIN`/`UMAMI_SEND_URL` in `scripts/lib/analytics-proxy.js` and
   re-run `npm run build-security-headers`. A move breaks the direct route with
   a visible CSP violation **and** the fallback route silently, on Netlify's
   side of the hop, where nothing reaches the browser console.

4. **Is `/porch-light/api/send` still a 200?** Only reachable by testing the
   fallback deliberately (§4 step 5). A 404 means the rewrite rule in
   `netlify.toml` did not survive a deploy — `npm run build-security-headers`
   regenerates it, and `scripts/analytics.test.js` asserts it exists in all
   three config files.

5. **Revenue only.** If page views are fine but the Revenue report is empty, it
   is the webhook, not the tracker: check `UMAMI_WEBSITE_ID` in
   `workers/wrangler.toml` is set and deployed, then `npx wrangler tail` for a
   line beginning `analytics:`.

---

## 7. What the fallback route costs, and how to see who took it

**This was verified from primary sources and then measured directly.** It does
not stop the fallback being worth having — without it those visitors produce no
rows at all — but it means one slice of the data is weaker than the rest, and it
is worth knowing which slice.

Umami builds a session id as `hash(websiteId, clientIP, userAgent, monthlySalt)`
and derives country/region/city from the same IP. It picks that IP from the first
header present in a fixed list (`src/lib/ip.ts` on `master`), and that list ranks
`cf-connecting-ip` **above** `x-nf-client-connection-ip` and `x-forwarded-for`.

`gateway.umami.is` sits behind Cloudflare, whose documented behaviour is to set
`CF-Connecting-IP` to "the client IP address connecting to Cloudflare" — which,
through the proxy, is **Netlify's edge, not the shopper**. Netlify does forward
the real visitor IP in `x-nf-client-connection-ip` (confirmed by a Netlify
engineer on their own forum), but Umami never looks at it: `.find()` stops at
the first header that is present. The same failure is reported upstream as
umami-software/umami issue #3579.

**And it cannot be fixed by relaying it ourselves.** Umami's collection endpoint
accepts an `ip` field in the payload with no authentication, which looked like an
escape hatch — a Worker could read the forwarded header and stamp it in. Measured
on 2026-09-02: a send carrying `payload.ip=1.1.1.1` (an Australian address) was
recorded with country **US**, i.e. the connecting request's location. Umami Cloud
geolocates the request, not the payload. So a Worker relay would restore nothing
and would additionally put every page view through the checkout Worker's request
budget. Ruled out.

**So, for visitors on the fallback route only:**

| Still trustworthy | Not trustworthy |
| --- | --- |
| Views, Pages, Referrers, Events, Goals, UTM, Attribution, **Revenue** (server-side, IP-independent) | Visitors, Visits, Bounce rate, Average visit time |
| Browser / OS / device / screen (parsed from the User-Agent, which is forwarded intact) | Countries, Regions, Cities — these read as Netlify's edge locations |
| | Retention and Journey, which are built from sessions |

**Visitors on the direct route are unaffected.** Their browser talks to Umami
itself, so their IP, their session and their country are their own — exactly as
before any of this existed.

### Telling the two populations apart

The fallback copy carries **`data-tag="fallback"`**; the direct copy carries no
tag at all. Umami records the tag on every event, so:

- **Sessions → filter → Tag `fallback`** shows the proxied population. Their
  country and visitor counts are the ones to discount.
- The same filter is available on every report, so any figure can be read with
  the proxied traffic excluded — filter Tag **is not** `fallback` — or on its own.
- The proportion of `fallback` events is also the shop's live **blocker rate**,
  which is a genuinely useful number and one Umami offers no other way to get.

There is no server-side signal to distinguish them, and Umami has no built-in
notion of "proxied traffic", so without this tag the two would be
indistinguishable. If the tag is ever removed, that visibility goes with it.

### If the trade stops being worth it

Two dials, both one commit:

- **Drop the fallback entirely** (direct only, blocked visitors uncounted):
  delete `injectFallback` and its `error` handler from
  `assets/js/porch-light.js`, remove the two proxy rules from
  `analyticsProxyRules()` in `scripts/build-security-headers.js`, and invert the
  matching assertions in `scripts/analytics.test.js` §2c and `scripts/qa-check.js`.
- **Make the proxy the default again** (all visitors proxied, all counts
  degraded): set `data-host-url` on the direct copy too. Not recommended — that
  is the arrangement this section exists to explain away.


## 8. Other known limits

- **Hobby data retention is six months.** Export anything you want to keep
  year-on-year (Data export is available on Hobby; Data import is not).
- **Prerendering.** The site prerenders links on hover via Speculation Rules, and
  the tracker has no prerender awareness of its own, so a hovered-but-never-opened
  page would count as a visit. `main.js` drops anything sent while
  `document.prerendering` is true and re-fires the page view on activation. In
  browsers that do not expose `document.prerendering`, prerendered views may still
  be counted.
- **Same-IP session collision.** Even without the proxy, two different devices
  on one Wi-Fi network with the same OS and browser hash to the same Umami
  session. This is documented upstream as an intentional trade-off.
- **The session salt rotates monthly, not daily** (`SALT_ROTATION` defaults to
  `month`), so a returning visitor inside the same calendar month folds into their
  earlier session. That is an artefact of the hashing, not a "returning visitor"
  feature.
- **Goals cannot match a property value**, only an event name or a URL. This is
  why `Checkout Failed` carries its reason as a property and is read from the
  Events list rather than as a goal per reason.

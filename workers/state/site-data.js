/**
 * @fileoverview Read-only access to the site's own JSON data from inside the
 * Worker, for the code that is NOT on the money path.
 *
 * `workers/checkout.js` has its own `loadCatalog`/`loadEvents` pair and keeps
 * it: that path validates prices and must not gain a dependency on anything
 * outside itself. This module is the same fetch-and-cache pattern for the
 * retention layer, which needs two things checkout does not:
 *
 *   - `assets/data/products.json` for a product's display name, category and
 *     `usageGuide`, so the day-2 "how to use your …" email is written from the
 *     same single source of truth the product page renders from (AGENTS.md §2).
 *   - `assets/data/content.json` for `site.loyaltyPointsPerDollar`, so the
 *     points a customer earns are the number the CMS shows them on the product
 *     card -- not a constant in a Worker nobody can edit.
 *
 * Everything degrades: a failed fetch returns an empty index or the documented
 * default rather than throwing, because a missing catalogue must not stop a
 * webhook from crediting points or recording an order.
 */

/** Used when content.json is unreachable or has no value. Matches cart.js. */
export const DEFAULT_POINTS_PER_DOLLAR = 1;

async function loadSiteJson(env, ctx, pathname) {
  const origin = (env && env.SITE_ORIGIN) || "https://yallternativeliving.com";
  const url = `${origin}${pathname}`;
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = typeof Request === "function" ? new Request(url) : url;
  let res = cache ? await cache.match(cacheKey) : null;
  if (!res) {
    res = await fetch(url, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (res && res.ok && ctx && cache) {
      const toCache = new Response(res.clone().body, res);
      toCache.headers.set("Cache-Control", "max-age=300");
      ctx.waitUntil(cache.put(cacheKey, toCache));
    }
  }
  if (!res || !res.ok) return null;
  return res.json();
}

/**
 * `{ id -> { id, name, category, usageGuide } }` for every product AND bundle.
 * Bundles are included because a bundle line item is what a shopper actually
 * bought; it just has no usage guide of its own.
 *
 * @returns {Promise<Map<string, object>>} empty when the catalogue is unreachable
 */
export async function loadProductIndex(env, ctx) {
  const index = new Map();
  let catalog = null;
  try {
    catalog = await loadSiteJson(env, ctx, "/assets/data/products.json");
  } catch (err) {
    console.warn("site-data: products.json is unreachable:", err && err.message);
    return index;
  }
  if (!catalog) return index;
  for (const list of [catalog.products, catalog.bundles]) {
    for (const entry of Array.isArray(list) ? list : []) {
      if (!entry || typeof entry.id !== "string") continue;
      index.set(entry.id, {
        id: entry.id,
        name: typeof entry.name === "string" ? entry.name : entry.id,
        category: typeof entry.category === "string" ? entry.category : "",
        usageGuide:
          entry.usageGuide && typeof entry.usageGuide === "object" ? entry.usageGuide : null
      });
    }
  }
  return index;
}

/**
 * `site` from content.json, or `{}`.
 *
 * @returns {Promise<object>}
 */
export async function loadSiteSettings(env, ctx) {
  let content = null;
  try {
    content = await loadSiteJson(env, ctx, "/assets/data/content.json");
  } catch (err) {
    console.warn("site-data: content.json is unreachable:", err && err.message);
    return {};
  }
  return (content && content.site && typeof content.site === "object" && content.site) || {};
}

/**
 * Points awarded per whole dollar spent. Reads `site.loyaltyPointsPerDollar`
 * (the CMS field at admin/config.yml, the same one the product-card badge and
 * the cart drawer read) and falls back to 1.
 *
 * A zero or negative value is treated as "not configured" rather than "award
 * nothing", matching how assets/js/cart.js reads the same field.
 */
export async function loadPointsPerDollar(env, ctx) {
  const site = await loadSiteSettings(env, ctx);
  const rate = Number(site.loyaltyPointsPerDollar);
  return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_POINTS_PER_DOLLAR;
}

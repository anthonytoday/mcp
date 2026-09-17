/**
 * Gumroad REST API v2 client.
 *
 * Base URL and auth are taken from Gumroad's own CLI (antiwork/gumroad-cli,
 * internal/api/client.go): https://api.gumroad.com/v2 with a Bearer token.
 * The CLI sends writes as application/x-www-form-urlencoded, so this does too.
 *
 * The token is a long-lived account-wide access token held as a Worker secret.
 * It does not expire, which is why there is no OAuth flow here.
 */

const BASE = 'https://api.gumroad.com/v2';

export class GumroadError extends Error {
  constructor(message, status, body, hint) {
    super(message);
    this.name = 'GumroadError';
    this.status = status;
    this.body = body;
    if (hint) this.hint = hint;
  }
}

function encodeForm(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      // Gumroad takes repeated keys with [] for arrays, matching the CLI's --tag flag.
      for (const item of v) usp.append(`${k}[]`, String(item));
    } else if (typeof v === 'boolean') {
      usp.append(k, v ? 'true' : 'false');
    } else {
      usp.append(k, String(v));
    }
  }
  return usp;
}

/**
 * One request against the Gumroad API.
 * Gumroad can return HTTP 200 with {"success": false}, so the body is checked
 * as well as the status. That behavior is called out in Gumroad's own docs.
 */
export async function call(env, method, path, params = {}) {
  const token = env.GUMROAD_ACCESS_TOKEN;
  if (!token) {
    throw new GumroadError(
      'GUMROAD_ACCESS_TOKEN is not set on this Worker.',
      500,
      null,
      'Run: npx wrangler secret put GUMROAD_ACCESS_TOKEN'
    );
  }

  const upper = method.toUpperCase();
  let url = `${BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const init = {
    method: upper,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  };

  if (upper === 'GET' || upper === 'DELETE') {
    const qs = encodeForm(params).toString();
    if (qs) url += `?${qs}`;
  } else {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = encodeForm(params).toString();
  }

  const res = await fetch(url, init);
  const text = await res.text();

  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new GumroadError(
      `Gumroad returned non-JSON (HTTP ${res.status}).`,
      res.status,
      text.slice(0, 400)
    );
  }

  if (!res.ok || body.success === false) {
    const msg = body.message || body.error || `Gumroad request failed (HTTP ${res.status}).`;
    let hint;
    if (res.status === 401) hint = 'The access token was rejected. Regenerate it at Gumroad, Settings, Advanced, Applications.';
    if (res.status === 404 && upper === 'POST' && path === '/products') {
      hint = 'Gumroad has not enabled product creation over the API for this account. Create the product in the dashboard, then use gumroad_update_product to configure it.';
    }
    if (res.status === 429) hint = 'Rate limited. Retry with backoff.';
    throw new GumroadError(msg, res.status, body, hint);
  }

  return body;
}

export const get = (env, path, params) => call(env, 'GET', path, params);
export const post = (env, path, params) => call(env, 'POST', path, params);
export const put = (env, path, params) => call(env, 'PUT', path, params);
export const del = (env, path, params) => call(env, 'DELETE', path, params);

/** Walks every page of /sales. Gumroad paginates with page_key. */
export async function allSales(env, filters = {}, maxPages = 40) {
  const out = [];
  let pageKey = null;
  for (let i = 0; i < maxPages; i++) {
    const params = { ...filters };
    if (pageKey) params.page_key = pageKey;
    const body = await get(env, '/sales', params);
    out.push(...(body.sales || []));
    pageKey = body.next_page_key;
    if (!pageKey) break;
  }
  return out;
}

/**
 * Live catalog enumeration.
 *
 * Gumroad has three blind spots that only work around each other:
 *
 *  1. GET /products is a hard cap of 10, newest first. It documents no
 *     pagination, ignores ?page=, and silently hides the rest of the shop.
 *  2. GET /user returns every permalink, which is the only authoritative
 *     product count the API offers.
 *  3. GET /products/:key resolves a product id or a *default* permalink
 *     ("afwzv") and returns "product not found" for a *custom* permalink
 *     ("CPA-Exam-Study-Plan"), which is what /user hands back for every
 *     product that has one.
 *
 * The bridge is /sales: every sale carries product_id next to the default
 * permalink, so walking sales resolves the custom-permalink products. That
 * walk is fixed at 10 rows a page (page_size and the date filters are both
 * ignored), so the permalink-to-id map and the walk cursor are cached in KV
 * and the walk only resumes while permalinks remain unaccounted for.
 */

const CATALOG_KEY = 'catalog:v1';

/** Cloudflare allows 50 subrequests per request on the free plan. Leave headroom. */
const DEFAULT_BUDGET = 42;

/** A Gumroad-assigned permalink is short and lowercase. A custom one is not. */
const DEFAULT_PERMALINK = /^[a-z0-9]{4,8}$/;

/**
 * Ids for products the API cannot surface on its own.
 *
 * A product that carries a custom permalink, sits outside the 10 newest and
 * has never sold is invisible three ways over: GET /products hides it, GET
 * /products/:custom-permalink returns "not found", and no sale exists to carry
 * its id. Seed your own here, or at runtime through gumroad_seed_product_ids,
 * which persists to KV. The entries below are the author's and are used only
 * as lookup keys; every field is still fetched fresh.
 */
const BOOTSTRAP_IDS = {
  'CFA-Exam-study-plan': 'glZzGl1z8szth8nGUWR_Dw==',
  'AQA-Chemistry-Flashcards': 'vQUYu5J6_vr8YhzZzQbI2Q==',
  'AQA-Psychology-Flashcards': 'uQ_H2Y5mJxYKmAUz5I1ibw==',
};

const EMPTY_INDEX = () => ({ byPermalink: {}, products: {}, salesCursor: null, salesDone: false, updated_at: null });

async function readIndex(env) {
  if (!env.CATALOG) return EMPTY_INDEX();
  try {
    return (await env.CATALOG.get(CATALOG_KEY, 'json')) || EMPTY_INDEX();
  } catch {
    return EMPTY_INDEX();
  }
}

async function writeIndex(env, index) {
  if (!env.CATALOG) return;
  try {
    await env.CATALOG.put(CATALOG_KEY, JSON.stringify({ ...index, updated_at: new Date().toISOString() }));
  } catch {
    // A cache write failing must never fail the read it was meant to speed up.
  }
}

/** The permalink a product answers to on GET /products/:key. */
function keysOf(product) {
  const keys = [];
  if (product.custom_permalink) keys.push(product.custom_permalink);
  const tail = (product.short_url || '').split('/l/')[1];
  if (tail) keys.push(tail);
  return keys;
}

/**
 * Every product in the shop, read live.
 *
 * Returns { products, coverage }. coverage.complete is false when the
 * subrequest budget ran out before every permalink was accounted for; calling
 * again resumes from the cached cursor and finishes the job.
 */
export async function allProducts(env, opts = {}) {
  let left = opts.budget || DEFAULT_BUDGET;
  const spend = () => { left -= 1; };

  const index = opts.refresh ? EMPTY_INDEX() : await readIndex(env);
  const byPermalink = new Map([...Object.entries(BOOTSTRAP_IDS), ...Object.entries(index.byPermalink || {})]);

  // Products already discovered on a previous call. Without this the sales
  // walk would rediscover the same catalog every time and the coverage
  // figure would go backwards whenever the budget landed differently.
  const byId = new Map(Object.entries(index.products || {}));

  // 1. The authoritative permalink list.
  spend();
  const user = (await get(env, '/user')).user || {};
  const links = Array.isArray(user.links) ? user.links : [];

  // 2. The 10 newest arrive complete, ids included.
  spend();
  for (const p of (await get(env, '/products')).products || []) {
    byId.set(p.id, p);
    for (const k of keysOf(p)) byPermalink.set(k, p.id);
  }

  const resolved = () => {
    const hit = new Set();
    for (const p of byId.values()) for (const k of keysOf(p)) hit.add(k);
    return hit;
  };
  const outstanding = () => links.filter((l) => !resolved().has(l));

  const hydrate = async (key) => {
    if (left <= 0) return false;
    spend();
    try {
      const p = (await get(env, `/products/${encodeURIComponent(key)}`)).product;
      if (!p) return false;
      byId.set(p.id, p);
      for (const k of keysOf(p)) byPermalink.set(k, p.id);
      return true;
    } catch {
      return false;
    }
  };

  // 3. Permalinks Gumroad assigned itself resolve directly.
  for (const link of outstanding()) {
    if (left <= 0) break;
    if (DEFAULT_PERMALINK.test(link)) await hydrate(link);
  }

  // 4. Custom permalinks resolve through an id the cache already holds.
  for (const link of outstanding()) {
    if (left <= 0) break;
    const id = byPermalink.get(link);
    if (id && !byId.has(id)) await hydrate(id);
  }

  // 5. Products cross-reference each other by id inside their own page
  //     content: upsell cards, "more like this" blocks and bundle entries all
  //     carry a productId. Mining the records already in hand costs nothing and
  //     reaches products that /products hides and /sales cannot surface.
  if (outstanding().length && left > 1) {
    const referenced = new Set();
    for (const p of byId.values()) {
      for (const m of JSON.stringify(p).matchAll(/"productId":"([^"]+)"/g)) referenced.add(m[1]);
      for (const b of p.bundle_products || []) if (b.product_id) referenced.add(b.product_id);
    }
    for (const id of referenced) {
      if (left <= 1 || !outstanding().length) break;
      if (!byId.has(id)) await hydrate(id);
    }
  }

  // 6. Whatever is left needs the sales walk to surface an id.
  let cursor = index.salesCursor;
  let salesDone = index.salesDone;
  while (outstanding().length && left > 2 && !salesDone) {
    spend();
    let body;
    try {
      body = await get(env, '/sales', cursor ? { page_key: cursor } : {});
    } catch {
      break;
    }
    const seen = [];
    for (const s of body.sales || []) {
      if (!s.product_id || byId.has(s.product_id)) continue;
      if (!seen.includes(s.product_id)) seen.push(s.product_id);
      if (s.product_permalink) byPermalink.set(s.product_permalink, s.product_id);
    }
    for (const id of seen) {
      if (left <= 1) break;
      await hydrate(id);
    }
    cursor = body.next_page_key || null;
    if (!cursor) { salesDone = true; break; }
  }

  await writeIndex(env, {
    byPermalink: Object.fromEntries(byPermalink),
    products: Object.fromEntries(byId),
    salesCursor: cursor,
    salesDone,
  });

  const missing = outstanding();
  return {
    products: [...byId.values()],
    coverage: {
      expected: links.length,
      resolved: links.length - missing.length,
      complete: missing.length === 0,
      unresolved: missing,
      note: missing.length
        ? 'Call again to resume. The walk picks up from the cached cursor.'
        : undefined,
    },
  };
}

/**
 * Teaches the catalog cache an id for a permalink.
 *
 * A product that carries a custom permalink, falls outside the 10 newest and
 * has no sales cannot be reached by any documented endpoint. Seeding the id
 * once is the only way through, and once seeded it persists.
 */
export async function seedProductIds(env, pairs) {
  const index = await readIndex(env);
  const byPermalink = new Map(Object.entries(index.byPermalink || {}));
  const products = { ...(index.products || {}) };
  const results = [];

  for (const { permalink, product_id } of pairs) {
    try {
      const p = (await get(env, `/products/${encodeURIComponent(product_id)}`)).product;
      if (!p) throw new Error('No product in response.');
      byPermalink.set(permalink, p.id);
      for (const k of keysOf(p)) byPermalink.set(k, p.id);
      products[p.id] = p;
      results.push({ permalink, product_id, ok: true, name: p.name });
    } catch (e) {
      results.push({ permalink, product_id, ok: false, error: e.message });
    }
  }

  await writeIndex(env, { ...index, byPermalink: Object.fromEntries(byPermalink), products });
  return { seeded: results.filter((r) => r.ok).length, results };
}

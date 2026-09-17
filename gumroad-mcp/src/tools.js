/**
 * MCP tool surface for the Gumroad shop.
 *
 * Endpoint paths and write parameters mirror Gumroad's own CLI
 * (antiwork/gumroad-cli, internal/cmd/*). Anything not wrapped here is still
 * reachable through gumroad_request, so the Worker never becomes the ceiling.
 */

import { get, post, put, del, call, allSales, allProducts, seedProductIds, GumroadError } from './gumroad.js';

/* Parameters Gumroad accepts on product writes, taken from the CLI's create.go
   and update.go. Unknown keys are rejected rather than sent, so a typo fails
   loudly here instead of silently doing nothing at Gumroad. */
const PRODUCT_WRITE_FIELDS = new Set([
  'name', 'price', 'price_currency_type', 'description', 'custom_permalink',
  'custom_summary', 'custom_receipt', 'customizable_price', 'suggested_price_cents',
  'max_purchase_count', 'category', 'taxonomy_id', 'native_type',
  'subscription_duration', 'custom_html',
]);

function pickProductFields(patch, where) {
  const out = {};
  const unknown = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (PRODUCT_WRITE_FIELDS.has(k)) out[k] = v;
    else unknown.push(k);
  }
  if (unknown.length) {
    throw new GumroadError(
      `Unsupported field(s) in ${where}: ${unknown.join(', ')}`,
      400, null,
      `Gumroad accepts: ${[...PRODUCT_WRITE_FIELDS].join(', ')}`
    );
  }
  return out;
}

/** Runs an async op over many ids without hammering the API, and never throws
    on a single failure: every id gets a row so a bulk run is auditable. */
async function overIds(ids, fn, concurrency = 4) {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const i = cursor++;
      const id = ids[i];
      try {
        const value = await fn(id);
        results[i] = { id, ok: true, ...(value || {}) };
      } catch (err) {
        results[i] = { id, ok: false, error: err.message, status: err.status };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  return {
    total: ids.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

/** Resolves a target set: explicit ids, or every product matching a filter. */
async function resolveTargets(env, args) {
  if (Array.isArray(args.product_ids) && args.product_ids.length) return args.product_ids;
  let products = (await allProducts(env)).products;
  const f = args.filter || {};
  if (f.published !== undefined) products = products.filter((p) => Boolean(p.published) === Boolean(f.published));
  if (f.name_contains) {
    const needle = String(f.name_contains).toLowerCase();
    products = products.filter((p) => (p.name || '').toLowerCase().includes(needle));
  }
  if (f.tag) products = products.filter((p) => (p.tags || []).includes(f.tag));
  if (f.max_sales !== undefined) products = products.filter((p) => (p.sales_count || 0) <= f.max_sales);
  if (f.free === true) products = products.filter((p) => !p.price);
  if (f.free === false) products = products.filter((p) => p.price > 0);
  return products.map((p) => p.id);
}

/**
 * Turns a Gumroad description into reviewable plain text.
 *
 * Descriptions are stored as HTML. Reading them as HTML wastes most of the
 * response on markup, so headings and list items are flattened to lines and
 * everything else is stripped. Links are kept as "text (url)" because a dead
 * or wrong link is exactly the kind of thing a copy review has to catch.
 */
function toReviewText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, txt) => `${txt.replace(/<[^>]+>/g, '')} (${href})`)
    .replace(/<\/(h[1-6]|p|li|div|figure|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

const TOOLS = [
  /* ---------- account ---------- */
  {
    name: 'gumroad_get_user',
    description: 'The authenticated Gumroad account. Use this first to confirm the Worker is wired to the right shop.',
    inputSchema: { type: 'object', properties: {} },
    handler: (env) => get(env, '/user'),
  },

  /* ---------- products, read ---------- */
  {
    name: 'gumroad_list_products',
    description: 'Every product in the shop, with price, published state, sales_count, sales_usd_cents, tags and URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'boolean', description: 'Return a compact row per product instead of the full record. Default true.' },
        limit: { type: 'integer', description: 'Only with summary false. Full records are large, so this caps at 10 and defaults to 5.' },
        refresh: { type: 'boolean', description: 'Discard the cached permalink map and rediscover the catalog from scratch.' },
        view: { type: 'string', description: 'Set to "copy" for a proofreading view: name, summary, tags and the description as plain text, with links kept as text (url). Pages with limit and offset.' },
        offset: { type: 'integer', description: 'Only with view copy. Skip this many products.' },
      },
    },
    handler: async (env, args) => {
      const { products, coverage } = await allProducts(env, { refresh: args.refresh === true });

      // Copy review: names, summaries, tags and the description as plain text.
      if (args.view === 'copy') {
        const offset = Math.max(0, args.offset || 0);
        const limit = Math.min(args.limit || 12, 20);
        const page = products.slice(offset, offset + limit);
        return {
          coverage,
          count: products.length,
          offset,
          returned: page.length,
          products: page.map((p) => ({
            id: p.id,
            name: p.name,
            permalink: p.custom_permalink || (p.short_url || '').split('/l/')[1] || null,
            price: p.formatted_price,
            published: p.published,
            sales_count: p.sales_count,
            tags: p.tags,
            custom_summary: p.custom_summary,
            description: toReviewText(p.description),
          })),
        };
      }

      if (args.summary === false) {
        // Full records run to roughly 10 KB each and overflow a tool response
        // well before the catalog ends, so this is capped deliberately.
        const limit = Math.min(args.limit || 5, 10);
        return { coverage, count: products.length, returned: limit, products: products.slice(0, limit) };
      }
      return {
        coverage,
        count: products.length,
        products: products.map((p) => ({
          id: p.id, name: p.name, price: p.price, currency: p.currency,
          published: p.published, sales_count: p.sales_count,
          sales_usd_cents: p.sales_usd_cents, tags: p.tags,
          url: p.short_url, permalink: p.custom_permalink || (p.short_url || '').split('/l/')[1] || null,
        })),
      };
    },
  },
  {
    name: 'gumroad_seed_product_ids',
    description: 'Teach the catalog cache the id behind a permalink. Needed only for a product that has a custom permalink, is outside the 10 newest and has no sales, which is the one combination the Gumroad API cannot resolve on its own. The id is the string in the dashboard URL at app.gumroad.com/products/<id>/edit.',
    inputSchema: {
      type: 'object',
      properties: {
        pairs: {
          type: 'array',
          description: 'One entry per product.',
          items: {
            type: 'object',
            properties: {
              permalink: { type: 'string', description: 'The permalink as /user reports it, for example My-Custom-Permalink.' },
              product_id: { type: 'string', description: 'The product id from the dashboard URL.' },
            },
            required: ['permalink', 'product_id'],
          },
        },
      },
      required: ['pairs'],
    },
    handler: (env, a) => seedProductIds(env, a.pairs || []),
  },
  {
    name: 'gumroad_get_product',
    description: 'One product in full, by id or permalink.',
    inputSchema: {
      type: 'object',
      properties: { product_id: { type: 'string' } },
      required: ['product_id'],
    },
    handler: (env, a) => get(env, `/products/${encodeURIComponent(a.product_id)}`),
  },

  /* ---------- products, write ---------- */
  {
    name: 'gumroad_create_product',
    description:
      'Create a product. Gumroad may reject this with 404 if creation over the API is not enabled for the account, in which case the error says so and you create it in the dashboard instead.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        price: { type: 'integer', description: 'In cents. 0 for free or pay-what-you-want.' },
        price_currency_type: { type: 'string', description: 'ISO code, for example usd or chf.' },
        description: { type: 'string' },
        native_type: { type: 'string', description: 'ebook, course, membership, digital, and so on.' },
        custom_permalink: { type: 'string' },
        custom_summary: { type: 'string' },
        customizable_price: { type: 'boolean', description: 'Pay what you want.' },
        suggested_price_cents: { type: 'integer' },
        taxonomy_id: { type: 'integer' },
        category: { type: 'string' },
        max_purchase_count: { type: 'integer' },
        subscription_duration: { type: 'string' },
      },
      required: ['name'],
    },
    handler: async (env, a) => post(env, '/products', pickProductFields(a, 'gumroad_create_product')),
  },
  {
    name: 'gumroad_update_product',
    description: 'Update one product. Only the fields you pass are changed.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string' },
        patch: { type: 'object', description: 'Any of the create fields, plus custom_html.' },
      },
      required: ['product_id', 'patch'],
    },
    handler: async (env, a) =>
      put(env, `/products/${encodeURIComponent(a.product_id)}`, pickProductFields(a.patch, 'patch')),
  },
  {
    name: 'gumroad_publish_product',
    description: 'Publish (enable) a product so it is for sale.',
    inputSchema: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'] },
    handler: (env, a) => put(env, `/products/${encodeURIComponent(a.product_id)}/enable`),
  },
  {
    name: 'gumroad_unpublish_product',
    description: 'Unpublish (disable) a product. It stays in the account.',
    inputSchema: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'] },
    handler: (env, a) => put(env, `/products/${encodeURIComponent(a.product_id)}/disable`),
  },
  {
    name: 'gumroad_delete_product',
    description: 'Permanently delete a product. Requires confirm true, because this cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: { product_id: { type: 'string' }, confirm: { type: 'boolean' } },
      required: ['product_id', 'confirm'],
    },
    handler: async (env, a) => {
      if (a.confirm !== true) throw new GumroadError('Deletion needs confirm: true.', 400);
      return del(env, `/products/${encodeURIComponent(a.product_id)}`);
    },
  },

  /* ---------- bulk ---------- */
  {
    name: 'gumroad_bulk_update_products',
    description:
      'Apply the same patch to many products at once. Target either explicit product_ids or a filter over the whole catalog. Returns one row per product so partial failures are visible.',
    inputSchema: {
      type: 'object',
      properties: {
        product_ids: { type: 'array', items: { type: 'string' } },
        filter: {
          type: 'object',
          description: 'published, name_contains, tag, max_sales, free',
          properties: {
            published: { type: 'boolean' }, name_contains: { type: 'string' },
            tag: { type: 'string' }, max_sales: { type: 'integer' }, free: { type: 'boolean' },
          },
        },
        patch: { type: 'object' },
        dry_run: { type: 'boolean', description: 'List what would change without calling Gumroad. Default true.' },
      },
      required: ['patch'],
    },
    handler: async (env, a) => {
      const fields = pickProductFields(a.patch, 'patch');
      const ids = await resolveTargets(env, a);
      if (a.dry_run !== false) {
        return { dry_run: true, would_update: ids.length, product_ids: ids, patch: fields };
      }
      return overIds(ids, (id) => put(env, `/products/${encodeURIComponent(id)}`, fields));
    },
  },
  {
    name: 'gumroad_bulk_set_published',
    description: 'Publish or unpublish many products at once, by ids or by filter.',
    inputSchema: {
      type: 'object',
      properties: {
        product_ids: { type: 'array', items: { type: 'string' } },
        filter: { type: 'object' },
        published: { type: 'boolean' },
        dry_run: { type: 'boolean' },
      },
      required: ['published'],
    },
    handler: async (env, a) => {
      const ids = await resolveTargets(env, a);
      const action = a.published ? 'enable' : 'disable';
      if (a.dry_run !== false) return { dry_run: true, would_change: ids.length, product_ids: ids, action };
      return overIds(ids, (id) => put(env, `/products/${encodeURIComponent(id)}/${action}`));
    },
  },

  /* ---------- sales ---------- */
  {
    name: 'gumroad_list_sales',
    description: 'Sales, following pagination automatically. Filter by after, before, email, product_id, order_id.',
    inputSchema: {
      type: 'object',
      properties: {
        after: { type: 'string', description: 'YYYY-MM-DD' },
        before: { type: 'string', description: 'YYYY-MM-DD' },
        email: { type: 'string' }, product_id: { type: 'string' }, order_id: { type: 'string' },
        summary_only: { type: 'boolean', description: 'Return totals and per-product revenue instead of every row.' },
      },
    },
    handler: async (env, a) => {
      const { summary_only, ...filters } = a;
      const sales = await allSales(env, filters);
      if (!summary_only) return { count: sales.length, sales };
      const paid = sales.filter((s) => s.paid && !s.chargedback);
      const byProduct = {};
      for (const s of paid) {
        const k = s.product_name || 'unknown';
        byProduct[k] = (byProduct[k] || 0) + (s.price || 0);
      }
      return {
        records: sales.length,
        paid: paid.length,
        gross_cents: paid.reduce((t, s) => t + (s.price || 0), 0),
        fees_cents: paid.reduce((t, s) => t + (s.gumroad_fee || 0), 0),
        refunded: sales.filter((s) => s.partially_refunded).length,
        disputed: sales.filter((s) => s.disputed).length,
        revenue_by_product_cents: Object.fromEntries(
          Object.entries(byProduct).sort((x, y) => y[1] - x[1])
        ),
      };
    },
  },
  {
    name: 'gumroad_get_sale',
    description: 'One sale in full by id, including buyer email, fees, country, referrer and refund state.',
    inputSchema: { type: 'object', properties: { sale_id: { type: 'string' } }, required: ['sale_id'] },
    handler: (env, a) => get(env, `/sales/${encodeURIComponent(a.sale_id)}`),
  },
  {
    name: 'gumroad_refund_sale',
    description: 'Refund a sale in full or in part. Requires confirm true, because this moves money.',
    inputSchema: {
      type: 'object',
      properties: {
        sale_id: { type: 'string' },
        amount_cents: { type: 'integer', description: 'Omit for a full refund.' },
        confirm: { type: 'boolean' },
      },
      required: ['sale_id', 'confirm'],
    },
    handler: async (env, a) => {
      if (a.confirm !== true) throw new GumroadError('Refunds need confirm: true.', 400);
      const params = {};
      if (a.amount_cents !== undefined) params.amount_cents = a.amount_cents;
      return put(env, `/sales/${encodeURIComponent(a.sale_id)}/refund`, params);
    },
  },

  /* ---------- offer codes, subscribers, payouts, webhooks ---------- */
  {
    name: 'gumroad_list_offer_codes',
    description: 'Discount codes on a product.',
    inputSchema: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'] },
    handler: (env, a) => get(env, `/products/${encodeURIComponent(a.product_id)}/offer_codes`),
  },
  {
    name: 'gumroad_create_offer_code',
    description: 'Create a discount code on a product. amount_off is cents, or a percentage when offer_type is percent.',
    inputSchema: {
      type: 'object',
      properties: {
        product_id: { type: 'string' }, name: { type: 'string' },
        amount_off: { type: 'integer' }, offer_type: { type: 'string', enum: ['cents', 'percent'] },
        max_purchase_count: { type: 'integer' }, universal: { type: 'boolean' },
      },
      required: ['product_id', 'name', 'amount_off'],
    },
    handler: (env, a) => {
      const { product_id, ...rest } = a;
      return post(env, `/products/${encodeURIComponent(product_id)}/offer_codes`, rest);
    },
  },
  {
    name: 'gumroad_list_subscribers',
    description: 'Subscribers for a membership product.',
    inputSchema: { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'] },
    handler: (env, a) => get(env, `/products/${encodeURIComponent(a.product_id)}/subscribers`),
  },
  {
    name: 'gumroad_list_payouts',
    description: 'Payout history, or the upcoming payout when upcoming is true.',
    inputSchema: { type: 'object', properties: { upcoming: { type: 'boolean' } } },
    handler: (env, a) => get(env, a.upcoming ? '/payouts/upcoming' : '/payouts'),
  },
  {
    name: 'gumroad_list_webhooks',
    description: 'Resource subscriptions, which is what Gumroad calls webhooks.',
    inputSchema: { type: 'object', properties: { resource_name: { type: 'string' } } },
    handler: (env, a) => get(env, '/resource_subscriptions', a.resource_name ? { resource_name: a.resource_name } : {}),
  },

  /* ---------- escape hatch ---------- */
  {
    name: 'gumroad_request',
    description:
      'Any Gumroad v2 endpoint not wrapped above. Give method, path and params. Writes require confirm true.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
        path: { type: 'string', description: 'For example /products or /sales/123' },
        params: { type: 'object' },
        confirm: { type: 'boolean' },
      },
      required: ['method', 'path'],
    },
    handler: async (env, a) => {
      const m = a.method.toUpperCase();
      if (m !== 'GET' && a.confirm !== true) {
        throw new GumroadError(`${m} through gumroad_request needs confirm: true.`, 400);
      }
      return call(env, m, a.path, a.params || {});
    },
  },
];

export const TOOL_SPECS = TOOLS.map(({ name, description, inputSchema }) => ({
  name, description, inputSchema,
}));

export function findTool(name) {
  return TOOLS.find((t) => t.name === name);
}

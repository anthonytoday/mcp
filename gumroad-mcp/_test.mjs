/**
 * Offline tests. No network: global fetch is stubbed and every request the
 * Worker would make is asserted against Gumroad's documented shape.
 */
import assert from 'node:assert/strict';
import { handleMcpRequest } from './src/mcp.js';
import { TOOL_SPECS, findTool } from './src/tools.js';

let pass = 0, fail = 0;
const calls = [];
async function t(name, fn) {
  try { await fn(); pass++; }
  catch (e) { fail++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

/** Stub fetch, recording every outbound request. */
function stub(responder) {
  globalThis.fetch = async (url, init = {}) => {
    const entry = {
      url: String(url),
      method: (init.method || 'GET').toUpperCase(),
      body: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null,
      auth: (init.headers || {}).Authorization,
    };
    calls.push(entry);
    const r = responder(entry) || { success: true };
    return { ok: r.__status ? r.__status < 400 : true, status: r.__status || 200, text: async () => JSON.stringify(r) };
  };
}
const ENV = { GUMROAD_ACCESS_TOKEN: 'tok_test', MCP_AUTH_TOKEN: 'mcp_test' };
const rpc = (method, params, id = 1) =>
  handleMcpRequest(new Request('https://x/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  }), ENV).then((r) => r.json());

/* ---- protocol ---- */
await t('initialize negotiates a protocol version', async () => {
  const r = await rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.equal(r.result.serverInfo.name, 'gumroad-shop');
});
await t('tools/list returns every tool with a schema', async () => {
  const r = await rpc('tools/list');
  assert.equal(r.result.tools.length, TOOL_SPECS.length);
  for (const spec of r.result.tools) {
    assert.ok(spec.name.startsWith('gumroad_'), spec.name);
    assert.ok(spec.description && spec.description.length > 20, spec.name);
    assert.equal(spec.inputSchema.type, 'object', spec.name);
  }
});
await t('unknown tool is a JSON-RPC error', async () => {
  const r = await rpc('tools/call', { name: 'nope', arguments: {} });
  assert.equal(r.error.code, -32601);
});
await t('every tool name is unique', () => {
  const names = TOOL_SPECS.map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
});

/* ---- auth and transport ---- */
await t('non-POST is rejected', async () => {
  const r = await handleMcpRequest(new Request('https://x/mcp', { method: 'GET' }), ENV);
  assert.equal(r.status, 405);
});
await t('bad JSON is a parse error', async () => {
  const r = await handleMcpRequest(new Request('https://x/mcp', { method: 'POST', body: '{oops' }), ENV);
  assert.equal((await r.json()).error.code, -32700);
});
await t('bearer token is sent to Gumroad', async () => {
  calls.length = 0; stub(() => ({ success: true, user: {} }));
  await findTool('gumroad_get_user').handler(ENV, {});
  assert.equal(calls[0].auth, 'Bearer tok_test');
});
await t('a missing Gumroad token fails loudly', async () => {
  await assert.rejects(() => findTool('gumroad_get_user').handler({}, {}), /GUMROAD_ACCESS_TOKEN is not set/);
});

/* ---- endpoint shapes, checked against the Gumroad CLI ---- */
await t('listing starts at /user, then reads /products', async () => {
  calls.length = 0;
  stub((c) => new URL(c.url).pathname.endsWith('/user')
    ? { success: true, user: { links: ['aaaaa'] } }
    : { success: true, products: [{ id: 'p1', name: 'A', published: true, sales_count: 3, short_url: 'https://x.gumroad.com/l/aaaaa' }] });
  const out = await findTool('gumroad_list_products').handler(ENV, {});
  assert.equal(calls[0].url, 'https://api.gumroad.com/v2/user');
  assert.equal(calls[1].url, 'https://api.gumroad.com/v2/products');
  assert.equal(calls[0].method, 'GET');
  assert.equal(out.count, 1);
  assert.equal(out.products[0].id, 'p1');
  assert.equal(out.coverage.complete, true);
});
await t('create posts form-encoded fields to /v2/products', async () => {
  calls.length = 0; stub(() => ({ success: true, product: { id: 'new' } }));
  await findTool('gumroad_create_product').handler(ENV, { name: 'Art Pack', price: 1000, price_currency_type: 'usd' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://api.gumroad.com/v2/products');
  assert.deepEqual(calls[0].body, { name: 'Art Pack', price: '1000', price_currency_type: 'usd' });
});
await t('update PUTs only the fields given', async () => {
  calls.length = 0; stub(() => ({ success: true }));
  await findTool('gumroad_update_product').handler(ENV, { product_id: 'p1', patch: { name: 'B' } });
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].url, 'https://api.gumroad.com/v2/products/p1');
  assert.deepEqual(calls[0].body, { name: 'B' });
});
await t('publish and unpublish hit enable and disable', async () => {
  calls.length = 0; stub(() => ({ success: true }));
  await findTool('gumroad_publish_product').handler(ENV, { product_id: 'p1' });
  await findTool('gumroad_unpublish_product').handler(ENV, { product_id: 'p1' });
  assert.ok(calls[0].url.endsWith('/products/p1/enable'));
  assert.ok(calls[1].url.endsWith('/products/p1/disable'));
});
await t('an unknown patch field is refused before any request', async () => {
  calls.length = 0; stub(() => ({ success: true }));
  await assert.rejects(
    () => findTool('gumroad_update_product').handler(ENV, { product_id: 'p1', patch: { colour: 'red' } }),
    /Unsupported field\(s\)/);
  assert.equal(calls.length, 0);
});

/* ---- destructive actions are gated ---- */
await t('delete without confirm makes no request', async () => {
  calls.length = 0; stub(() => ({ success: true }));
  await assert.rejects(() => findTool('gumroad_delete_product').handler(ENV, { product_id: 'p1', confirm: false }), /confirm/);
  assert.equal(calls.length, 0);
});
await t('refund without confirm makes no request', async () => {
  calls.length = 0; stub(() => ({ success: true }));
  await assert.rejects(() => findTool('gumroad_refund_sale').handler(ENV, { sale_id: 's1', confirm: false }), /confirm/);
  assert.equal(calls.length, 0);
});
await t('gumroad_request blocks writes without confirm', async () => {
  calls.length = 0; stub(() => ({ success: true }));
  await assert.rejects(() => findTool('gumroad_request').handler(ENV, { method: 'DELETE', path: '/products/p1' }), /confirm/);
  assert.equal(calls.length, 0);
});

/* ---- bulk ---- */
await t('bulk update defaults to a dry run and touches nothing', async () => {
  calls.length = 0;
  stub((c) => new URL(c.url).pathname.endsWith('/user')
    ? { success: true, user: { links: ['aaaaa', 'bbbbb'] } }
    : { success: true, products: [
        { id: 'a', name: 'Free thing', price: 0, published: true, sales_count: 0, short_url: 'https://x.gumroad.com/l/aaaaa' },
        { id: 'b', name: 'Paid thing', price: 900, published: true, sales_count: 12, short_url: 'https://x.gumroad.com/l/bbbbb' }] });
  const out = await findTool('gumroad_bulk_update_products').handler(ENV, { filter: { free: true }, patch: { name: 'x' } });
  assert.equal(out.dry_run, true);
  assert.deepEqual(out.product_ids, ['a']);
  assert.ok(calls.every((c) => c.method === 'GET'), 'a dry run must not write');
});
await t('bulk update with dry_run false writes to each target', async () => {
  calls.length = 0;
  stub((c) => c.method === 'GET'
    ? { success: true, products: [{ id: 'a', published: false }, { id: 'b', published: false }] }
    : { success: true });
  const out = await findTool('gumroad_bulk_set_published').handler(ENV, { filter: { published: false }, published: true, dry_run: false });
  assert.equal(out.total, 2);
  assert.equal(out.succeeded, 2);
  assert.ok(calls.some((c) => c.url.endsWith('/products/a/enable')));
  assert.ok(calls.some((c) => c.url.endsWith('/products/b/enable')));
});
await t('one failure in a bulk run does not sink the others', async () => {
  calls.length = 0;
  stub((c) => {
    if (c.method === 'GET') return { success: true, products: [{ id: 'a' }, { id: 'b' }] };
    if (c.url.includes('/products/a')) return { __status: 422, success: false, message: 'nope' };
    return { success: true };
  });
  const out = await findTool('gumroad_bulk_update_products').handler(ENV, { patch: { name: 'x' }, dry_run: false });
  assert.equal(out.succeeded, 1);
  assert.equal(out.failed, 1);
  assert.equal(out.results.find((r) => r.id === 'a').error, 'nope');
});

/* ---- error handling ---- */
await t('HTTP 200 with success false is still an error', async () => {
  stub(() => ({ success: false, message: 'The product was not found.' }));
  await assert.rejects(() => findTool('gumroad_get_product').handler(ENV, { product_id: 'x' }), /not found/);
});
await t('a 404 on create explains the dashboard fallback', async () => {
  stub(() => ({ __status: 404, success: false, message: 'Not Found' }));
  await assert.rejects(
    () => findTool('gumroad_create_product').handler(ENV, { name: 'x' }),
    (e) => /dashboard/.test(e.hint || ''));
});
await t('a 401 explains how to regenerate the token', async () => {
  stub(() => ({ __status: 401, success: false, message: 'Unauthorized' }));
  await assert.rejects(() => findTool('gumroad_get_user').handler(ENV, {}),
    (e) => /Regenerate it at Gumroad/.test(e.hint || ''));
});

/* ---- sales ---- */
await t('sales paginate with page_key until exhausted', async () => {
  calls.length = 0; let n = 0;
  stub(() => (++n === 1
    ? { success: true, sales: [{ price: 1000, gumroad_fee: 100, paid: true, product_name: 'A' }], next_page_key: 'k2' }
    : { success: true, sales: [{ price: 500, gumroad_fee: 50, paid: true, product_name: 'B' }] }));
  const out = await findTool('gumroad_list_sales').handler(ENV, { summary_only: true });
  assert.equal(out.records, 2);
  assert.equal(out.gross_cents, 1500);
  assert.equal(out.fees_cents, 150);
  assert.ok(calls[1].url.includes('page_key=k2'));
});

/* ---- auth on the /mcp route, both accepted forms ---- */
import worker from './src/index.js';
await t('/mcp rejects a request with no credential', async () => {
  const r = await worker.fetch(new Request('https://x/mcp', { method: 'POST', body: '{}' }), ENV);
  assert.equal(r.status, 401);
});
await t('/mcp accepts the bearer header', async () => {
  const r = await worker.fetch(new Request('https://x/mcp', {
    method: 'POST', headers: { Authorization: 'Bearer mcp_test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }), ENV);
  assert.equal((await r.json()).result.tools.length, TOOL_SPECS.length);
});
await t('/mcp accepts the same token as ?key=', async () => {
  const r = await worker.fetch(new Request('https://x/mcp?key=mcp_test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }), ENV);
  assert.equal((await r.json()).result.tools.length, TOOL_SPECS.length);
});
await t('/mcp rejects a wrong ?key=', async () => {
  const r = await worker.fetch(new Request('https://x/mcp?key=nope', { method: 'POST', body: '{}' }), ENV);
  assert.equal(r.status, 401);
});
await t('an unset MCP_AUTH_TOKEN fails closed', async () => {
  const r = await worker.fetch(new Request('https://x/mcp?key=', { method: 'POST', body: '{}' }), {});
  assert.equal(r.status, 401);
});

/* ---- catalog enumeration ---- */

/**
 * Routes the stub by path so a test can describe the three endpoints the
 * enumeration actually leans on: /user for the authoritative permalink list,
 * /products for the 10 newest, /sales for everything /products hides.
 */
function shop({ links = [], products = [], byKey = {}, sales = [] }) {
  stub((c) => {
    const path = new URL(c.url).pathname.replace('/v2', '');
    if (path === '/user') return { success: true, user: { links } };
    if (path === '/products') return { success: true, products };
    if (path === '/sales') return { success: true, sales, next_page_key: null };
    if (path.startsWith('/products/')) {
      const key = decodeURIComponent(path.slice('/products/'.length));
      return byKey[key] ? { success: true, product: byKey[key] } : { __status: 404, success: false, message: 'The product was not found.' };
    }
    return { success: true };
  });
}
const prod = (id, permalink, extra = {}) => ({
  id, name: id, price: 0, published: true,
  short_url: `https://example.gumroad.com/l/${permalink}`,
  ...extra,
});

await t('the catalog comes from /user, not the 10-item /products cap', async () => {
  calls.length = 0;
  shop({
    links: ['aaaaa', 'bbbbb', 'my-custom-one'],
    products: [prod('p3', 'my-custom-one', { custom_permalink: 'my-custom-one' })],
    byKey: { aaaaa: prod('p1', 'aaaaa'), bbbbb: prod('p2', 'bbbbb') },
  });
  const out = await findTool('gumroad_list_products').handler(ENV, {});
  assert.equal(out.count, 3);
  assert.equal(out.coverage.expected, 3);
  assert.equal(out.coverage.complete, true);
});

await t('a custom permalink is never fetched directly, because Gumroad 404s it', async () => {
  calls.length = 0;
  shop({
    links: ['My-Custom-Permalink'],
    products: [],
    sales: [{ product_id: 'pX', product_permalink: 'zzzzz' }],
    byKey: { pX: prod('pX', 'zzzzz', { custom_permalink: 'My-Custom-Permalink' }) },
  });
  const out = await findTool('gumroad_list_products').handler(ENV, {});
  assert.equal(out.coverage.complete, true);
  assert.equal(out.count, 1);
  assert.ok(!calls.some((c) => c.url.includes('My-Custom-Permalink')), 'must not GET a custom permalink');
});

await t('the sales walk resolves what /products hides', async () => {
  calls.length = 0;
  shop({
    links: ['aaaaa', 'hidden-one'],
    products: [prod('p1', 'aaaaa')],
    sales: [{ product_id: 'p9', product_permalink: 'qqqqq' }],
    byKey: {
      aaaaa: prod('p1', 'aaaaa'),
      p9: prod('p9', 'qqqqq', { custom_permalink: 'hidden-one' }),
    },
  });
  const out = await findTool('gumroad_list_products').handler(ENV, {});
  assert.equal(out.count, 2);
  assert.equal(out.coverage.complete, true);
  assert.ok(calls.some((c) => c.url.includes('/sales')), 'sales must be walked');
});

await t('coverage reports honestly when a permalink cannot be resolved', async () => {
  calls.length = 0;
  shop({ links: ['aaaaa', 'ghost-product'], products: [], byKey: { aaaaa: prod('p1', 'aaaaa') }, sales: [] });
  const out = await findTool('gumroad_list_products').handler(ENV, {});
  assert.equal(out.coverage.complete, false);
  assert.deepEqual(out.coverage.unresolved, ['ghost-product']);
});

await t('the subrequest budget is respected rather than blown', async () => {
  calls.length = 0;
  const links = Array.from({ length: 60 }, (_, i) => `k${String(i).padStart(4, '0')}`);
  const byKey = Object.fromEntries(links.map((k, i) => [k, prod(`id${i}`, k)]));
  shop({ links, products: [], byKey, sales: [] });
  const out = await findTool('gumroad_list_products').handler(ENV, {});
  assert.ok(calls.length <= 42, `spent ${calls.length} subrequests`);
  assert.equal(out.coverage.complete, false);
  assert.ok(out.coverage.note.includes('Call again'));
});

await t('full records are capped so a response cannot overflow', async () => {
  const links = Array.from({ length: 10 }, (_, i) => `cap${i}0`);
  const byKey = Object.fromEntries(links.map((k, i) => [k, prod(`f${i}`, k, { description: 'x'.repeat(500) })]));
  shop({ links, products: [], byKey, sales: [] });
  const out = await findTool('gumroad_list_products').handler(ENV, { summary: false });
  assert.equal(out.returned, 5);
  assert.equal(out.products.length, 5);
  assert.equal(out.count, 10);
});

await t('bulk targeting sees the whole catalog, not one page', async () => {
  calls.length = 0;
  shop({
    links: ['aaaaa', 'bbbbb', 'ccccc'],
    products: [prod('p1', 'aaaaa')],
    byKey: { aaaaa: prod('p1','aaaaa'), bbbbb: prod('p2','bbbbb'), ccccc: prod('p3','ccccc') },
  });
  const out = await findTool('gumroad_bulk_update_products').handler(ENV, { filter:{ free:true }, patch:{ name:'x' } });
  assert.equal(out.would_update, 3);
});

await t('progress accumulates instead of going backwards', async () => {
  const store = new Map();
  const KV = {
    get: async (k) => { const v = store.get(k); return v ? JSON.parse(v) : null; },
    put: async (k, v) => { store.set(k, v); },
  };
  const envKv = { ...ENV, CATALOG: KV };

  shop({
    links: ['aaaaa', 'hidden-one'],
    products: [],
    sales: [{ product_id: 'p9', product_permalink: 'qqqqq' }],
    byKey: { aaaaa: prod('p1', 'aaaaa'), p9: prod('p9', 'qqqqq', { custom_permalink: 'hidden-one' }) },
  });
  const first = await findTool('gumroad_list_products').handler(envKv, {});
  assert.equal(first.coverage.complete, true);

  // Second call must not lose what the first one learned.
  const second = await findTool('gumroad_list_products').handler(envKv, {});
  assert.ok(second.coverage.resolved >= first.coverage.resolved, 'coverage regressed');
  assert.equal(second.count, first.count);
});

await t('seeding an id rescues a product the API cannot reach', async () => {
  const store = new Map();
  const KV = { get: async (k) => { const v = store.get(k); return v ? JSON.parse(v) : null; }, put: async (k, v) => { store.set(k, v); } };
  const envKv = { ...ENV, CATALOG: KV };

  shop({
    links: ['ghost-permalink'],
    products: [],
    sales: [],
    byKey: { GHOSTID: prod('GHOSTID', 'zzzzz', { custom_permalink: 'ghost-permalink' }) },
  });

  const before = await findTool('gumroad_list_products').handler(envKv, {});
  assert.equal(before.coverage.complete, false);

  const seeded = await findTool('gumroad_seed_product_ids').handler(envKv, {
    pairs: [{ permalink: 'ghost-permalink', product_id: 'GHOSTID' }],
  });
  assert.equal(seeded.seeded, 1);

  const after = await findTool('gumroad_list_products').handler(envKv, {});
  assert.equal(after.coverage.complete, true);
  assert.equal(after.count, 1);
});

await t('a bad seed reports the failure rather than poisoning the cache', async () => {
  const store = new Map();
  const KV = { get: async (k) => { const v = store.get(k); return v ? JSON.parse(v) : null; }, put: async (k, v) => { store.set(k, v); } };
  shop({ links: [], products: [], sales: [], byKey: {} });
  const out = await findTool('gumroad_seed_product_ids').handler({ ...ENV, CATALOG: KV }, {
    pairs: [{ permalink: 'nope', product_id: 'WRONG' }],
  });
  assert.equal(out.seeded, 0);
  assert.equal(out.results[0].ok, false);
});

await t('an id referenced inside another product is mined, not missed', async () => {
  calls.length = 0;
  const host = prod('p1', 'aaaaa');
  host.rich_content = [{ description: { content: [{ type: 'upsellCard', attrs: { productId: 'HIDDEN' } }] } }];
  shop({
    links: ['aaaaa', 'no-sales-custom'],
    products: [],
    sales: [],
    byKey: { aaaaa: host, HIDDEN: prod('HIDDEN', 'wwwww', { custom_permalink: 'no-sales-custom' }) },
  });
  const out = await findTool('gumroad_list_products').handler(ENV, {});
  assert.equal(out.coverage.complete, true, JSON.stringify(out.coverage));
  assert.equal(out.count, 2);
});

await t('every bootstrapped id resolves to the permalink it claims', async () => {
  calls.length = 0;
  const { allProducts, BOOTSTRAP_IDS } = await import('./src/gumroad.js');
  const links = Object.keys(BOOTSTRAP_IDS);
  const byKey = Object.fromEntries(links.map((l, i) => [BOOTSTRAP_IDS[l], prod(BOOTSTRAP_IDS[l], 'zzzz' + i, { custom_permalink: l })]));
  shop({ links, products: [], sales: [], byKey });
  const out = await allProducts(ENV, {});
  assert.equal(out.coverage.complete, true, JSON.stringify(out.coverage));
  // Reached by id, never by the custom permalink, which Gumroad 404s.
  for (const l of links) assert.ok(!calls.some((c) => c.url.includes(l)), l);
});

await t('the copy view flattens HTML and keeps link targets', async () => {
  const html = '<h2>Pass the exam</h2><p>Study <strong>smarter</strong>.</p><ul><li>Item one</li><li>See <a href="https://notion.com" target="_blank">Notion</a></li></ul>';
  shop({ links: ['aaaaa'], products: [], sales: [], byKey: { aaaaa: prod('p1', 'aaaaa', { description: html, custom_summary: 'Exam plan', formatted_price: 'CHF 0+' }) } });
  const out = await findTool('gumroad_list_products').handler(ENV, { view: 'copy' });
  const d = out.products[0].description;
  assert.ok(!d.includes('<'), 'markup survived');
  assert.ok(d.includes('Pass the exam'));
  assert.ok(d.includes('- Item one'));
  assert.ok(d.includes('Notion (https://notion.com)'), d);
  assert.equal(out.products[0].custom_summary, 'Exam plan');
  assert.equal(out.products[0].price, 'CHF 0+');
});

await t('the copy view pages so a big catalog cannot overflow', async () => {
  const links = Array.from({ length: 8 }, (_, i) => `cop${i}0`);
  const byKey = Object.fromEntries(links.map((k, i) => [k, prod(`c${i}`, k, { description: '<p>x</p>' })]));
  shop({ links, products: [], sales: [], byKey });
  const first = await findTool('gumroad_list_products').handler(ENV, { view: 'copy', limit: 3 });
  assert.equal(first.returned, 3);
  assert.equal(first.count, 8);
  const second = await findTool('gumroad_list_products').handler(ENV, { view: 'copy', limit: 3, offset: 6 });
  assert.equal(second.returned, 2);
  assert.equal(second.offset, 6);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

# gumroad-mcp

The Gumroad shop exposed to Claude (and Notion AI) as an MCP server, running on Cloudflare Workers. 19 tools covering products, sales, offer codes, subscribers, payouts and webhooks, with bulk operations across the whole catalog. 23 offline tests, no network required to run them.

- `src/` is the source of truth. `index.js` routes, `mcp.js` speaks JSON-RPC, `tools.js` defines the tools, `gumroad.js` talks to the API.
- Stateless Streamable HTTP: every `POST /mcp` is self-contained, so Claude and Notion can share one Worker.

## Top 5 use cases

1. **Proofread the whole catalog in one pass.** `gumroad_list_products` with `view: "copy"` returns every name, summary and description as plain text with links intact, so an AI can spot typos, dead links and outdated prices across 60 products in one conversation.
2. **Bulk price or currency changes.** `gumroad_bulk_update_products` with a filter (`free`, `tag`, `name_contains`, `max_sales`) and a patch. Dry-run by default, one result row per product.
3. **Publish or unpublish a set at once.** Take a seasonal bundle down, or relaunch everything tagged `exam-prep`, with `gumroad_bulk_set_published`.
4. **Revenue questions in plain English.** `gumroad_list_sales` with `summary_only: true` returns gross, fees, refunds, disputes and revenue per product for any date range.
5. **Discount codes without the dashboard.** `gumroad_create_offer_code` on any product, cents or percent, capped by purchase count.

## Tools

| Group | Tools |
| --- | --- |
| Read | `gumroad_get_user`, `gumroad_list_products`, `gumroad_get_product`, `gumroad_list_sales`, `gumroad_get_sale`, `gumroad_list_offer_codes`, `gumroad_list_subscribers`, `gumroad_list_payouts`, `gumroad_list_webhooks` |
| Write | `gumroad_create_product`, `gumroad_update_product`, `gumroad_publish_product`, `gumroad_unpublish_product`, `gumroad_delete_product`, `gumroad_create_offer_code`, `gumroad_refund_sale` |
| Bulk | `gumroad_bulk_update_products`, `gumroad_bulk_set_published` |
| Cache | `gumroad_seed_product_ids` |
| Escape hatch | `gumroad_request`, any v2 endpoint not wrapped above |

## Deploy

```bash
npm install
npm test                                       # 23 offline tests
npx wrangler kv namespace create CATALOG       # paste the id into wrangler.toml
npx wrangler secret put GUMROAD_ACCESS_TOKEN   # Gumroad, Settings, Advanced, Applications
npx wrangler secret put MCP_AUTH_TOKEN         # a long random string, keep a copy
npm run deploy
```

Open `https://gumroad-mcp.<subdomain>.workers.dev/` and confirm both secrets read "set". Then add a custom connector in Claude pointing at `.../mcp` with `MCP_AUTH_TOKEN` as the bearer token. If your connector dialog has no header field, the same token is accepted as `?key=` on the URL.

## Safety rules built in

- Bulk operations dry-run by default. Pass `dry_run: false` to write.
- `gumroad_delete_product`, `gumroad_refund_sale` and any write through `gumroad_request` require `confirm: true`.
- Unknown product fields are rejected before any request is sent, so a typo fails loudly.
- One failure in a bulk run does not stop the rest. Every id gets a row.
- `/mcp` fails closed: no `MCP_AUTH_TOKEN` means no access.

## Why the catalog walk exists

Gumroad's `GET /products` returns at most 10 products and documents no pagination. `GET /user` lists every permalink, but `GET /products/:custom-permalink` returns "not found". The Worker resolves the rest by mining product cross-references and walking `/sales`, caches the permalink-to-id map in KV, and reports `coverage` honestly on every call. The one combination the API cannot surface at all (custom permalink, outside the 10 newest, zero sales) is handled by `gumroad_seed_product_ids`, which takes the id from the dashboard URL once.

## Endpoint provenance

Paths and write fields mirror `antiwork/gumroad-cli` (`internal/api/client.go`, `internal/cmd/products/create.go` and `update.go`). Gumroad's docs say `POST /v2/products` returns 404; the CLI implements it anyway. The tool is wired and the error explains the dashboard fallback if the 404 is real.

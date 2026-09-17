# mcp

Custom MCP servers and Cloudflare Workers behind [anthonytoday.com](https://www.anthonytoday.com/mcp/), open-sourced so others can reuse them. Everything here runs on Cloudflare Workers, holds its credentials as Worker secrets, and is reachable from Claude either as an MCP connector or as a webhook target.

| Folder | Kind | What it does |
| --- | --- | --- |
| [`gumroad-mcp/`](gumroad-mcp/) | MCP server | The whole Gumroad shop as 19 tools: products, sales, offer codes, subscribers, payouts, webhooks, bulk edits |
| [`notion-marketplace-webhook/`](notion-marketplace-webhook/) | Worker (webhook) | Every Notion Marketplace template download becomes a Notion row, a Resend contact and a Sheets line |
| [`offer-capture/`](offer-capture/) | Worker (API) | Consent-gated lead capture for a static site, synced to HubSpot |

Each folder has its own README with the endpoint, the top five use cases, the deploy steps and the safety rules built into the code.

## Connect an MCP server to Claude

1. Deploy the Worker (`npx wrangler deploy` inside the folder, secrets set with `wrangler secret put`).
2. In Claude, Settings, Connectors, Add custom connector.
3. URL: `https://<worker>.<subdomain>.workers.dev/mcp`. Auth: the `MCP_AUTH_TOKEN` value as a bearer token.

The same endpoint works from Notion AI and any other Streamable HTTP MCP client.

## Design rules shared by every folder

- **Secrets never touch the repo.** Tokens are Worker secrets; `wrangler.toml` holds only plain configuration. `.dev.vars` is git-ignored.
- **Fail closed.** An unset auth token means no access, never open access.
- **Destructive actions are gated.** Deletes and refunds need `confirm: true`; bulk operations dry-run by default.
- **Every bulk run is auditable.** One result row per record, so a partial failure is visible instead of silent.
- **No frameworks.** Plain Workers JavaScript, no build step beyond `wrangler`, offline tests where the logic warrants them.

## Why Workers

Claude's own sandbox cannot reach third-party APIs directly, but it can call an MCP connector. A Worker on Cloudflare's edge holds the API token, exposes the tools, and costs nothing at this volume. The pattern generalizes to any REST API with a long-lived token.

## Author

Anthony Kieffer, Notion Certified Consultant and cybersecurity advisor (CISSP, ISO 27001 Lead Implementer, PMP). Dubai. [anthonytoday.com](https://www.anthonytoday.com) · [LinkedIn](https://www.linkedin.com/in/anthony-kieffer/)

## License

MIT. See [LICENSE](LICENSE).

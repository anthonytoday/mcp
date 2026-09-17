# offer-capture

The lead-capture endpoint behind the Notion Business offer popup on [anthonytoday.com](https://www.anthonytoday.com). One Cloudflare Worker, no framework, no database.

A visitor enters an email and ticks consent. The Worker validates the address, stores the lead in KV, creates the contact in HubSpot with the visitor's language, and hands back the offer link for the browser to open.

## Endpoint

```
POST /api/claim-offer
{ "email": "someone@example.com", "lang": "en", "page": "/notion/", "consent": true }

200 { "ok": true, "url": "<OFFER_URL>", "crm": "created" | "existing" | "deferred" | "failed" | "skipped" }
422 { "ok": false, "error": "invalid_email" | "consent_required" }
```

`GET /health` returns `ok`.

## Top 5 use cases

1. Lead capture on a static site (GitHub Pages, Jekyll) with no backend of your own.
2. Consent-gated capture: nothing is stored unless `consent: true` is sent.
3. Language-aware CRM contacts: `hs_language` is set from the page language, so follow-up goes out in the right language.
4. Sync to HubSpot without exposing the token in the browser: the key lives as a Worker secret.
5. Blocklisting known bad addresses without changing the site: a comma-separated secret, no redeploy of the page.

## Deploy

```bash
npx wrangler kv namespace create LEADS       # paste the id into wrangler.toml
npx wrangler secret put HUBSPOT_TOKEN        # optional, "deferred" until set
npx wrangler secret put BLOCKLIST            # optional, comma-separated emails
npx wrangler deploy
```

Then point the site at `https://offer-capture.<subdomain>.workers.dev/api/claim-offer`.

## Safety rules built in

- CORS is restricted to `ALLOWED_ORIGINS`; other origins get the first allowed origin, so the browser refuses the response.
- Emails are validated and length-capped before anything is stored.
- Blocked addresses still receive the offer link, so the popup gives nothing away, but nothing is written and nothing reaches the CRM.
- HubSpot 409 (contact exists) is treated as success, so repeat visitors never produce duplicates.
- Leads expire from KV after 2 years.

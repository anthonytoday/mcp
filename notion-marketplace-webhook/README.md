# notion-marketplace-webhook

Cloudflare Worker that receives the Notion Marketplace template-download webhook and fans it out to three places at once:

1. **Notion**: one row per download in a "Marketplace Downloads" database, linked to the listing it came from
2. **Resend**: the downloader becomes a contact (optionally in a segment, optionally firing an automation event)
3. **Google Sheets**: a reporting row through an Apps Script web app

Every step runs independently, so a Sheets failure never blocks the Notion row and a repeat download is recorded as `duplicate` rather than dropped.

## Endpoint

```
POST /   the raw Notion Marketplace payload
GET  /   { "status": "ok" } health check
```

The Worker reads `customerEmail`, `templateName`, `templateSlug`, `productType`, `locale`, `source`, `couponCode`, `acquisitionId`, `listingPrice`, `discountedPrice`, `totalCustomerPayment` and `time` from the payload and tolerates every one of them being absent.

## Top 5 use cases

1. Know who downloaded which template, when, and what they paid, without opening the Marketplace dashboard.
2. Grow an email list from Marketplace downloads with the consent Notion already collected.
3. Kick off a welcome or upgrade sequence in Resend from a single event (`RESEND_EVENT_NAME`).
4. Roll downloads up per listing in Notion: the row is related to the listing by slug, so a rollup on the listings database stays live.
5. Keep a flat spreadsheet log for anyone who prefers Sheets over Notion for reporting.

## Deploy

```bash
npx wrangler secret put NOTION_TOKEN          # internal integration with access to both databases
npx wrangler secret put RESEND_API_KEY        # sending + contacts permission
npx wrangler secret put GSHEET_WEBHOOK_URL    # the Apps Script /exec URL
npx wrangler deploy
```

Plain variables live in `wrangler.toml`: `NOTION_DB_ID`, `NOTION_TRACKER_DB_ID`, `RESEND_SEGMENT_ID` and, once your automation is published, `RESEND_EVENT_NAME`. A `wrangler deploy` replaces the dashboard's plain vars, so declare them in the file rather than in the dashboard.

Then paste the Worker URL into your Notion Marketplace profile as the download webhook.

## Notion database properties expected

Downloader (title), Email, Template (select), Downloaded At (date), Email Shared (checkbox), Source, Record Origin, Resend Status, Product Type, Locale, Channel (selects), Product Slug, Acquisition ID, Coupon Code, Raw Payload (rich text), Listing Price, Discounted Price, Customer Payment (number), Status (select), Listing (relation to the listings database, matched on a `Slug` rich-text property there).

## Safety rules built in

- A customer name equal to, or a prefix of, the template title is discarded: Notion sometimes sends the title in the name field.
- No email in the payload means Sheets and Notion only, and no contact is created.
- Resend 409 is recorded as `duplicate`, never retried, never a second contact.
- The Notion row is written after the Resend outcome is known, so `Resend Status` is always accurate.

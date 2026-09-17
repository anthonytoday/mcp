/**
 * notion-marketplace-webhook
 *
 * Receives the Notion Marketplace template-download webhook and fans it out to
 * three independent sinks: a Notion database row, a Resend contact (plus an
 * optional automation event) and a Google Sheets line through Apps Script.
 *
 * ENV VARS
 *   RESEND_API_KEY       (secret)   required
 *   GSHEET_WEBHOOK_URL   (secret)   required
 *   NOTION_TOKEN         (secret)   optional. Internal integration token. Unset = Notion step skipped.
 *   NOTION_DB_ID         (plain)    optional. The downloads database id.
 *   NOTION_TRACKER_DB_ID (plain)    optional. The listings database id. When set, each
 *                                   download row is linked to the listing whose Slug matches.
 *   RESEND_SEGMENT_ID    (plain)    optional. Segment new downloaders join.
 *   RESEND_EVENT_NAME    (plain)    optional, e.g. "template.downloaded". Leave unset until
 *                                   the Resend automation is built and published.
 *
 * The live marketplace payload, confirmed from production traffic:
 *
 *   { acquisitionId, time, customerEmail, productType, templateName, templateSlug,
 *     name, slug, discountedPrice, listingPrice, couponCode, event, locale,
 *     source, totalCustomerPayment }
 *
 * Notion returns 400 rather than degrading on three input rules, all handled below:
 *   - a select option name cannot contain a comma
 *   - a select option name is capped at 100 characters
 *   - a rich_text chunk is capped at 2000 characters
 */
const NOTION_VERSION = '2022-06-28';

function selectName(value, fallback) {
  const clean = String(value || '').replace(/,/g, ' ').trim().slice(0, 100);
  return clean || fallback;
}

function richText(value, limit = 2000) {
  return [{ text: { content: String(value == null ? '' : value).slice(0, limit) } }];
}

/** First non-empty string among the candidates. */
function firstOf(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

/** Notion rejects NaN on a number property; null clears it instead. */
function numberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * payload.time is epoch milliseconds and is the moment the download actually
 * happened. Falls back to arrival time if it is missing or implausible.
 */
function downloadTimestamp(payload, arrivalIso) {
  const ms = Number(payload && payload.time);
  if (!Number.isFinite(ms) || ms <= 0) return arrivalIso;
  const when = new Date(ms);
  const year = when.getUTCFullYear();
  if (Number.isNaN(when.getTime()) || year < 2015 || year > 2100) return arrivalIso;
  return when.toISOString();
}

/**
 * Resolve the listings row for a marketplace slug. Returns the page id, or null
 * when the slug is unknown or the tracker is not configured. Never throws: the
 * download row matters more than the link.
 */
async function findListingPageId(env, slug) {
  if (!env.NOTION_TRACKER_DB_ID) return null;
  try {
    const response = await fetch(`https://api.notion.com/v1/databases/${env.NOTION_TRACKER_DB_ID}/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
      },
      body: JSON.stringify({
        page_size: 1,
        filter: { property: 'Slug', rich_text: { equals: slug } },
      }),
    });

    if (!response.ok) {
      console.error(`Tracker query error: ${response.status} - ${await response.text()}`);
      return null;
    }

    const data = await response.json();
    if (data.results && data.results.length > 0) return data.results[0].id;
    console.warn(`No listings row for slug ${slug}`);
    return null;
  } catch (error) {
    console.error('Error querying listings database:', error.message);
    return null;
  }
}

/**
 * Append one row to the downloads database. Resolves to a short status string; never throws.
 */
async function writeNotionRow(env, { payload, buyerEmail, templateName, resendStatus, timestamp }) {
  if (!env.NOTION_TOKEN || !env.NOTION_DB_ID) {
    console.log('NOTION_TOKEN or NOTION_DB_ID not set, skipping Notion row');
    return 'skipped_not_configured';
  }

  const raw = payload || {};
  const slug        = firstOf(raw.templateSlug, raw.slug, raw.product_slug);
  const productType = firstOf(raw.productType, raw.product_type);
  const locale      = firstOf(raw.locale);
  const channel     = firstOf(raw.source);
  const coupon      = firstOf(raw.couponCode, raw.coupon_code);
  const acquisition = firstOf(raw.acquisitionId, raw.acquisition_id);

  const properties = {
    'Downloader': { title: richText(buyerEmail || '(no email shared)') },
    'Template': { select: { name: selectName(templateName, 'unknown') } },
    'Downloaded At': { date: { start: downloadTimestamp(raw, timestamp) } },
    'Email Shared': { checkbox: Boolean(buyerEmail) },
    'Source': { select: { name: 'notion-marketplace' } },
    'Record Origin': { select: { name: 'webhook' } },
    'Resend Status': { select: { name: resendStatus } },
    'Listing Price': { number: numberOrNull(raw.listingPrice) },
    'Discounted Price': { number: numberOrNull(raw.discountedPrice) },
    'Customer Payment': { number: numberOrNull(raw.totalCustomerPayment) },
    'Raw Payload': { rich_text: richText(JSON.stringify(raw)) },
  };

  // Empty strings are rejected outright by the email, select and rich_text-backed
  // property types, so each optional field is only attached when it has a value.
  if (buyerEmail)   properties['Email']          = { email: buyerEmail };
  if (slug)         properties['Product Slug']   = { rich_text: richText(slug) };
  if (acquisition)  properties['Acquisition ID'] = { rich_text: richText(acquisition) };
  if (coupon)       properties['Coupon Code']    = { rich_text: richText(coupon) };
  if (productType)  properties['Product Type']   = { select: { name: selectName(productType, 'Template') } };
  if (locale)       properties['Locale']         = { select: { name: selectName(locale, '') } };
  if (channel)      properties['Channel']        = { select: { name: selectName(channel, '') } };

  // The webhook only fires on a completed acquisition, so Status is inferred from
  // the event name. Refunds never arrive this way; reconcile them from the CSV export.
  if (firstOf(raw.event) === 'marketplace.purchase') {
    properties['Status'] = { select: { name: 'Succeeded' } };
  }

  if (slug) {
    const listingId = await findListingPageId(env, slug);
    if (listingId) properties['Listing'] = { relation: [{ id: listingId }] };
  }

  try {
    const response = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
      },
      body: JSON.stringify({ parent: { database_id: env.NOTION_DB_ID }, properties }),
    });

    if (!response.ok) {
      // 404 here almost always means the database was never shared with the
      // integration, not that the id is wrong. Notion returns 404 for both.
      console.error(`Notion error: ${response.status} - ${await response.text()}`);
      return 'failed';
    }

    console.log(`Notion row created for ${buyerEmail || '(no email)'} / ${templateName}`);
    return 'created';
  } catch (error) {
    console.error('Error calling Notion:', error.message);
    return 'failed';
  }
}

export default {
  async fetch(request, env, ctx) {
    const method = request.method;
    const url = new URL(request.url);

    console.log(`[${new Date().toISOString()}] ${method} ${url.pathname}`);

    // Notion's test request may be GET or HEAD.
    if (method === 'GET' || method === 'HEAD') {
      return new Response(JSON.stringify({ status: 'ok', message: 'Webhook receiver is working' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Only POST, GET, HEAD allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const payload = await request.json();
      console.log('Received POST payload:', JSON.stringify(payload));

      const buyerEmail = payload.customerEmail || payload.email || '';
      const templateName = payload.templateName || payload.template || 'unknown';

      // The marketplace payload carries NO buyer name. Its top-level `name` field
      // holds the TEMPLATE title, so it is excluded outright, and whatever survives
      // is checked against the template title before it is accepted. Empty is safe:
      // greetings in the email chain are name-optional.
      const eventTimestamp = new Date().toISOString();

      const norm = (s) => String(s || '').trim().toLowerCase();
      const rawName = payload.customerName || payload.buyerName || payload.customer_name || '';

      let customerName = String(rawName || '').trim();
      if (customerName && norm(customerName) === norm(templateName)) {
        console.warn(`Discarding name "${customerName}": it matches the template title`);
        customerName = '';
      }
      if (customerName && norm(templateName).startsWith(norm(customerName))) {
        console.warn(`Discarding name "${customerName}": it is a prefix of the template title`);
        customerName = '';
      }

      const firstName = customerName ? customerName.split(' ')[0] : '';
      const lastName = customerName ? customerName.split(' ').slice(1).join(' ') : '';

      if (!env.GSHEET_WEBHOOK_URL) {
        console.error('GSHEET_WEBHOOK_URL is not set');
        return new Response(JSON.stringify({ error: 'Google Sheet webhook URL not configured' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Google Sheets always runs, email or not, so reporting stays complete.
      const sheetTask = (async () => {
        try {
          const gsResponse = await fetch(env.GSHEET_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          console.log(`Google Sheets response status: ${gsResponse.status}`);
          if (!gsResponse.ok) console.error(`Google Sheets error: ${gsResponse.status}`);
        } catch (error) {
          console.error('Error calling Google Sheets webhook:', error.message);
        }
      })();

      // No email shared: log the row, skip Resend, return 200 so Notion never retries.
      if (!buyerEmail) {
        console.warn('No customerEmail in payload: logging to Sheets and Notion only');
        ctx.waitUntil(Promise.all([
          sheetTask,
          writeNotionRow(env, {
            payload,
            buyerEmail: '',
            templateName,
            resendStatus: 'skipped',
            timestamp: eventTimestamp,
          }),
        ]));
        return new Response(JSON.stringify({
          success: true,
          skipped: 'no_email_shared',
          message: 'Logged to Google Sheets and Notion, no subscriber created'
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (!env.RESEND_API_KEY) {
        console.error('RESEND_API_KEY is not set');
        return new Response(JSON.stringify({ error: 'Resend API key not configured' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      console.log(`Processing: ${buyerEmail} for template ${templateName}`);

      // The Notion row records what Resend actually did, so Resend publishes its
      // outcome through this promise and the Notion task waits on it.
      let publishResendStatus;
      const resendStatus = new Promise((resolve) => { publishResendStatus = resolve; });

      ctx.waitUntil(
        Promise.all([
          sheetTask,

          // Add the contact to Resend
          (async () => {
            let contactStatus = 'failed';
            try {
              const contactBody = {
                email: buyerEmail,
                first_name: firstName,
                last_name: lastName,
                unsubscribed: false,
                properties: {
                  template_purchased: templateName,
                  purchase_date: eventTimestamp,
                  source: 'notion-marketplace',
                },
              };
              if (env.RESEND_SEGMENT_ID) {
                contactBody.segments = [{ id: env.RESEND_SEGMENT_ID }];
              }

              const rsResponse = await fetch('https://api.resend.com/contacts', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                },
                body: JSON.stringify(contactBody),
              });

              const rsData = await rsResponse.text();
              console.log(`Resend response status: ${rsResponse.status}`);

              // 409 = contact already exists. Normal on a repeat download.
              if (!rsResponse.ok && rsResponse.status !== 409) {
                console.error(`Resend error: ${rsResponse.status} - ${rsData}`);
                contactStatus = 'failed';
              } else if (rsResponse.status === 409) {
                contactStatus = 'duplicate';
              } else {
                contactStatus = 'created';
              }
              publishResendStatus(contactStatus);

              // A repeat downloader returns 409 and is never re-segmented by the
              // create call above. This explicit attach catches them.
              if (env.RESEND_SEGMENT_ID) {
                let contactRef = buyerEmail;
                try {
                  const parsed = JSON.parse(rsData);
                  if (parsed && parsed.id) contactRef = parsed.id;
                } catch (err) { /* 409 body is not JSON; fall back to the email */ }

                const segResponse = await fetch(
                  `https://api.resend.com/contacts/${encodeURIComponent(contactRef)}/segments/${encodeURIComponent(env.RESEND_SEGMENT_ID)}`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                    },
                  }
                );
                if (!(segResponse.ok || segResponse.status === 409)) {
                  console.error(`Segment attach failed: ${segResponse.status} - ${await segResponse.text()}`);
                }
              }
            } catch (error) {
              console.error('Error calling Resend:', error.message);
            } finally {
              // Resolving twice is a no-op: the Notion task can never be left hanging.
              publishResendStatus(contactStatus);
            }
          })(),

          // Append the Notion row once the Resend outcome is known.
          (async () => {
            await writeNotionRow(env, {
              payload,
              buyerEmail,
              templateName,
              resendStatus: await resendStatus,
              timestamp: eventTimestamp,
            });
          })(),

          // Fire the automation trigger event, only once RESEND_EVENT_NAME is set.
          (async () => {
            if (!env.RESEND_EVENT_NAME) return;
            try {
              const evResponse = await fetch('https://api.resend.com/events', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                },
                body: JSON.stringify({
                  event: env.RESEND_EVENT_NAME,
                  email: buyerEmail,
                  payload: {
                    template: templateName,
                    first_name: firstName,
                    source: 'notion-marketplace',
                  },
                }),
              });
              if (!evResponse.ok) {
                console.error(`Resend event error: ${evResponse.status} - ${await evResponse.text()}`);
              }
            } catch (error) {
              console.error('Error firing Resend event:', error.message);
            }
          })(),
        ])
      );

      return new Response(JSON.stringify({
        success: true,
        email: buyerEmail,
        message: 'Webhook received, data sent to Resend, Google Sheets and Notion'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    } catch (error) {
      console.error('Error processing request:', error.message);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};

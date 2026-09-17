/**
 * offer-capture: the lead-capture endpoint behind the Notion Business offer
 * popup on anthonytoday.com.
 *
 * Routes
 *   GET  /health            plain "ok", safe to poll
 *   POST /api/claim-offer   { email, lang, page, consent } -> { ok, url, crm }
 *
 * What it does with a valid, consented email:
 *   1. stores the lead in KV (binding LEADS, 2-year TTL) with page, language and country
 *   2. creates the contact in HubSpot when HUBSPOT_TOKEN is set, tagging the language
 *   3. returns the offer URL for the browser to open
 *
 * Configuration (wrangler.toml [vars] unless noted)
 *   OFFER_URL       the link the visitor is sent to after claiming
 *   ALLOWED_ORIGINS comma-separated origins allowed to call the endpoint
 *   BLOCKLIST       secret, comma-separated emails that are accepted but never stored or synced
 *   HUBSPOT_TOKEN   secret, HubSpot service key scoped crm.objects.contacts.write
 */

const RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

function list(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

async function toHubspot(env, email, lang) {
  if (!env.HUBSPOT_TOKEN) return "deferred";
  const host = env.HUBSPOT_API_HOST || "https://api.hubapi.com";
  try {
    const r = await fetch(`${host}/crm/v3/objects/contacts`, {
      method: "POST",
      headers: { authorization: "Bearer " + env.HUBSPOT_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ properties: { email, hs_language: lang === "fr" ? "fr" : "en" } })
    });
    if (r.status === 409) return "existing";
    return r.ok ? "created" : "failed";
  } catch (e) {
    return "failed";
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowed = list(env.ALLOWED_ORIGINS);
    const origin = (request.headers.get("Origin") || "").toLowerCase();
    const allow = allowed.includes(origin) ? origin : allowed[0] || "";
    const cors = {
      "Access-Control-Allow-Origin": allow,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };

    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname !== "/api/claim-offer") return new Response("Not found", { status: 404 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

    let p;
    try {
      p = await request.json();
    } catch (e) {
      return Response.json({ ok: false, error: "bad_request" }, { status: 400, headers: cors });
    }

    const email = String(p.email || "").trim().toLowerCase();
    const lang = p.lang === "fr" ? "fr" : "en";
    const page = String(p.page || "").slice(0, 200);
    if (!RE.test(email) || email.length > 254) {
      return Response.json({ ok: false, error: "invalid_email" }, { status: 422, headers: cors });
    }
    if (p.consent !== true) {
      return Response.json({ ok: false, error: "consent_required" }, { status: 422, headers: cors });
    }

    // Blocked addresses get the offer link like anyone else, so the popup
    // behaves identically, but nothing is stored and nothing reaches the CRM.
    const blocked = list(env.BLOCKLIST).includes(email);
    let crm = "skipped";
    if (!blocked) {
      if (env.LEADS) {
        try {
          await env.LEADS.put(
            "lead:" + email,
            JSON.stringify({
              email,
              lang,
              page,
              consent: true,
              source: "notion-business-offer",
              country: request.headers.get("CF-IPCountry") || null,
              created_at: new Date().toISOString()
            }),
            { expirationTtl: 63072000 }
          );
        } catch (e) {}
      }
      crm = await toHubspot(env, email, lang);
    }
    return Response.json({ ok: true, url: env.OFFER_URL || "", crm }, { headers: cors });
  }
};

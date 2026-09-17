/**
 * gumroad-mcp: the Gumroad shop exposed to Claude as an MCP server.
 *
 * Routes
 *   GET  /         human-readable status page
 *   GET  /health   JSON health, safe to poll
 *   POST /mcp      the MCP endpoint Claude connects to (bearer-protected)
 *
 * No OAuth: a Gumroad access token is long-lived, so it lives as a Worker
 * secret and that is the whole of the auth story.
 */

import { handleMcpRequest } from './mcp.js';

/** Length-independent comparison so the bearer check does not leak by timing. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearerOk(request, env) {
  const expected = env.MCP_AUTH_TOKEN;
  // Fail closed. An unset token must never mean "open to the internet".
  if (!expected) return false;
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? safeEqual(match[1].trim(), expected) : false;
}

/**
 * Fallback for MCP clients whose connector dialog has no custom-header field:
 * the same token may be presented as ?key= on the /mcp URL. A header is
 * preferred, because query strings turn up in logs and referrers.
 */
function keyParamOk(url, env) {
  const expected = env.MCP_AUTH_TOKEN;
  if (!expected) return false;
  return safeEqual(url.searchParams.get('key') || '', expected);
}

function statusPage(env) {
  const ready = Boolean(env.GUMROAD_ACCESS_TOKEN) && Boolean(env.MCP_AUTH_TOKEN);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
     <title>Gumroad MCP Server</title>
     <style>body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
       max-width:640px;margin:8vh auto;padding:0 24px;color:#051C2C}
       code{background:#f2f4f7;padding:2px 6px;border-radius:4px;font-size:14px}
       .ok{color:#0a7d33}.bad{color:#c0392b}h1{font-size:22px}</style>
     <h1>Gumroad MCP Server</h1>
     <p>Status: <strong class="${ready ? 'ok' : 'bad'}">${ready ? 'ready' : 'not configured'}</strong></p>
     <ul>
       <li>Gumroad token: ${env.GUMROAD_ACCESS_TOKEN ? 'set' : 'missing. Cloudflare dashboard, this Worker, Settings, Variables and Secrets, Add, type <b>Secret</b>, key <code>GUMROAD_ACCESS_TOKEN</code>'}</li>
       <li>MCP bearer: ${env.MCP_AUTH_TOKEN ? 'set' : 'missing. Same place, key <code>MCP_AUTH_TOKEN</code>. A build variable is not enough: it must be a Secret, or it never reaches the runtime.'}</li>
     </ul>
     <p>Connect Claude to <code>POST /mcp</code> with the MCP bearer token.</p>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' ) return statusPage(env);

    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        gumroad_token: Boolean(env.GUMROAD_ACCESS_TOKEN),
        mcp_auth: Boolean(env.MCP_AUTH_TOKEN),
        time: new Date().toISOString(),
      });
    }

    if (url.pathname === '/mcp') {
      if (!bearerOk(request, env) && !keyParamOk(url, env)) {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized.' } }),
          { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' } }
        );
      }
      return handleMcpRequest(request, env);
    }

    return new Response('Not found', { status: 404 });
  },
};

/**
 * Minimal stateless MCP server over Streamable HTTP (JSON-RPC 2.0 on POST /mcp).
 *
 * Stateless on purpose: no session id, no SSE stream to hold open. Every POST is
 * self-contained, which is what lets Claude and Notion hit the same Worker
 * concurrently without stepping on each other.
 */

import { TOOL_SPECS, findTool } from './tools.js';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const SERVER_INFO = { name: 'gumroad-shop', version: '1.0.0' };

/* JSON-RPC error codes */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

function result(id, payload) {
  return { jsonrpc: '2.0', id, result: payload };
}

function failure(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/** Tool errors are reported inside a successful result, per the MCP spec. */
function toolFailure(id, message, hint) {
  const text = hint ? `${message}\n\nHint: ${hint}` : message;
  return result(id, { content: [{ type: 'text', text }], isError: true });
}

async function handleMessage(message, env) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return failure(null, INVALID_REQUEST, 'Request must be a JSON-RPC object.');
  }

  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
      return result(id, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // notifications get no response body

    case 'ping':
      return result(id, {});

    case 'tools/list':
      return result(id, { tools: TOOL_SPECS });

    case 'tools/call': {
      const name = params?.name;
      const tool = findTool(name);
      if (!tool) {
        return failure(id, METHOD_NOT_FOUND, `Unknown tool: ${name}`);
      }
      try {
        const output = await tool.handler(env, params?.arguments || {});
        return result(id, {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
        });
      } catch (err) {
        return toolFailure(id, err.message || String(err), err.hint);
      }
    }

    default:
      if (isNotification) return null;
      return failure(id, METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

export async function handleMcpRequest(request, env) {
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify(failure(null, INVALID_REQUEST, 'The MCP endpoint accepts POST only.')),
      { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST' } }
    );
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response(JSON.stringify(failure(null, PARSE_ERROR, 'Body is not valid JSON.')), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // A batch is a JSON array; a single call is an object.
    if (Array.isArray(payload)) {
      const responses = (await Promise.all(payload.map((m) => handleMessage(m, env)))).filter(
        Boolean
      );
      if (responses.length === 0) return new Response(null, { status: 202 });
      return Response.json(responses);
    }

    const response = await handleMessage(payload, env);
    if (response === null) return new Response(null, { status: 202 });
    return Response.json(response);
  } catch (err) {
    return new Response(
      JSON.stringify(failure(payload?.id ?? null, INTERNAL_ERROR, err.message || 'Server error')),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

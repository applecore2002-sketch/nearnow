/**
 * NearNow MCP entry for EdgeOne Pages Node Functions.
 * Route: /mcp (cloud-functions/mcp/index.js -> POST /mcp)
 *
 * Hand-rolled stateless MCP over Streamable HTTP (JSON responses only —
 * enableJsonResponse semantics). No MCP SDK dependency here: the deployed
 * function is plain ESM + web-standard Request/Response. Tool schemas below
 * are the frozen `muse@1.0.0` snapshot; domain logic is imported from the
 * compiled bundle in ./domain/ (assembled by scripts/build-edgeone.mjs).
 */
import { getPlaceDetails, listCategories, searchPlaces } from './domain/search.js';

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_INFO = { name: 'nearnow', version: '0.1.0' };

// Frozen tool definitions (keep byte-identical during Meta review freeze).
const TOOLS = [
  {
    name: 'search_places',
    title: 'Search public places',
    description:
      'Find nearby public places from OpenStreetMap: pharmacies, supermarkets, gas stations, ' +
      'EV chargers, libraries, post offices (US coverage first). Pass either a location {lat,lng} ' +
      'or an area name like "Pasadena, CA". Each result includes distance, address, opening hours ' +
      'with hours_confidence (confirmed = from OSM data, estimated = chain/category default, ' +
      'unknown), and open_now where determinable. Set open_now=true to keep only places likely ' +
      'open right now (unknown hours are excluded, never guessed).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['category'],
      properties: {
        location: {
          type: 'object',
          additionalProperties: false,
          properties: {
            lat: { type: 'number', minimum: -90, maximum: 90 },
            lng: { type: 'number', minimum: -180, maximum: 180 },
          },
        },
        area: { type: 'string', minLength: 2, maxLength: 80 },
        category: { type: 'string', minLength: 2, maxLength: 40 },
        radius_m: { type: 'integer', minimum: 100, maximum: 20000 },
        open_now: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_place_details',
    title: 'Get place details',
    description:
      'Get full details for one place by its place_id (e.g. "osm:node/123") returned by ' +
      'search_places: exact coordinates, address, opening hours with confidence, contact info ' +
      'and the OpenStreetMap URL.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['place_id'],
      properties: {
        place_id: { type: 'string', minLength: 6, maxLength: 60 },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_categories',
    title: 'List supported place categories',
    description:
      'List the place categories NearNow can search (pharmacy, supermarket, fuel, ev_charging, ' +
      'library, post_office) with an example query for each. Call this if unsure which category ' +
      'value to pass to search_places.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

const CODES = {
  PARSE: -32700,
  INVALID: -32600,
  METHOD: -32601,
  PARAMS: -32602,
};

const KNOWN_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

async function callTool(name, args) {
  if (name === 'search_places') {
    const a = { ...args };
    if (a.radius_m !== undefined) a.radius_m = clampInt(a.radius_m, 100, 20000, 3000);
    if (a.limit !== undefined) a.limit = clampInt(a.limit, 1, 10, 5);
    if (a.open_now !== undefined) a.open_now = Boolean(a.open_now);
    const res = await searchPlaces(a);
    return { content: [{ type: 'text', text: JSON.stringify(res) }], structuredContent: res, isError: res.status === 'INVALID_INPUT' };
  }
  if (name === 'get_place_details') {
    const res = await getPlaceDetails(String(args?.place_id ?? ''));
    return { content: [{ type: 'text', text: JSON.stringify(res) }], structuredContent: res, isError: res.status !== 'OK' };
  }
  if (name === 'list_categories') {
    const res = listCategories();
    return { content: [{ type: 'text', text: JSON.stringify(res) }], structuredContent: res };
  }
  return { __unknownTool: true };
}

async function handleRpcMessage(msg) {
  if (typeof msg !== 'object' || msg === null || msg.jsonrpc !== '2.0') {
    return rpcError(msg?.id ?? null, CODES.INVALID, 'Invalid Request');
  }
  if (typeof msg.method !== 'string') {
    return rpcError(msg.id ?? null, CODES.INVALID, 'Invalid Request: method required');
  }
  const isNotification = msg.id === undefined || msg.id === null;
  const params = msg.params ?? {};

  switch (msg.method) {
    case 'initialize':
      if (isNotification) return rpcError(null, CODES.INVALID, 'initialize must have an id');
      return rpcResult(msg.id, {
        protocolVersion: KNOWN_PROTOCOL_VERSIONS.has(params.protocolVersion)
          ? params.protocolVersion
          : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // notification: no response body

    case 'ping':
      return rpcResult(msg.id ?? null, {});

    case 'tools/list':
      return rpcResult(msg.id ?? null, { tools: TOOLS });

    case 'tools/call': {
      if (isNotification) return rpcError(null, CODES.INVALID, 'tools/call must have an id');
      const name = params?.name;
      if (typeof name !== 'string') {
        return rpcError(msg.id, CODES.PARAMS, 'params.name is required');
      }
      const out = await callTool(name, params.arguments ?? {});
      if (out.__unknownTool) {
        return rpcError(msg.id, CODES.PARAMS, `Unknown tool: ${name}`);
      }
      return rpcResult(msg.id, out);
    }

    default:
      if (msg.method.startsWith('notifications/')) return null;
      return isNotification
        ? null
        : rpcError(msg.id, CODES.METHOD, `Method not found: ${msg.method}`);
  }
}

async function handleMcpPost(request) {
  const API_KEYS = new Set(
    (process.env.NEARNOW_API_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean)
  );
  const ALLOWED_ORIGINS = new Set(
    (process.env.NEARNOW_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
  );

  const origin = request.headers.get('origin');
  if (origin && ALLOWED_ORIGINS.size > 0 && !ALLOWED_ORIGINS.has(origin)) {
    return json({ error: 'origin_not_allowed' }, 403);
  }

  if (API_KEYS.size > 0) {
    const auth = request.headers.get('authorization') || '';
    const xkey = request.headers.get('x-api-key') || '';
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : xkey.trim();
    if (!key || !API_KEYS.has(key)) {
      return json({ error: 'unauthorized' }, 401, { 'www-authenticate': 'Bearer' });
    }
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return rpcError(null, CODES.PARSE, 'Parse error');
  }

  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const m of messages) {
    const r = await handleRpcMessage(m);
    if (r !== null) responses.push(r);
  }
  if (responses.length === 0) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? responses : responses[0]);
}

export default async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    const origin = request.headers.get('origin') || '';
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': origin || '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'authorization, x-api-key, content-type, mcp-protocol-version',
        'access-control-max-age': '86400',
        vary: 'Origin',
      },
    });
  }
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST, OPTIONS' } });
  }
  return handleMcpPost(request);
}

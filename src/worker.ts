// Cloudflare Workers entry (W0-17, deploy branch only; main keeps node:http server).
// Mirrors src/index.ts request handling (auth / origin / rate limit / routes)
// without a listenable server. Static + data reads go through the fs shim
// (esbuild aliases node:fs), which serves build-time embedded assets.
//
// MCP transport: SDK 1.12's StreamableHTTPServerTransport is Node-only (writes
// to a ServerResponse), so each /mcp POST runs through an InMemoryTransport
// linked pair with a fresh McpServer — same stateless semantics as main
// (sessionIdGenerator: undefined), same tool logic from mcp.ts.
import { buildServer } from './mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { preloadSnapshot } from './snapshot.js';

// Global-scope preload: the snapshot (22k POIs) is parsed once per isolate and
// charged to the 1s startup budget, NOT to the 10ms per-request CPU limit.
preloadSnapshot();

const MAX_BODY = 1024 * 1024;

const STATIC_FILES: Record<string, [string, string]> = {
  '/': ['web/index.html', 'text/html; charset=utf-8'],
  '/privacy': ['web/privacy.html', 'text/html; charset=utf-8'],
  '/terms': ['web/terms.html', 'text/html; charset=utf-8'],
  '/favicon.svg': ['web/favicon.svg', 'image/svg+xml'],
  '/icon-512.png': ['web/icon-512.png', 'image/png'],
};

// In-isolate token bucket, per caller key (30 rps sustained, burst 60) — same
// numbers as src/index.ts.
const buckets = new Map<string, { tokens: number; last: number }>();
function allowRate(key: string): boolean {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: 60, last: now };
  const refill = ((now - b.last) / 1000) * 30;
  b.tokens = Math.min(60, b.tokens + refill);
  b.last = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return true;
}

function keysFor(env: Env): Set<string> {
  return new Set(
    String(env.NEARNOW_API_KEYS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function originsFor(env: Env): Set<string> {
  return new Set(
    String(env.NEARNOW_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function callerKey(req: Request, env: Env): string | null {
  const keys = keysFor(env);
  if (keys.size === 0) return 'dev';
  const auth = req.headers.get('authorization');
  const xkey = req.headers.get('x-api-key');
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const k = bearer ?? (xkey ? xkey.trim() : null);
  return k && keys.has(k) ? k : null;
}

interface Env {
  NEARNOW_API_KEYS?: string;
  NEARNOW_ALLOWED_ORIGINS?: string;
}

async function handleMcp(req: Request, body: unknown): Promise<Response> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  const responses: JSONRPCMessage[] = [];
  clientT.onmessage = (m) => {
    responses.push(m);
  };
  clientT.onerror = (e) => console.error('client transport error:', e);
  await server.connect(serverT);
  await clientT.start();
  const parsed = body as JSONRPCMessage | JSONRPCMessage[];
  const ids = new Set(
    (Array.isArray(parsed) ? parsed : [parsed])
      .map((m) => (m && typeof m === 'object' && 'id' in m ? String((m as { id: unknown }).id) : null))
      .filter((v): v is string => v !== null)
  );
  const msgs = Array.isArray(parsed) ? parsed : [parsed];
  for (const m of msgs) await clientT.send(m);
  // Wait for every response id to come back (tool calls are async inside the server).
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const got = new Set(responses.map((m) => ('id' in m && m.id !== undefined ? String(m.id) : '')));
    if ([...ids].every((id) => got.has(id))) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  await clientT.close();
  await server.close();
  if (responses.length === 0) {
    return new Response(null, { status: 202 });
  }
  const payload = Array.isArray(parsed) ? JSON.stringify(responses) : JSON.stringify(responses[0]);
  return new Response(payload, { headers: { 'content-type': 'application/json' } });
}

async function readBodyJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new Error('body too large');
  return JSON.parse(text || '{}');
}

export async function workerFetch(req: Request, env: Env): Promise<Response> {
  {
    const url = new URL(req.url);
    // W0-18: when served under mcp.locafact.com/nearnow/*, strip the connector
    // prefix so /nearnow/healthz, /nearnow/mcp etc. hit the same handlers.
    const raw = url.pathname;
    if (raw === '/nearnow' || raw.startsWith('/nearnow/')) {
      url.pathname = raw === '/nearnow' ? '/' : raw.slice('/nearnow'.length);
      req = new Request(url, req);
    }
    const path = url.pathname;

    if (req.method === 'GET' && path === '/healthz') {
      return new Response(
        JSON.stringify({ ok: true, service: 'nearnow', version: '0.1.0', runtime: 'cloudflare-workers' }),
        { headers: { 'content-type': 'application/json' } }
      );
    }

    const staticHit = STATIC_FILES[path];
    if (req.method === 'GET' && staticHit) {
      try {
        const body = readFileSync(staticHit[0], 'utf8');
        return new Response(body as string, {
          headers: { 'content-type': staticHit[1], 'cache-control': 'max-age=300' },
        });
      } catch {
        return new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    if (req.method === 'GET' && path === '/icon-512.png') {
      try {
        const body = readFileSync('web/icon-512.png') as Uint8Array;
        return new Response(new Uint8Array(body).buffer as ArrayBuffer, {
          headers: { 'content-type': 'image/png', 'cache-control': 'max-age=300' },
        });
      } catch {
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      }
    }

    if (path !== '/mcp' || req.method !== 'POST') {
      const status = path === '/mcp' ? 405 : 404;
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (status === 405) headers.allow = 'POST';
      return new Response(JSON.stringify({ error: status === 405 ? 'method_not_allowed' : 'not_found' }), {
        status,
        headers,
      });
    }

    const key = callerKey(req, env);
    if (!key) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
      });
    }

    const origin = req.headers.get('origin');
    const allowed = originsFor(env);
    if (origin && allowed.size > 0 && !allowed.has(origin)) {
      return new Response(JSON.stringify({ error: 'origin_not_allowed' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (!allowRate(key)) {
      return new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '1' },
      });
    }

    let parsed: unknown;
    try {
      parsed = await readBodyJson(req);
    } catch {
      return new Response(JSON.stringify({ error: 'invalid_json' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    return handleMcp(req, parsed);
  }
}

// W0-14 → O37: Cloudflare Cron warm-up. Replays the frozen example prompts
// against workerFetch inside the isolate (no HTTP hop, no external auth —
// the request carries the first configured review key; dev-open if none).
// Warms the in-memory response/overpass caches so reviewers get sub-second
// answers. Frequency: hourly (wrangler.jsonc triggers.crons).
interface WarmPrompt {
  id: string;
  frozen?: boolean;
  tool: string;
  args?: Record<string, unknown>;
  expect?: { status?: string };
}

async function cronRpc(
  env: Env,
  id: number,
  method: string,
  params: unknown
): Promise<{ ok: boolean; status: string | null }> {
  const firstKey = String(env.NEARNOW_API_KEYS ?? '')
    .split(',')[0]
    .trim();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (firstKey) headers['x-api-key'] = firstKey;
  const req = new Request('https://cron.warmup.internal/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  try {
    const res = await workerFetch(req, env);
    if (!res.ok) return { ok: false, status: `HTTP ${res.status}` };
    const j = (await res.json()) as {
      result?: { structuredContent?: { status?: string }; isError?: boolean };
      error?: unknown;
    };
    if (j.error) return { ok: false, status: 'rpc_error' };
    const st = j.result?.structuredContent?.status ?? null;
    return { ok: !j.result?.isError, status: st };
  } catch (e) {
    return { ok: false, status: `throw:${String(e).slice(0, 80)}` };
  }
}

export async function cronScheduled(
  _event: { cron: string },
  env: Env,
  _ctx: { waitUntil(p: Promise<unknown>): void }
): Promise<void> {
  const t0 = Date.now();
  let prompts: WarmPrompt[];
  try {
    prompts = JSON.parse(readFileSync('data/prompts.json', 'utf8') as string) as WarmPrompt[];
  } catch {
    console.log('cron-warmup: prompts.json unavailable, skipping');
    return;
  }
  let warmed = 0;
  let soft = 0;
  let failed = 0;
  let nextId = 1;
  for (const p of prompts) {
    if (p.frozen !== true) continue;
    if (p.expect?.status && p.expect.status !== 'OK') continue; // error paths warm nothing
    if (p.tool !== 'search_places' || !p.args) continue;
    const r = await cronRpc(env, nextId++, 'tools/call', { name: p.tool, arguments: p.args });
    if (!r.ok) {
      failed += 1;
      console.log(`cron-warmup: ${p.id} FAILED (${r.status})`);
      continue;
    }
    warmed += 1;
    if (r.status !== 'OK') {
      soft += 1;
      console.log(`cron-warmup: ${p.id} soft (${r.status})`);
    }
    try {
      await cronDetails(env, nextId++, p);
    } catch {
      failed += 1;
    }
  }
  console.log(
    `cron-warmup: done in ${Date.now() - t0}ms — warmed=${warmed} soft=${soft} failed=${failed}`
  );
}

async function cronDetails(env: Env, id: number, p: WarmPrompt): Promise<void> {
  // Re-run search to read the first place_id, then warm its details cache
  // (mirrors the EP-10 chained call in scripts/warmup.mjs).
  const search = await workerFetch(
    mcpRequest(env, id, p.args as Record<string, unknown>),
    env
  );
  if (!search.ok) return;
  const j = (await search.json()) as {
    result?: { structuredContent?: { places?: Array<{ place_id?: string }> } };
  };
  const pid = j.result?.structuredContent?.places?.[0]?.place_id;
  if (!pid) return;
  await cronRpc(env, id + 1000, 'tools/call', {
    name: 'get_place_details',
    arguments: { place_id: pid },
  });
}

function mcpRequest(env: Env, id: number, args: Record<string, unknown>): Request {
  const firstKey = String(env.NEARNOW_API_KEYS ?? '')
    .split(',')[0]
    .trim();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (firstKey) headers['x-api-key'] = firstKey;
  return new Request('https://cron.warmup.internal/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: args }),
  });
}

export default {
  fetch: workerFetch,
  scheduled: cronScheduled,
};

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildServer } from './mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { WEB_DIR } from './paths.js';

const PORT = Number(process.env.PORT || 8787);
const MAX_BODY = 1024 * 1024;

const API_KEYS = new Set(
  (process.env.NEARNOW_API_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);
const ALLOWED_ORIGINS = new Set(
  (process.env.NEARNOW_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

// In-process token bucket, per caller key. 30 rps sustained, burst 60.
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

function callerKey(req: http.IncomingMessage): string | null {
  if (API_KEYS.size === 0) return 'dev';
  const auth = req.headers['authorization'];
  const xkey = req.headers['x-api-key'];
  const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const k = bearer ?? (typeof xkey === 'string' ? xkey.trim() : null);
  if (!k || !API_KEYS.has(k)) return null;
  return k;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? '/';

  if (req.method === 'GET' && url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'nearnow', version: '0.1.0' }));
    return;
  }

  // Static marketing/legal pages — exact whitelist, no filesystem path input.
  const STATIC_FILES: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/privacy': ['privacy.html', 'text/html; charset=utf-8'],
    '/terms': ['terms.html', 'text/html; charset=utf-8'],
    '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
    '/icon-512.png': ['icon-512.png', 'image/png'],
  };
  const staticHit = STATIC_FILES[url.split('?')[0]];
  if (req.method === 'GET' && staticHit) {
    try {
      const body = readFileSync(join(WEB_DIR, staticHit[0]));
      res.writeHead(200, { 'content-type': staticHit[1], 'cache-control': 'max-age=300' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    }
    return;
  }

  if (url.split('?')[0] !== '/mcp') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  // Stateless Streamable HTTP: only POST carries messages.
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' });
    res.end();
    return;
  }

  const key = callerKey(req);
  if (!key) {
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': 'Bearer',
    });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const origin = req.headers['origin'];
  if (typeof origin === 'string' && ALLOWED_ORIGINS.size > 0 && !ALLOWED_ORIGINS.has(origin)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'origin_not_allowed' }));
    return;
  }

  if (!allowRate(key)) {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
    res.end(JSON.stringify({ error: 'rate_limited' }));
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_json' }));
    return;
  }

  // Fresh server + transport per request: no session state survives a call.
  const mcp = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    transport.close();
    mcp.close();
  });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, parsed);
  } catch {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal' }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`nearnow listening on :${PORT} (auth ${API_KEYS.size ? 'on' : 'DEV MODE — no keys required'})`);
});

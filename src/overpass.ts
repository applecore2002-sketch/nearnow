import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TagFilter } from './categories.js';
import { USER_AGENT } from './types.js';

// curl's default fingerprint gets 406 from the Overpass WAF — always use
// fetch with an explicit UA and GET with ?data=. Mirrors are tried in order.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const TTL_MS = 7 * 24 * 3600 * 1000;
const CACHE_DIR = join(process.cwd(), '.cache', 'overpass');
const mem = new Map<string, { expires: number; body: unknown }>();

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export function coords(e: OsmElement): { lat: number; lon: number } | null {
  if (typeof e.lat === 'number' && typeof e.lon === 'number') return { lat: e.lat, lon: e.lon };
  if (e.center) return { lat: e.center.lat, lon: e.center.lon };
  return null;
}

export function haversineM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

function keyOf(query: string): string {
  return createHash('sha256').update(query.replace(/\s+/g, ' ').trim()).digest('hex');
}

async function fetchEndpoint(endpoint: string, query: string, timeoutMs: number): Promise<unknown> {
  const u = new URL(endpoint);
  u.searchParams.set('data', query);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(u, { headers: { 'User-Agent': USER_AGENT }, signal: ac.signal });
    if (!r.ok) throw new Error(`${endpoint} → HTTP ${r.status}`);
    const j = (await r.json()) as { elements?: unknown };
    return j.elements ?? [];
  } finally {
    clearTimeout(t);
  }
}

// Cloudflare Workers runtime detection: live Overpass from Workers egress
// hangs past the 60s request deadline (W0-17 tail evidence), so cap the
// fallback budget hard — 8s single endpoint, no mirror crawl. Node keeps 45s×3.
const IS_WORKERS =
  typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
const DEFAULT_TIMEOUT_MS = IS_WORKERS ? 8000 : 45000;

export async function overpass(
  query: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<OsmElement[]> {
  const key = keyOf(query);
  const m = mem.get(key);
  if (m && m.expires > Date.now()) return m.body as OsmElement[];

  const file = join(CACHE_DIR, `${key}.json`);
  if (existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as { expires: number; body: OsmElement[] };
      if (cached.expires > Date.now()) {
        mem.set(key, cached);
        return cached.body;
      }
    } catch {
      /* fall through to network */
    }
  }

  let body: unknown = null;
  let lastErr: unknown = null;
  const endpoints = IS_WORKERS ? ENDPOINTS.slice(0, 1) : ENDPOINTS;
  for (const ep of endpoints) {
    try {
      body = await fetchEndpoint(ep, query, timeoutMs);
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (body === null) throw lastErr ?? new Error('overpass: all endpoints failed');

  const entry = { expires: Date.now() + TTL_MS, body };
  mem.set(key, entry);
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(entry));
  } catch {
    /* read-only filesystem (serverless) — memory cache still holds */
  }
  return body as OsmElement[];
}

export function aroundQuery(
  filters: TagFilter[],
  lat: number,
  lon: number,
  radius: number
): string {
  const body = filters
    .map((f) => {
      const t = `["${f.k}"="${f.v}"]`;
      return `node(around:${radius},${lat},${lon})${t};way(around:${radius},${lat},${lon})${t};`;
    })
    .join('');
  return `[out:json][timeout:50];(${body});out tags center;`;
}

export function byIdQuery(type: string, id: number): string {
  const t = type === 'relation' ? 'relation' : type === 'way' ? 'way' : 'node';
  return `[out:json][timeout:20];${t}(${id});out tags center;`;
}

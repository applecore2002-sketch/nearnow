import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedLocation } from './types.js';
import { USER_AGENT } from './types.js';

const CACHE_DIR = join(process.cwd(), '.cache');
const CACHE_FILE = join(CACHE_DIR, 'geocode.json');

const cache = new Map<string, ResolvedLocation>();
let lastCall = 0;

// Nominatim usage policy: max 1 request/second, dedicated User-Agent.
async function throttle(): Promise<void> {
  const wait = lastCall + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

// W0-17: hard wall-clock caps — a hung upstream must never hold a request open
// (Workers free tier has no per-request wall guarantee; main had the same gap).
const GEOCODE_TIMEOUT_MS = 8000;

function loadCache(): void {
  // Seed cache (frozen prompt cities): guarantees R9 "first paste succeeds"
  // even if upstream geocoders are unreachable from the host network.
  try {
    if (existsSync(join(process.cwd(), 'data', 'geocode-seed.json'))) {
      const seed = JSON.parse(
        readFileSync(join(process.cwd(), 'data', 'geocode-seed.json'), 'utf8')
      ) as Record<string, ResolvedLocation>;
      for (const [k, v] of Object.entries(seed)) if (!cache.has(k)) cache.set(k, v);
    }
  } catch {
    /* seed is best-effort */
  }
  try {
    if (existsSync(CACHE_FILE)) {
      const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Record<string, ResolvedLocation>;
      for (const [k, v] of Object.entries(raw)) cache.set(k, v);
    }
  } catch {
    /* corrupt cache is fine to drop */
  }
}

function persistCache(): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    /* read-only filesystem (serverless) — caching silently off */
  }
}

loadCache();

async function viaNominatim(area: string): Promise<ResolvedLocation | null> {
  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.searchParams.set('q', area);
  u.searchParams.set('format', 'json');
  u.searchParams.set('limit', '1');
  u.searchParams.set('countrycodes', 'us');
  const r = await fetch(u, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS) });
  if (!r.ok) return null;
  const hits = (await r.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  const h = hits[0];
  if (!h) return null;
  return { lat: +h.lat, lon: +h.lon, label: h.display_name.split(',').slice(0, 3).join(',') };
}

async function viaPhoton(area: string): Promise<ResolvedLocation | null> {
  const u = new URL('https://photon.komoot.io/api');
  u.searchParams.set('q', area);
  u.searchParams.set('limit', '1');
  const r = await fetch(u, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS) });
  if (!r.ok) return null;
  const g = (await r.json()) as {
    features?: Array<{ geometry: { coordinates: [number, number] }; properties: Record<string, string> }>;
  };
  const f = g.features?.[0];
  if (!f) return null;
  const [lon, lat] = f.geometry.coordinates;
  const p = f.properties;
  const label = [p.name, p.city, p.state].filter(Boolean).join(',');
  return { lat, lon, label: label || area };
}

export async function geocode(area: string): Promise<ResolvedLocation | null> {
  const k = area.trim().toLowerCase();
  if (cache.has(k)) return cache.get(k)!;
  await throttle();
  const hit = (await viaNominatim(area).catch(() => null)) ?? (await viaPhoton(area).catch(() => null));
  if (hit) {
    cache.set(k, hit);
    persistCache();
  }
  return hit;
}

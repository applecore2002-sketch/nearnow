import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './paths.js';
import { haversineM, type OsmElement } from './overpass.js';
import { categoryByCode, type CategoryDef } from './categories.js';
import type { ResolvedLocation } from './types.js';

// Phase 2 snapshot backend (ADR-001): serves search queries from the per-state
// Geofabrik extract (data/snapshot/*.jsonl) instead of live Overpass. Live
// Overpass stays as fallback for anything the snapshot misses, and the
// response meta reports which source answered (honesty model).

export interface SnapshotMeta {
  generated: string;
  source: string;
  states: Record<string, number>;
  total: number;
  attribution: string;
}

interface SnapRec {
  placeId: string;
  osmType: 'node';
  osmId: number;
  category: string;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

const CELL = 0.02; // ~2.2km — grid cell side in degrees
const SNAPSHOT_DIR = join(DATA_DIR, 'snapshot');

const grid = new Map<string, SnapRec[]>();
let byId = new Map<string, SnapRec>();
let meta: SnapshotMeta | null = null;

function cellsAround(lat: number, lon: number, radiusM: number): string[] {
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180) || 1);
  const out: string[] = [];
  for (let la = Math.floor((lat - dLat) / CELL); la <= Math.floor((lat + dLat) / CELL); la++) {
    for (let lo = Math.floor((lon - dLon) / CELL); lo <= Math.floor((lon + dLon) / CELL); lo++) {
      out.push(`${la}:${lo}`);
    }
  }
  return out;
}

/** The extract's tag set omits the category key/value pair — reinject it so
 * downstream `categoryOf(tags)` (details path) keeps working. */
function toElement(rec: SnapRec): OsmElement {
  const cat = categoryByCode(rec.category);
  const tags = { ...rec.tags };
  if (cat) for (const f of cat.filters) if (tags[f.k] === undefined) tags[f.k] = f.v;
  return { type: 'node', id: rec.osmId, lat: rec.lat, lon: rec.lon, tags };
}

function load(): boolean {
  if (meta) return true;
  if (process.env.NEARNOW_SNAPSHOT === 'off') return false;
  const mf = join(SNAPSHOT_DIR, 'manifest.json');
  if (!existsSync(mf)) return false;
  try {
    meta = JSON.parse(readFileSync(mf, 'utf8')) as SnapshotMeta;
  } catch {
    return false;
  }
  for (const f of readdirSync(SNAPSHOT_DIR)) {
    if (!f.endsWith('.jsonl')) continue;
    const lines = readFileSync(join(SNAPSHOT_DIR, f), 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as {
          place_id: string;
          cat: string;
          lat: number;
          lon: number;
          tags: Record<string, string>;
        };
        const slash = j.place_id.indexOf('/');
        const rec: SnapRec = {
          placeId: j.place_id,
          osmType: 'node',
          osmId: Number(j.place_id.slice(slash + 1)),
          category: j.cat,
          lat: j.lat,
          lon: j.lon,
          tags: j.tags ?? {},
        };
        const key = `${Math.floor(rec.lat / CELL)}:${Math.floor(rec.lon / CELL)}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(rec);
        else grid.set(key, [rec]);
        byId.set(rec.placeId, rec);
      } catch {
        /* skip malformed line */
      }
    }
  }
  return true;
}

export function snapshotEnabled(): boolean {
  return load();
}

/** Module-init preload for the Workers entry (charges the 1s startup budget,
 * not the 10ms per-request CPU limit). No-op on the node:http server. */
export function preloadSnapshot(): void {
  load();
}

export function snapshotInfo(): SnapshotMeta | null {
  return load() ? meta : null;
}

/** Snapshot-backed search: returns elements within radius, or [] to trigger live fallback. */
export function snapshotAround(
  cat: CategoryDef,
  origin: ResolvedLocation,
  radiusM: number
): OsmElement[] {
  if (!load() || !meta) return [];
  const seen = new Set<string>();
  const out: OsmElement[] = [];
  for (const key of cellsAround(origin.lat, origin.lon, radiusM)) {
    const bucket = grid.get(key);
    if (!bucket) continue;
    for (const rec of bucket) {
      if (seen.has(rec.placeId)) continue;
      seen.add(rec.placeId);
      if (rec.category !== cat.code) continue; // category from extract is authoritative
      if (haversineM(origin, rec) > radiusM) continue;
      out.push(toElement(rec));
    }
  }
  return out;
}

/** Snapshot-backed details, or null to trigger the live Overpass path. */
export function snapshotById(placeId: string): OsmElement | null {
  if (!load()) return null;
  const rec = byId.get(placeId);
  return rec ? toElement(rec) : null;
}

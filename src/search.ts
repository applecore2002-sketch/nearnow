import { CATEGORIES, categoryByCode, categoryOf, type CategoryDef } from './categories.js';
import { geocode } from './geocode.js';
import { resolveHours } from './hours.js';
import { aroundQuery, byIdQuery, coords, haversineM, overpass, type OsmElement } from './overpass.js';
import { snapshotAround, snapshotById, snapshotEnabled, snapshotInfo } from './snapshot.js';
import { ATTRIBUTION, type PlaceCard } from './types.js';

export interface SearchArgs {
  location?: { lat: number; lng: number };
  area?: string;
  category: string;
  radius_m?: number;
  open_now?: boolean;
  limit?: number;
}

export type SearchResponse =
  | {
      status: 'OK';
      query: {
        category: string;
        resolved_location: { label: string; lat: number; lon: number };
        radius_m: number;
        open_now_filter: boolean;
      };
      places: PlaceCard[];
      meta: {
        total_found: number;
        returned: number;
        excluded_closed: number;
        excluded_hours_unknown: number;
        note: string | null;
        attribution: string;
        generated_at: string;
        source: 'osm_snapshot' | 'overpass_live';
        snapshot_date?: string;
      };
    }
  | { status: 'UNKNOWN_AREA'; message: string; attribution: string }
  | { status: 'NO_MATCH'; message: string; attribution: string }
  | { status: 'INVALID_INPUT'; message: string; valid_categories: string[] };

const DEFAULT_RADIUS_M = 3000;
const MAX_RADIUS_M = 20000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

function toCard(
  e: OsmElement,
  cat: CategoryDef,
  origin: { lat: number; lon: number }
): PlaceCard | null {
  const c = coords(e);
  if (!c) return null;
  const tags = e.tags ?? {};
  const name = tags['name'] ?? null;
  const hours = resolveHours(tags, name, cat);
  const hn = tags['addr:housenumber'];
  const st = tags['addr:street'];
  const city = tags['addr:city'];
  const state = tags['addr:state'];
  const pc = tags['addr:postcode'];
  const line1 = [hn, st].filter(Boolean).join(' ');
  const line2 = [city, state, pc].filter(Boolean).join(' ');
  const address = [line1, line2].filter(Boolean).join(', ') || null;
  return {
    place_id: `osm:${e.type}/${e.id}`,
    name,
    category: cat.code,
    lat: c.lat,
    lon: c.lon,
    distance_m: haversineM(origin, c),
    address,
    hours,
    brand: tags['brand'] ?? null,
    operator: tags['operator'] ?? null,
    wheelchair: tags['wheelchair'] ?? null,
    website: tags['website'] ?? tags['contact:website'] ?? null,
    phone: tags['phone'] ?? tags['contact:phone'] ?? null,
  };
}

export async function searchPlaces(args: SearchArgs): Promise<SearchResponse> {
  const cat = categoryByCode(args.category);
  if (!cat) {
    return {
      status: 'INVALID_INPUT',
      message: `Unknown category "${args.category}".`,
      valid_categories: CATEGORIES.map((c) => c.code),
    };
  }
  if (!args.location && !args.area) {
    return {
      status: 'INVALID_INPUT',
      message: 'Provide either location {lat,lng} or area (e.g. "Pasadena, CA").',
      valid_categories: CATEGORIES.map((c) => c.code),
    };
  }

  let origin: { lat: number; lon: number; label: string };
  if (args.location) {
    origin = {
      lat: args.location.lat,
      lon: args.location.lng,
      label: `${args.location.lat.toFixed(4)}, ${args.location.lng.toFixed(4)}`,
    };
  } else {
    const g = await geocode(args.area!);
    if (!g) {
      return {
        status: 'UNKNOWN_AREA',
        message:
          `Could not resolve area "${args.area}". ` +
          'Retry with a clearer form like "City, ST" (e.g. "Pasadena, CA") or pass exact coordinates.',
        attribution: ATTRIBUTION,
      };
    }
    origin = g;
  }

  const radius = Math.min(Math.max(args.radius_m ?? DEFAULT_RADIUS_M, 100), MAX_RADIUS_M);
  const limit = Math.min(Math.max(args.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const openNow = args.open_now === true;

  // Phase 2 (ADR-001): serve from the per-state snapshot when it has data for
  // this area; live Overpass remains the fallback for everything it misses
  // (and as calibration source). Response meta reports which one answered.
  let elements: OsmElement[];
  let source: 'osm_snapshot' | 'overpass_live';
  let snapshotDate: string | undefined;
  const snap = snapshotEnabled() ? snapshotAround(cat, origin, radius) : [];
  if (snap.length > 0) {
    elements = snap;
    source = 'osm_snapshot';
    snapshotDate = snapshotInfo()?.generated;
  } else {
    // Fallback budget is capped (8s on Workers); if live Overpass is
    // unreachable, return an honest error instead of hanging past deadline.
    try {
      elements = await overpass(aroundQuery(cat.filters, origin.lat, origin.lon, radius));
      source = 'overpass_live';
    } catch {
      return {
        status: 'NO_MATCH',
        message:
          `No snapshot coverage for ${origin.label}, and the live OSM fallback ` +
          'is currently unavailable (upstream timeout). Try an area inside the ' +
          'covered states (CA/TX/NY) or retry later.',
        attribution: ATTRIBUTION,
      };
    }
  }
  const cards: PlaceCard[] = [];
  for (const e of elements) {
    const card = toCard(e, cat, origin);
    if (card) cards.push(card);
  }
  cards.sort((a, b) => (a.distance_m ?? 0) - (b.distance_m ?? 0));

  let excludedClosed = 0;
  let excludedUnknown = 0;
  let visible = cards;
  if (openNow) {
    // Honesty rule: never report unknown hours as open.
    visible = cards.filter((p) => {
      if (p.hours.open_now === true) return true;
      if (p.hours.open_now === null) excludedUnknown++;
      else excludedClosed++;
      return false;
    });
  }

  if (cards.length === 0) {
    return {
      status: 'NO_MATCH',
      message:
        `No ${cat.label.toLowerCase()} found within ${radius}m of ${origin.label}. ` +
        `Try a larger radius_m (up to ${MAX_RADIUS_M}).`,
      attribution: ATTRIBUTION,
    };
  }

  const places = visible.slice(0, limit);
  const note =
    openNow && places.length === 0
      ? 'All nearby matches are either closed or have unknown hours. Retry without open_now, or widen radius_m.'
      : null;

  return {
    status: 'OK',
    query: {
      category: cat.code,
      resolved_location: { label: origin.label, lat: origin.lat, lon: origin.lon },
      radius_m: radius,
      open_now_filter: openNow,
    },
    places,
    meta: {
      total_found: cards.length,
      returned: places.length,
      excluded_closed: excludedClosed,
      excluded_hours_unknown: excludedUnknown,
      note,
      attribution: ATTRIBUTION,
      generated_at: new Date().toISOString(),
      source,
      ...(snapshotDate ? { snapshot_date: snapshotDate } : {}),
    },
  };
}

export interface DetailsResponse {
  status: 'OK' | 'NOT_FOUND' | 'INVALID_INPUT';
  place?: PlaceCard & { osm_url: string };
  message?: string;
  attribution: string;
}

export async function getPlaceDetails(placeId: string): Promise<DetailsResponse> {
  if (!placeId.startsWith('osm:')) {
    return {
      status: 'INVALID_INPUT',
      message: 'place_id must look like "osm:node/123", "osm:way/456" or "osm:relation/789".',
      attribution: ATTRIBUTION,
    };
  }
  const rest = placeId.slice(4);
  const slash = rest.indexOf('/');
  if (slash <= 0) {
    return {
      status: 'INVALID_INPUT',
      message: 'place_id must look like "osm:node/123".',
      attribution: ATTRIBUTION,
    };
  }
  const type = rest.slice(0, slash);
  if (type !== 'node' && type !== 'way' && type !== 'relation') {
    return {
      status: 'INVALID_INPUT',
      message: 'place_id type must be node, way or relation.',
      attribution: ATTRIBUTION,
    };
  }
  const id = Number(rest.slice(slash + 1));
  if (!Number.isInteger(id) || id <= 0) {
    return {
      status: 'INVALID_INPUT',
      message: 'place_id must contain a positive numeric OSM id.',
      attribution: ATTRIBUTION,
    };
  }

  // Snapshot first (Phase 2); live Overpass by id as fallback / calibration.
  const snapEl = snapshotEnabled() ? snapshotById(placeId) : null;
  let e = snapEl;
  if (!e) {
    try {
      e = (await overpass(byIdQuery(type, id)))[0];
    } catch {
      return {
        status: 'NOT_FOUND',
        message:
          `No snapshot entry for ${placeId}, and the live OSM fallback is ` +
          'currently unavailable (upstream timeout). Retry later.',
        attribution: ATTRIBUTION,
      };
    }
  }
  const c = e ? coords(e) : null;
  const tags = e?.tags ?? {};
  const catCode = categoryOf(tags);
  const cat = catCode ? categoryByCode(catCode) : undefined;
  if (!e || !c || !cat) {
    return {
      status: 'NOT_FOUND',
      message: `No supported place found for ${placeId}. Use search_places first to get a valid place_id.`,
      attribution: ATTRIBUTION,
    };
  }

  const card = toCard(e, cat, c);
  if (!card) {
    return { status: 'NOT_FOUND', message: 'No coordinates for this place.', attribution: ATTRIBUTION };
  }
  return {
    status: 'OK',
    place: { ...card, osm_url: `https://www.openstreetmap.org/${type}/${id}` },
    attribution: ATTRIBUTION,
  };
}

export function listCategories() {
  return {
    categories: CATEGORIES.map((c) => ({
      code: c.code,
      label: c.label,
      description: c.description_en,
      example_query: c.example_query,
    })),
    attribution: ATTRIBUTION,
  };
}

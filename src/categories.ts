import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './paths.js';

/** Structured OSM tag filter — never assembled from free text. */
export interface TagFilter {
  k: string;
  v: string;
}

export interface CategoryDef {
  code: string;
  label: string;
  description_en: string;
  example_query: string;
  filters: TagFilter[];
  /** Applied when a place has no explicit opening_hours; always reported as `estimated`. */
  default_hours?: string;
}

export const CATEGORIES: CategoryDef[] = [
  {
    code: 'pharmacy',
    label: 'Pharmacy',
    description_en:
      'Pharmacies and drugstores (chains and independent). Best bet for "24-hour pharmacy near me".',
    example_query: 'Find a pharmacy near Pasadena, CA that is open now',
    filters: [{ k: 'amenity', v: 'pharmacy' }],
  },
  {
    code: 'supermarket',
    label: 'Supermarket / grocery',
    description_en: 'Supermarkets and grocery stores.',
    example_query: 'Nearest supermarket to downtown Los Angeles and its opening hours',
    filters: [{ k: 'shop', v: 'supermarket' }],
  },
  {
    code: 'fuel',
    label: 'Gas station',
    description_en:
      'Fuel / gas stations. Most US stations are 24/7; hours are reported as estimated unless the station lists explicit hours.',
    example_query: 'Find gas stations within 2 miles of me',
    filters: [{ k: 'amenity', v: 'fuel' }],
    default_hours: '24/7',
  },
  {
    code: 'ev_charging',
    label: 'EV charging station',
    description_en:
      'Electric-vehicle charging points (Tesla Supercharger, Electrify America, etc.). Most are accessible 24/7 (estimated unless stated).',
    example_query: 'Find EV chargers near San Gabriel, CA',
    filters: [{ k: 'amenity', v: 'charging_station' }],
    default_hours: '24/7',
  },
  {
    code: 'library',
    label: 'Public library',
    description_en: 'Public libraries.',
    example_query: 'Which libraries near Alhambra are open on Saturday?',
    filters: [{ k: 'amenity', v: 'library' }],
  },
  {
    code: 'post_office',
    label: 'Post office',
    description_en: 'Post offices and postal service points.',
    example_query: 'Nearest post office to Arcadia, CA and its hours',
    filters: [{ k: 'amenity', v: 'post_office' }],
  },
];

interface ChainRule {
  brand: string;
  match: string[];
  hours: string;
  verified: boolean;
  source?: string;
  note?: string;
}

function loadChainRules(): ChainRule[] {
  try {
    const raw = JSON.parse(readFileSync(join(DATA_DIR, 'chain-hours.json'), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

const chainRules = loadChainRules();

/** Chain-default hours; only rules explicitly verified=true are ever applied. */
export function chainHoursFor(name: string | null): string | null {
  if (!name) return null;
  const n = name.toLowerCase();
  for (const r of chainRules) {
    if (!r.verified) continue;
    if (r.match.some((m) => n.includes(m))) return r.hours;
  }
  return null;
}

export function categoryOf(tags: Record<string, string>): string | null {
  for (const c of CATEGORIES) {
    for (const f of c.filters) {
      if (tags[f.k] === f.v) return c.code;
    }
  }
  return null;
}

export function categoryByCode(code: string): CategoryDef | undefined {
  return CATEGORIES.find((c) => c.code === code);
}

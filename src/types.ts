export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface ResolvedLocation extends GeoPoint {
  label: string;
}

export type HoursConfidence = 'confirmed' | 'estimated' | 'unknown';

export interface HoursEval {
  text: string;
  confidence: HoursConfidence;
  open_now: boolean | null;
  next_change: string | null;
}

export interface PlaceCard {
  place_id: string;
  name: string | null;
  category: string;
  lat: number;
  lon: number;
  distance_m: number | null;
  address: string | null;
  hours: HoursEval;
  brand: string | null;
  operator: string | null;
  wheelchair: string | null;
  website: string | null;
  phone: string | null;
}

export const ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';
export const USER_AGENT =
  'NearNow/0.1 (MCP connector for public places; contact: applecore2002@gmail.com)';

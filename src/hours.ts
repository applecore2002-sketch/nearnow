import OpeningHoursRaw from "opening_hours";
import { chainHoursFor, type CategoryDef } from './categories.js';
import type { HoursEval } from './types.js';

// Workers build (W0-17): static ESM import replaces the createRequire hack —
// node:module.createRequire(import.meta.url) has no URL in workerd.
// opening_hours has no bundled types; CommonJS module. The library evaluates a
// Date using its LOCAL components (system timezone), ignoring any timezone
// hint — verified experimentally. We therefore feed it a fake Date whose local
// components are the POI's wall-clock time.
type OpeningHours = {
  getState: (d: Date) => boolean;
  getNextChange: (d: Date) => Date | undefined;
};
const OH = OpeningHoursRaw as unknown as new (expr: string) => OpeningHours;

// v1 is US-first; all POIs are evaluated in US Pacific time. Per-POI timezone
// lookup (e.g. tz-lookup) is a v2 concern once non-US coverage matters.
const TZ = 'America/Los_Angeles';

function make(expr: string): OpeningHours | null {
  try {
    return new OH(expr);
  } catch {
    return null;
  }
}

interface WallClock {
  parts: { y: number; mo: number; d: number; h: number; mi: number; s: number };
  asUTCms: number;
}

function wallClockInTZ(d: Date, tz: string): WallClock {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(d)) p[part.type] = part.value;
  const parts = {
    y: +p.year,
    mo: +p.month - 1,
    d: +p.day,
    h: +p.hour % 24,
    mi: +p.minute,
    s: +p.second,
  };
  return { parts, asUTCms: Date.UTC(parts.y, parts.mo, parts.d, parts.h, parts.mi, parts.s) };
}

function evaluate(expr: string, confidence: 'confirmed' | 'estimated'): HoursEval {
  const oh = make(expr);
  if (!oh) {
    return { text: expr, confidence: 'unknown', open_now: null, next_change: null };
  }

  const now = new Date();
  const wc = wallClockInTZ(now, TZ);

  // Goal: a Date whose LOCAL components equal the POI wall clock.
  // local = utc - getTimezoneOffset(); so shift the UTC timestamp by the offset.
  const offsetMin = now.getTimezoneOffset();
  const fakeLocal = new Date(wc.asUTCms + offsetMin * 60000);

  // PT wall clock pretending to be UTC vs the real instant → PT UTC-offset (e.g. +7h in PDT).
  // Truncated to whole seconds so the offset carries no sub-second residue.
  const delta = Math.floor(now.getTime() / 1000) * 1000 - wc.asUTCms;
  // Convert a library Date (local components = PT wall) back to a real instant:
  // utc = local - offsetMin, so wall-as-UTC = lib + (-offsetMin); real = wall-as-UTC + delta.
  const toReal = (lib: Date): number => lib.getTime() - offsetMin * 60000 + delta;

  let open_now: boolean | null = null;
  let next_change: string | null = null;
  try {
    open_now = oh.getState(fakeLocal);
  } catch {
    open_now = null;
  }
  try {
    const nc = oh.getNextChange(fakeLocal);
    if (nc) next_change = new Date(toReal(nc)).toISOString();
  } catch {
    /* expressions like 24/7 may expose no next change */
  }
  return { text: expr, confidence, open_now, next_change };
}

/** Resolution order: explicit OSM hours → verified chain default → category default → unknown. */
export function resolveHours(
  tags: Record<string, string>,
  name: string | null,
  cat: Pick<CategoryDef, 'default_hours'>
): HoursEval {
  const explicit = tags['opening_hours'];
  if (explicit) return evaluate(explicit, 'confirmed');
  const chain = chainHoursFor(name);
  if (chain) return evaluate(chain, 'estimated');
  if (cat.default_hours) return evaluate(cat.default_hours, 'estimated');
  return { text: 'unknown', confidence: 'unknown', open_now: null, next_change: null };
}

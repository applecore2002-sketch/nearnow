// Domain-level smoke: geocode + Overpass + hours evaluation (live network).
import { getPlaceDetails, listCategories, searchPlaces } from '../src/search.js';

function ptWallClock(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

const now = new Date();
console.log(`[smoke] UTC ${now.toISOString()} | PT ${ptWallClock(now)}`);

console.log('\n[list_categories]');
console.log(JSON.stringify(listCategories()).slice(0, 300) + '…');

console.log('\n[search] pharmacy near Pasadena, CA (radius 3km)');
const r = await searchPlaces({ area: 'Pasadena, CA', category: 'pharmacy', radius_m: 3000, limit: 5 });
console.log(JSON.stringify(r, null, 2).slice(0, 4000));

if (r.status === 'OK' && r.places.length > 0) {
  console.log(`\n[details] ${r.places[0].place_id}`);
  const d = await getPlaceDetails(r.places[0].place_id);
  console.log(JSON.stringify(d, null, 2).slice(0, 2000));
}

console.log('\n[search] ev_charging near San Gabriel, CA open_now=true');
const r2 = await searchPlaces({ area: 'San Gabriel, CA', category: 'ev_charging', open_now: true, limit: 3 });
console.log(JSON.stringify(r2, null, 2).slice(0, 2500));

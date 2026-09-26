// One-shot check: the chain-default hours path (verified=true rules only).
import { resolveHours } from '../src/hours.js';
import { categoryByCode, chainHoursFor } from '../src/categories.js';

const cat = categoryByCode('supermarket')!;
const cases: Array<[string | null, Record<string, string>]> = [
  ['Trader Joe\'s', {}],           // verified chain, no OSM hours → estimated 08:00-21:00
  ['Whole Foods Market', {}],      // verified=false rule → must stay unknown
  ['Ralphs', { opening_hours: 'Mo-Su 07:00-22:00' }], // explicit OSM wins → confirmed
  ['Random Independent Grocer', {}], // no match → unknown
];

for (const [name, tags] of cases) {
  const r = resolveHours(tags, name, cat);
  console.log(
    `${(name ?? 'null').padEnd(28)} chain=${String(chainHoursFor(name))?.padEnd(22)} → ${r.confidence.padEnd(10)} open=${String(r.open_now).padEnd(5)} ${r.text}`
  );
}

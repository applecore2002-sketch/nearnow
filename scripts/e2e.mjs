// End-to-end MCP protocol test: talks to the running HTTP server exactly the
// way an MCP client (Muse / Grok / an inspector) would.
const BASE = process.env.NEARNOW_URL || 'http://127.0.0.1:8799';
const M = 'application/json';
const ACCEPT = 'application/json, text/event-stream';

let nextId = 1;
async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': M, accept: ACCEPT },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  if (ct.includes('text/event-stream')) {
    // take the first data: line
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    return { status: res.status, ct, body: JSON.parse(line.slice(5)) };
  }
  return { status: res.status, ct, body: JSON.parse(text) };
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

console.log('[1] initialize');
const init = await rpc('initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'nearnow-e2e', version: '0.1.0' },
});
assert(init.body.result?.serverInfo?.name === 'nearnow', 'server reports nearnow');
assert(init.body.result?.capabilities?.tools != null, 'tools capability advertised');

console.log('[2] tools/list');
const list = await rpc('tools/list', {});
const names = (list.body.result.tools || []).map((t) => t.name).sort();
console.log('  tools:', names.join(', '));
assert(JSON.stringify(names) === JSON.stringify(['get_place_details', 'list_categories', 'search_places']), 'exactly 3 tools');

console.log('[3] tools/call search_places (Pasadena pharmacy)');
const call = await rpc('tools/call', {
  name: 'search_places',
  arguments: { area: 'Pasadena, CA', category: 'pharmacy', radius_m: 3000, limit: 3 },
});
const r = call.body.result;
assert(!r.isError, 'call is not an error');
const sc = r.structuredContent;
assert(sc.status === 'OK', 'status OK');
assert(sc.places.length >= 1, `returned ${sc.places.length} place(s)`);
const p0 = sc.places[0];
console.log(`  first: ${p0.name} @ ${p0.address ?? 'no addr'} (${p0.distance_m}m, hours=${p0.hours.text}, open=${p0.hours.open_now}, conf=${p0.hours.confidence})`);
assert(typeof p0.place_id === 'string' && p0.place_id.startsWith('osm:'), 'place_id format');
assert(typeof p0.hours.open_now === 'boolean' || p0.hours.open_now === null, 'open_now is tri-state');

console.log('[4] tools/call list_categories');
const cats = await rpc('tools/call', { name: 'list_categories', arguments: {} });
const codes = cats.body.result.structuredContent.categories.map((c) => c.code);
assert(codes.length === 6, `6 categories: ${codes.join(',')}`);

console.log('[5] tools/call search_places open_now=true (supermarket, LA)');
const open = await rpc('tools/call', {
  name: 'search_places',
  arguments: { area: 'Los Angeles, CA', category: 'supermarket', open_now: true, limit: 3, radius_m: 5000 },
});
const osc = open.body.result.structuredContent;
console.log(`  status=${osc.status} returned=${osc.places?.length ?? 0} excluded_closed=${osc.meta?.excluded_closed} excluded_unknown=${osc.meta?.excluded_hours_unknown}`);
assert(osc.status === 'OK', 'status OK');
for (const p of osc.places ?? []) {
  assert(p.hours.open_now === true, `${p.name}: open_now strictly true (no guessing)`);
}

console.log('[6] invalid category → INVALID_INPUT soft-landing');
const bad = await rpc('tools/call', {
  name: 'search_places',
  arguments: { area: 'Pasadena, CA', category: 'hospital' },
});
assert(bad.body.result.isError === true, 'isError true');
assert(bad.body.result.structuredContent.status === 'INVALID_INPUT', 'INVALID_INPUT status');
assert(Array.isArray(bad.body.result.structuredContent.valid_categories), 'valid_categories returned');

console.log('[7] unresolvable area → UNKNOWN_AREA (soft result, not error)');
const unk = await rpc('tools/call', {
  name: 'search_places',
  arguments: { area: 'Xyzzyville, ZZ', category: 'pharmacy' },
});
const usc = unk.body.result.structuredContent;
console.log(`  status=${usc?.status}`);
assert(usc?.status === 'UNKNOWN_AREA', 'UNKNOWN_AREA status');
assert(unk.body.result.isError === false, 'soft result is not isError');

console.log('\nALL E2E CHECKS PASSED');

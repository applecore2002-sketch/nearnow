// In-process test of the EdgeOne function entry (edgeone-dist build):
// constructs web-standard Requests exactly like the EdgeOne runtime would and
// asserts MCP protocol behavior. Run after `npm run build:edgeone`.
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { default: onRequest } = await import(
  pathToFileURL(join(root, 'edgeone-dist', 'cloud-functions', 'mcp', 'index.js')).href
);

let nextId = 1;
async function callFn(method, params) {
  const req = new Request('https://nearnow.paper.ac.cn/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  const res = await onRequest({ request: req });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

console.log('[1] initialize');
const init = await callFn('initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'edgeone-selftest', version: '0' },
});
assert(init.body?.result?.serverInfo?.name === 'nearnow', 'server reports nearnow');
assert(init.body?.result?.capabilities?.tools != null, 'tools capability advertised');

console.log('[2] tools/list');
const list = await callFn('tools/list', {});
const names = (list.body?.result?.tools || []).map((t) => t.name).sort();
console.log('  tools:', names.join(', '));
assert(JSON.stringify(names) === JSON.stringify(['get_place_details', 'list_categories', 'search_places']), 'exactly 3 tools');

console.log('[3] tools/call search_places (Pasadena pharmacy)');
const call = await callFn('tools/call', {
  name: 'search_places',
  arguments: { area: 'Pasadena, CA', category: 'pharmacy', radius_m: 3000, limit: 3 },
});
const r = call.body?.result;
assert(r && r.isError === false, 'call is not an error');
const sc = r.structuredContent;
assert(sc.status === 'OK', 'status OK');
assert(sc.places.length >= 1, `returned ${sc.places.length} place(s)`);
const p0 = sc.places[0];
console.log(`  first: ${p0.name} @ ${p0.address ?? 'no addr'} (${p0.distance_m}m, open=${p0.hours.open_now}, conf=${p0.hours.confidence})`);
assert(typeof p0.place_id === 'string' && p0.place_id.startsWith('osm:'), 'place_id format');
assert(typeof p0.hours.open_now === 'boolean' || p0.hours.open_now === null, 'open_now is tri-state');

console.log('[4] tools/call list_categories');
const cats = await callFn('tools/call', { name: 'list_categories', arguments: {} });
const codes = cats.body?.result?.structuredContent?.categories?.map((c) => c.code);
assert(codes.length === 6, `6 categories: ${codes.join(',')}`);

console.log('[5] notifications/initialized -> 202 empty');
const req5 = new Request('https://nearnow.paper.ac.cn/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
});
const res5 = await onRequest({ request: req5 });
assert(res5.status === 202, '202 for notifications');

console.log('[6] invalid category -> INVALID_INPUT with isError');
const bad = await callFn('tools/call', { name: 'search_places', arguments: { area: 'Pasadena, CA', category: 'dentist' } });
assert(bad.body?.result?.isError === true, 'isError true');
assert(bad.body?.result?.structuredContent?.status === 'INVALID_INPUT', 'INVALID_INPUT status');
assert(Array.isArray(bad.body?.result?.structuredContent?.valid_categories), 'valid_categories returned');

console.log('[7] unknown method -> -32601');
const unknown = await callFn('resources/list', {});
assert(unknown.body?.error?.code === -32601, '-32601 for unknown method');

console.log('[8] unknown tool -> -32602');
const ut = await callFn('tools/call', { name: 'nope', arguments: {} });
assert(ut.body?.error?.code === -32602, '-32602 for unknown tool');

console.log('[9] GET /mcp -> 405');
const res9 = await onRequest({ request: new Request('https://x/mcp', { method: 'GET' }) });
assert(res9.status === 405, '405 for GET');

console.log('[10] healthz function');
const hz = await import(pathToFileURL(join(root, 'edgeone-dist', 'cloud-functions', 'healthz', 'index.js')).href);
const res10 = await hz.default({ request: new Request('https://x/healthz') });
const hb = await res10.json();
assert(hb.ok === true && hb.service === 'nearnow', 'healthz ok');

console.log('\nALL EDGEONE FUNCTION CHECKS PASSED');

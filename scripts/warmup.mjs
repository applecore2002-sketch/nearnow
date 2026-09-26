// Cache warm-up (W0-14, T-day prerequisite): replays the canonical example
// prompts from data/prompts.json against a running NearNow server so the
// disk cache (.cache/) is hot before real traffic. Reviewers pasting the
// frozen example prompts then get sub-second answers instead of ~20s cold calls.
//
// Scope: the "✓ subset" = every search_places prompt expecting status OK,
// plus a chained get_place_details on the first result of each (warms the
// details cache the way EP-10 does). Error-path prompts (INVALID_INPUT /
// UNKNOWN_AREA) do not warm useful caches and are skipped unless
// WARMUP_INCLUDE_SOFT=1. When PM freezes the 8 submission prompts, update
// data/prompts.json — this script picks the subset up automatically.
//
// Usage:
//   node scripts/warmup.mjs                        # local dev server
//   NEARNOW_URL=https://host NEARNOW_API_KEY=... node scripts/warmup.mjs
// Exit 0 on success; 1 only on transport-level failure (server down / HTTP
// error / auth rejected). Soft results are logged, not failures — warming
// writes the cache regardless; correctness is regression.mjs's job.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.NEARNOW_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const API_KEY = process.env.NEARNOW_API_KEY || '';
const DELAY_MS = Number(process.env.WARMUP_DELAY_MS || 500);
const INCLUDE_SOFT = process.env.WARMUP_INCLUDE_SOFT === '1';

const prompts = JSON.parse(readFileSync(join(root, 'data', 'prompts.json'), 'utf8'));

function headers() {
  const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (API_KEY) h.authorization = `Bearer ${API_KEY}`;
  return h;
}

async function healthy() {
  try {
    const r = await fetch(`${BASE}/healthz`);
    return r.ok;
  } catch {
    return false;
  }
}

if (!(await healthy())) {
  console.error(`WARMUP FAIL: no server at ${BASE}`);
  process.exit(1);
}

let nextId = 1;
async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  if (res.status === 401) throw new Error('401 unauthorized — check NEARNOW_API_KEY');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    return JSON.parse((line ?? 'data:{}').slice(5));
  }
  return JSON.parse(text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const warmable = prompts.filter((p) => {
  if (p.tool === 'search_places') {
    if (p.expect?.status === 'OK') return true;
    if (INCLUDE_SOFT && p.expect?.status) return true;
  }
  return false;
});

if (warmable.length === 0) {
  console.error('WARMUP FAIL: no warmable prompts in data/prompts.json');
  process.exit(1);
}

const failures = [];
let warmed = 0;

for (const p of warmable) {
  const t0 = Date.now();
  try {
    const body = await rpc('tools/call', { name: p.tool, arguments: p.args });
    const sc = body.result?.structuredContent;
    const status = sc?.status ?? (body.result?.isError ? 'ERROR' : 'OK');
    const n = Array.isArray(sc?.places) ? sc.places.length : (sc?.place ? 1 : 0);
    console.log(`WARM  ${p.id.padEnd(6)} ${String(Date.now() - t0).padStart(6)}ms  ${status}  results=${n}`);
    if (status === 'ERROR') {
      failures.push(`${p.id}:${status}`);
      continue;
    }
    warmed += 1;
    // Chain a details call on the first result (mirrors EP-10) when not already covered.
    const covered = prompts.some(
      (q) => q.tool === 'get_place_details' && q.args?.place_id !== '$FIRST'
    );
    const first = Array.isArray(sc?.places) ? sc.places[0]?.place_id : null;
    if (first && !covered) {
      const t1 = Date.now();
      await rpc('tools/call', { name: 'get_place_details', arguments: { place_id: first } });
      console.log(`WARM  ${p.id + ':details'.padEnd(6)} ${String(Date.now() - t1).padStart(6)}ms  details`);
    }
  } catch (e) {
    failures.push(`${p.id}:${String(e instanceof Error ? e.message : e).slice(0, 100)}`);
    console.log(`FAIL  ${p.id}  ${String(Date.now() - t0).padStart(6)}ms`);
  }
  await sleep(DELAY_MS); // be gentle with Overpass upstreams
}

if (failures.length > 0) {
  console.error(`\nWARMUP FAIL: ${warmed} warmed, ${failures.length} transport errors -> ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`\nWARMUP OK: ${warmed}/${warmable.length} prompts warmed at ${BASE}`);

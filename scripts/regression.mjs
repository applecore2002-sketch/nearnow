// Prompt regression (G1 discipline): runs the canonical example prompts from
// data/prompts.json against the MCP server over HTTP, cold-call semantics.
// Start the server first:  PORT=8799 npm run serve   (then)   npm run regression
// Exit 1 on any failure.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.NEARNOW_URL || 'http://127.0.0.1:8799';
const M = 'application/json';
const ACCEPT = 'application/json, text/event-stream';

const prompts = JSON.parse(readFileSync(join(root, 'data', 'prompts.json'), 'utf8'));

async function healthy() {
  try {
    const r = await fetch(`${BASE}/healthz`);
    return r.ok;
  } catch {
    return false;
  }
}

if (!(await healthy())) {
  console.error(`FAIL: no server at ${BASE}. Start it first:  PORT=8799 npm run serve`);
  process.exit(1);
}

let nextId = 1;
async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': M, accept: ACCEPT },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 150)}`);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    return JSON.parse((line ?? 'data:{}').slice(5));
  }
  return JSON.parse(text);
}

const failures = [];
let firstPlaceId = null;

for (const p of prompts) {
  const t0 = Date.now();
  const args = { ...p.args };
  if (args.place_id === '$FIRST') {
    if (!firstPlaceId) {
      failures.push(p.id);
      console.log(`FAIL  ${p.id}  no earlier result to take place_id from`);
      continue;
    }
    args.place_id = firstPlaceId;
  }
  let problems = [];
  let ms = 0;
  try {
    const body = await rpc('tools/call', { name: p.tool, arguments: args });
    ms = Date.now() - t0;
    const result = body.result;
    const sc = result?.structuredContent;
    const isError = result?.isError === true;
    problems = [];
    if (p.expect.isError !== undefined && isError !== p.expect.isError) {
      problems.push(`isError=${isError} want ${p.expect.isError}`);
    }
    if (p.expect.status && sc?.status !== p.expect.status) {
      problems.push(`status=${sc?.status} want ${p.expect.status}`);
    }
    const places = Array.isArray(sc?.places) ? sc.places : [];
    if (p.expect.min_results !== undefined && places.length < p.expect.min_results) {
      problems.push(`results=${places.length} want >=${p.expect.min_results}`);
    }
    if (p.expect.open_now_strict) {
      for (const pl of places) {
        if (pl.hours?.open_now !== true) {
          problems.push(`${pl.name ?? pl.place_id}: open_now=${pl.hours?.open_now} (must be true or excluded)`);
          break;
        }
      }
    }
    if (p.expect.has_hours_text) {
      for (const pl of places) {
        if (typeof pl.hours?.text !== 'string') {
          problems.push(`${pl.name ?? pl.place_id}: hours.text missing`);
          break;
        }
      }
    }
    if (p.expect.osm_url && !sc?.place?.osm_url) problems.push('place.osm_url missing');
    if (p.expect.valid_categories && !Array.isArray(sc?.valid_categories)) {
      problems.push('valid_categories missing');
    }
    if (!firstPlaceId && places[0]?.place_id) firstPlaceId = places[0].place_id;
  } catch (e) {
    ms = Date.now() - t0;
    problems = [String(e instanceof Error ? e.message : e).slice(0, 120)];
  }
  const pass = problems.length === 0;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${p.id}  ${String(ms).padStart(6)}ms  ${p.prompt.slice(0, 66)}` +
      (pass ? '' : '\n      -> ' + problems.join(' | '))
  );
  if (!pass) failures.push(p.id);
}

console.log(
  failures.length === 0
    ? `\nREGRESSION PASS ${prompts.length - failures.length}/${prompts.length}`
    : `\nREGRESSION FAIL: ${failures.join(', ')}`
);
process.exit(failures.length === 0 ? 0 : 1);

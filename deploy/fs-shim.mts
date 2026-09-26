// In-memory node:fs replacement for the Workers bundle (W0-17).
// esbuild aliases `node:fs` to this module; all file content comes from
// dist-cloudflare/assets.gen.js (generated at build time by deploy/build.mjs).
// Rationale: Workers has no real filesystem; NearNow's runtime reads are
// config, snapshot data and static pages — all known at build time.

import { TEXT, BIN } from '../dist-cloudflare/assets.gen.js';

type Data = string | Uint8Array;

const FILES = new Map<string, Data>();
for (const [k, v] of Object.entries(TEXT)) FILES.set(k, v);
for (const [k, v] of Object.entries(BIN)) FILES.set(k, hexToBytes(v));

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const decoder = new TextDecoder('utf-8');

function normalize(p: unknown): string {
  let s = String(p);
  s = s.replace(/\\/g, '/');
  if (s.startsWith('file://')) s = s.slice('file://'.length);
  while (s.startsWith('/')) s = s.slice(1);
  return s;
}

/** Suffix match: absolute cwd-prefixed paths must still resolve to bundle keys. */
function findKey(p: unknown): string | undefined {
  const n = normalize(p);
  if (FILES.has(n)) return n;
  for (const k of FILES.keys()) {
    if (n.endsWith(k)) return k;
  }
  // directory-style query, e.g. ".../data/snapshot" or "data"
  for (const k of FILES.keys()) {
    if (k.startsWith(n.endsWith('/') ? n : n + '/')) return k;
  }
  return undefined;
}

function isDirKey(key: string, query: string): boolean {
  const n = normalize(query).replace(/\/+$/, '');
  return key.startsWith(n.endsWith('/') ? n : n + '/');
}

export function readFileSync(path: unknown, enc?: unknown): string | Uint8Array {
  const key = findKey(path);
  if (key === undefined) {
    const err = new Error(`ENOENT: no such file or directory, open '${String(path)}'`);
    (err as { code?: string }).code = 'ENOENT';
    throw err;
  }
  const data = FILES.get(key)!;
  if (typeof enc === 'string' && (enc === 'utf8' || enc === 'utf-8')) {
    return typeof data === 'string' ? data : decoder.decode(data);
  }
  return typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data);
}

export function existsSync(path: unknown): boolean {
  return findKey(path) !== undefined;
}

export function writeFileSync(_path: unknown, _data: unknown): void {
  /* no real fs in Workers; cache writes are best-effort upstream */
}

export function mkdirSync(_path: unknown, _opts?: unknown): void {
  /* no-op */
}

export function readdirSync(path: unknown): string[] {
  const n = normalize(path).replace(/\/+$/, '');
  const names = new Set<string>();
  for (const k of FILES.keys()) {
    if (isDirKey(k, n)) {
      const rest = k.slice(n.length + 1);
      names.add(rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest);
    }
  }
  return [...names];
}

export function statSync(path: unknown): { isFile: () => boolean; isDirectory: () => boolean } {
  const key = findKey(path);
  if (key === undefined) {
    const err = new Error(`ENOENT: no such file or directory, stat '${String(path)}'`);
    (err as { code?: string }).code = 'ENOENT';
    throw err;
  }
  const isDir = !key.includes('.') || isDirKey(key, path as string);
  return { isFile: () => !isDir, isDirectory: () => isDir };
}

const fsPromises = {
  readFile: async (p: unknown, enc?: unknown) => readFileSync(p, enc),
  writeFile: async () => undefined,
  mkdir: async () => undefined,
  readdir: async (p: unknown) => readdirSync(p),
  stat: async (p: unknown) => statSync(p),
};

const fsShim = {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  promises: fsPromises,
  constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },
};

export default fsShim;
export { fsPromises as promises, fsShim as constantsNs };

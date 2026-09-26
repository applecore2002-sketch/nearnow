// Minimal node:url replacement for the Workers bundle (W0-17).
// workerd may not define import.meta.url in every bundled module; paths.ts
// calls fileURLToPath(import.meta.url) at startup. Make that survivable.

export function fileURLToPath(p: unknown): string {
  if (p === undefined || p === null) return '/worker.js';
  const s = String(p);
  if (s.startsWith('file://')) {
    let out = s.slice('file://'.length);
    out = decodeURIComponent(out);
    if (/^\/[A-Za-z]:/.test(out)) out = out.slice(1); // windows drive
    return out;
  }
  return s;
}

export function pathToFileURL(p: unknown): URL {
  const s = String(p).replace(/\\/g, '/');
  return new URL('file://' + (s.startsWith('/') ? '' : '/') + s);
}

export function resolve(...parts: string[]): string {
  let out = '';
  for (const part of parts) {
    const s = String(part).replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(s) || s.startsWith('/')) out = s;
    else out = out ? out.replace(/\/+$/, '') + '/' + s : s;
  }
  return out || '.';
}

export function dirname(p: unknown): string {
  const s = String(p).replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i <= 0 ? (i === 0 ? '/' : '.') : s.slice(0, i);
}

export function basename(p: unknown): string {
  const s = String(p).replace(/\\/g, '/');
  return s.slice(s.lastIndexOf('/') + 1);
}

export function join(...parts: string[]): string {
  const joined = parts.filter((p) => p !== undefined && p !== '').map(String).join('/').replace(/\\/g, '/');
  const isWin = /^[A-Za-z]:/.test(joined);
  const prefix = isWin ? joined.slice(0, 3) : joined.startsWith('/') ? '/' : '';
  const body = (prefix ? joined.slice(prefix.length) : joined)
    .split('/')
    .filter((seg) => seg && seg !== '.')
    .reduce<string[]>((acc, seg) => {
      if (seg === '..') acc.pop();
      else acc.push(seg);
      return acc;
    }, [])
    .join('/');
  return prefix + body;
}

export default { fileURLToPath, pathToFileURL, resolve, dirname, basename, join };

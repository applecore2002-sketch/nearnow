import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Works in dev (cwd = repo root), tsx, Docker (cwd = /app, code in dist/) and
// the EdgeOne function bundle (code in cloud-functions/mcp/domain, data one level up).
function findDir(name: string): string {
  for (const c of [
    join(process.cwd(), name),
    join(here, '..', name),
    join(here, '..', '..', name),
    join(here, '..', '..', '..', name),
  ]) {
    if (existsSync(c)) return c;
  }
  return join(process.cwd(), name);
}

export const DATA_DIR = findDir('data');
export const WEB_DIR = findDir('web');

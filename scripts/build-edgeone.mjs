// Assembles the EdgeOne Pages deploy bundle in edgeone-dist/:
//   edgeone-dist/
//     index.html / privacy.html / terms.html / favicon.svg / icon-512.png   (static)
//     cloud-functions/mcp/index.js        (function entry, from edgeone/)
//     cloud-functions/mcp/domain/*.js     (compiled domain code from dist/)
//     cloud-functions/mcp/data/*.json     (curation data, resolved via paths.ts)
//     cloud-functions/mcp/node_modules/opening_hours/   (vendored dependency)
//     cloud-functions/healthz/index.js
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'edgeone-dist');

function dirSize(p) {
  let total = 0;
  for (const name of readdirSync(p)) {
    const full = join(p, name);
    const st = statSync(full);
    total += st.isDirectory() ? dirSize(full) : st.size;
  }
  return total;
}

console.log('[build:edgeone] compiling TypeScript…');
const tsc = spawnSync('npx', ['tsc'], { cwd: root, stdio: 'inherit', shell: true });
if (tsc.status !== 0) {
  console.error('tsc failed');
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

console.log('[build:edgeone] static pages…');
for (const f of ['index.html', 'privacy.html', 'terms.html', 'favicon.svg', 'icon-512.png']) {
  cpSync(join(root, 'web', f), join(OUT, f));
}

console.log('[build:edgeone] functions…');
cpSync(join(root, 'edgeone', 'cloud-functions'), join(OUT, 'cloud-functions'), { recursive: true });

console.log('[build:edgeone] domain bundle…');
cpSync(join(root, 'dist'), join(OUT, 'cloud-functions', 'mcp', 'domain'), { recursive: true });

console.log('[build:edgeone] curation data…');
cpSync(join(root, 'data'), join(OUT, 'cloud-functions', 'mcp', 'data'), { recursive: true });

console.log('[build:edgeone] vendoring opening_hours…');
const ohSrc = join(root, 'node_modules', 'opening_hours');
if (!existsSync(ohSrc)) {
  console.error('opening_hours not installed — run npm install first');
  process.exit(1);
}
cpSync(ohSrc, join(OUT, 'cloud-functions', 'mcp', 'node_modules', 'opening_hours'), { recursive: true });

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
console.log(`[build:edgeone] done. bundle: ${mb(dirSize(OUT))} at edgeone-dist/`);
console.log('  static: / index.html privacy.html terms.html favicon.svg icon-512.png');
console.log('  functions: POST /mcp, GET /healthz');

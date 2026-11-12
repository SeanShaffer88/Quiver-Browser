import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const src = 'src/renderer';
const out = 'dist/renderer';
mkdirSync(out, { recursive: true });
for (const f of readdirSync(src)) {
  if (f.endsWith('.html') || f.endsWith('.css') || f.endsWith('.svg')) cpSync(join(src, f), join(out, f));
}
console.log('assets copied');

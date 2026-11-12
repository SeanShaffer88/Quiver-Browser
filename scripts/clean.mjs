import { rmSync } from 'node:fs';
for (const d of ['dist', 'release']) rmSync(d, { recursive: true, force: true });
console.log('cleaned dist/ release/');

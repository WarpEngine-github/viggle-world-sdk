// CommonJS declarations for the `require` entry.
//
// The package is `"type": "module"`, so TypeScript reads every `.d.ts` in it
// as an ES module - and a `require()` caller under `moduleResolution: node16`
// is then told it cannot import one. The fix the TypeScript handbook gives is
// a `.d.cts` beside each `.d.ts`: the same declarations, with relative imports
// pointing at `.cjs`. Only the client needs them; `/react` and `/viewer` are
// ESM-only.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../dist/types/', import.meta.url).pathname;
const files = ['index.d.ts', ...readdirSync(join(root, 'core')).filter((f) => f.endsWith('.d.ts')).map((f) => `core/${f}`)];

for (const file of files) {
  const src = readFileSync(join(root, file), 'utf8');
  const out = src
    .replace(/(from\s+['"]\.{1,2}\/[^'"]+)\.js(['"])/g, '$1.cjs$2')
    .replace(/(import\(\s*['"]\.{1,2}\/[^'"]+)\.js(['"]\s*\))/g, '$1.cjs$2');
  writeFileSync(join(root, file.replace(/\.d\.ts$/, '.d.cts')), out);
}
console.log(`cjs-types: ${files.length} declarations`);

// Drops declarations no public entry reaches and that name the engine, which
// is bundled in and not installed beside the package: the explorer's collider
// and its worker, and the internals the lighting reads. Fails the build if any
// other declaration still names the engine.
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../dist/types/', import.meta.url).pathname;
const internal = ['explorer/collider.d.ts', 'explorer/collider.worker.d.ts', 'explorer/internals.d.ts'];
for (const file of internal) rmSync(join(root, file), { force: true });

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const leaks = walk(root).filter((f) => /\.d\.c?ts$/.test(f) && /@viggle\/splat-engine|\/collider\.js|\/internals\.js/.test(readFileSync(f, 'utf8')));
if (leaks.length) {
  console.error(`prune-types: these declarations still reach the engine:\n  ${leaks.map((f) => relative(root, f)).join('\n  ')}`);
  process.exit(1);
}
console.log(`prune-types: removed ${internal.length} internal declarations`);

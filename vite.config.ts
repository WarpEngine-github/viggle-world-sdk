import { defineConfig } from 'vite';

/**
 * Library build, in two passes.
 *
 *   `vite build`            ESM for every entry: `index` (the client),
 *                           `react`, `viewer`, `walk` (the walk's pure logic),
 *                           `explorer` (the walk on the engine) and `lighting`.
 *   `vite build --mode cjs` CommonJS for the client alone, for `require()`
 *                           callers on Node. React and the viewer stay ESM:
 *                           the viewer's workers load through
 *                           `new URL(..., import.meta.url)`, which CommonJS
 *                           has no equivalent for.
 *
 * The splat engine and PlayCanvas are bundled IN, so the package has no
 * runtime dependencies: the engine is a private workspace package, and the
 * app pins a patched PlayCanvas (patches/playcanvas@2.23.3.patch) that a
 * consumer's own copy would not carry. React is the host's. Each engine
 * decoder worker is emitted beside the entries (`dist/assets/`), so `dist/`
 * ships whole.
 *
 * `VIGGLE_RELEASE=1` (`pnpm build:release`) is the build that leaves the
 * building: minified, and no source maps - a map would carry every source
 * file, the engine's included, comments and all.
 *
 * `react` reaches the viewer and the explorer only by dynamic import
 * (SceneViewer, SceneExplorerView), so the engine never lands in what
 * `/react` loads up front. `walk` imports nothing of the engine.
 */
export default defineConfig(({ mode }) => {
  const cjs = mode === 'cjs';
  const release = process.env.VIGGLE_RELEASE === '1';
  return {
    // Relative, so the worker URLs resolve against the bundle (`./assets/...`
    // from import.meta.url) and not against the host page's origin root.
    base: './',
    build: {
      target: 'es2020',
      sourcemap: !release,
      emptyOutDir: !cjs,
      lib: cjs
        ? { entry: { index: 'src/index.ts' }, formats: ['cjs'], fileName: () => 'index.cjs' }
        : {
          entry: {
            index: 'src/index.ts',
            react: 'src/react/index.ts',
            viewer: 'src/viewer/index.ts',
            walk: 'src/walk/index.ts',
            explorer: 'src/explorer/index.ts',
            lighting: 'src/lighting/index.ts',
          },
          formats: ['es'],
        },
      rollupOptions: {
        external: ['react', 'react/jsx-runtime'],
        output: {
          // Lib mode leaves ES output unminified (to keep pure annotations);
          // the release build minifies anyway - the engine inside is bundled, not shaken.
          ...(release && { minify: true }),
          // Next.js App Router: the React entry is client code. Rollup drops
          // a source-level directive when it bundles, so it goes in as a banner.
          banner: (chunk) => (chunk.isEntry && chunk.name === 'react' ? '"use client";' : ''),
        },
      },
    },
    worker: { format: 'es' },
  };
});

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, searchForWorkspaceRoot } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * The example runs against the SDK's source, so edits show without a rebuild.
 *
 * THE KEY STAYS ON THIS SERVER. `VIGGLE_API_KEY` (example/.env.local, no
 * `VITE_` prefix, so Vite never puts it in the bundle) is added here, by the
 * dev proxy, to requests the page sends to `/viggle-api`. That is the shape a
 * production app should take too: the browser talks to your server, your
 * server holds the key.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '');
  const key = env.VIGGLE_API_KEY;
  return {
    root,
    resolve: {
      // The package's own entry points, mapped to source.
      alias: [
        { find: '@viggle/scene-sdk/react', replacement: fileURLToPath(new URL('../src/react/index.ts', import.meta.url)) },
        { find: '@viggle/scene-sdk/viewer', replacement: fileURLToPath(new URL('../src/viewer/index.ts', import.meta.url)) },
        { find: '@viggle/scene-sdk/walk', replacement: fileURLToPath(new URL('../src/walk/index.ts', import.meta.url)) },
        { find: '@viggle/scene-sdk/explorer', replacement: fileURLToPath(new URL('../src/explorer/index.ts', import.meta.url)) },
        { find: '@viggle/scene-sdk/lighting', replacement: fileURLToPath(new URL('../src/lighting/index.ts', import.meta.url)) },
        { find: /^@viggle\/scene-sdk$/, replacement: fileURLToPath(new URL('../src/index.ts', import.meta.url)) },
      ],
    },
    define: { __VIGGLE_LIVE__: JSON.stringify(Boolean(key) && env.VIGGLE_MOCK !== '1') },
    server: {
      port: 5191,
      // The splat engine is linked in from ../P.I.N.O.C./engine, outside this
      // package; its decoder workers are requested as source files from there.
      fs: { allow: [searchForWorkspaceRoot(root), realpathSync(new URL('../node_modules/@viggle/splat-engine', import.meta.url))] },
      proxy: key
        ? {
            '/viggle-api': {
              target: env.VIGGLE_API_BASE_URL || 'https://apis.viggle.ai',
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/viggle-api/, ''),
              headers: { Authorization: `Bearer ${key}` },
            },
          }
        : void 0,
    },
  };
});

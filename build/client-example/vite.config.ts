import { defineConfig, loadEnv } from 'vite';

/**
 * THE API KEY STAYS ON THIS DEV SERVER. `VIGGLE_API_KEY` (in `.env.local`,
 * no `VITE_` prefix, so Vite never puts it in the page) is added by the proxy
 * below to requests the page sends to `/viggle-api`. A production app does
 * the same on its own server. Without a key the example runs on a mock API.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const key = env.VIGGLE_API_KEY;
  return {
    define: { __VIGGLE_LIVE__: JSON.stringify(Boolean(key) && env.VIGGLE_MOCK !== '1') },
    // The SDK ships its own workers, found beside its files: serve it as it
    // is, not pre-bundled. React, which it imports, is CommonJS and must be.
    optimizeDeps: {
      exclude: ['@viggle/scene-sdk'],
      include: ['react', 'react/jsx-runtime', 'react-dom/client'],
    },
    server: {
      port: 5191,
      proxy: key
        ? {
            '/viggle-api': {
              target: env.VIGGLE_API_BASE_URL || 'https://apis.viggle.ai',
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/viggle-api/, ''),
              headers: { Authorization: `Bearer ${key}` },
            },
          }
        : undefined,
    },
  };
});

import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const srcDir = path.resolve(import.meta.dirname, 'src');

export default defineConfig({
  plugins: [
    react(),
    /**
     * One compiled service worker for the whole product.
     *
     * `strategies: 'injectManifest'` gives us the real workbox-style precache
     * manifest injected into our own code, while `manifest: false` leaves
     * manifest generation to the tenant pipeline — every studio needs its own
     * id/start_url/scope, which a single build-time manifest cannot express.
     *
     * The compiled `dist/sw.js` still contains `__TENANT_SCOPE__` and
     * `__TENANT_CACHE__`; `npm run tenant:finalize` substitutes them once per
     * studio, producing separate scopes and separate cache names from one
     * source file.
     */
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/pwa',
      filename: 'sw.ts',
      injectRegister: false,
      registerType: 'prompt',
      manifest: false,
      injectManifest: {
        // Only the shared bundle is precached. Per-studio photography is cached
        // at runtime on first use, which keeps each studio's precache small and
        // prevents one studio's images from being pushed to another's device.
        globPatterns: ['assets/**/*.{js,css,woff2,svg}'],
        globIgnores: ['**/s/**'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@': srcDir,
      '@shared': path.resolve(srcDir, 'shared'),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    // `tenant:finalize` reads this to inject the real hashed filenames into
    // every studio shell.
    manifest: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});

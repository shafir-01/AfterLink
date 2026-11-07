import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

function commit(): string | null {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

/** Emits build.json so a deployed site can be matched to the build that produced it. */
function buildStamp(): Plugin {
  return {
    name: 'afterlink-build-stamp',
    apply: 'build',
    generateBundle(_options, bundle) {
      const names = Object.keys(bundle).sort().join(',');
      const hash = commit() ?? createHash('sha256').update(names).digest('hex').slice(0, 12);
      this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ hash }) });
    },
  };
}

/** Same-origin paths served by the relay, so `npm run dev` behaves like one deployed origin. */
const relayRoutes = Object.fromEntries(['/api', '/report', '/ingress', '/admin', '/health'].map((path) => [path, 'http://localhost:8787']));
const proxy = { ...relayRoutes, '/signal': { target: 'ws://localhost:8787', ws: true } };

export default defineConfig({
  plugins: [
    react(),
    buildStamp(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['icon.svg', 'icon-180.png'],
      manifest: {
        name: 'AfterLink',
        short_name: 'AfterLink',
        description: 'The network disappears. The mission does not.',
        display: 'standalone',
        start_url: '/',
        background_color: '#000000',
        theme_color: '#000000',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,mp3,wasm}'],
        navigateFallback: 'index.html',
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
    }),
  ],
  optimizeDeps: {
    entries: ['index.html'],
    include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'motion/react', 'idb', 'qrcode', 'jsqr', '@noble/curves/ed25519.js', '@noble/hashes/sha2.js'],
  },
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false },
  server: { host: true, port: 5173, proxy },
  preview: { host: true, port: 4173, proxy },
});

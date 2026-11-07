import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/** `/` on the relay, `/AfterLink/` on GitHub Pages. Every URL the app builds derives from this. */
const base = (process.env.VITE_BASE ?? '/').replace(/\/?$/, '/');
const siteUrl = (process.env.VITE_SITE_URL ?? 'https://shafir-01.github.io/AfterLink/').replace(/\/?$/, '/');
const ink = '#0A0A0B';

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

/** Unknown paths on a static host get the app itself, which renders its own not-found view. */
function notFoundPage(): Plugin {
  return {
    name: 'afterlink-not-found-page',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const shell = bundle['index.html'];
      if (shell?.type === 'asset') this.emitFile({ type: 'asset', fileName: '404.html', source: shell.source });
    },
  };
}

/** Link previews need absolute URLs, and those differ per host. */
function siteMeta(): Plugin {
  return {
    name: 'afterlink-site-meta',
    transformIndexHtml: { order: 'pre', handler: (html) => html.replaceAll('%SITE_URL%', siteUrl) },
  };
}

/** Same-origin paths served by the relay, so `npm run dev` behaves like one deployed origin. */
const relayRoutes = Object.fromEntries(['/api', '/report', '/ingress', '/admin', '/health'].map((path) => [path, 'http://localhost:8787']));
const proxy = { ...relayRoutes, '/signal': { target: 'ws://localhost:8787', ws: true } };

export default defineConfig({
  base,
  plugins: [
    react(),
    buildStamp(),
    siteMeta(),
    notFoundPage(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      manifest: {
        id: base,
        name: 'AfterLink',
        short_name: 'AfterLink',
        description: 'The network disappears. The mission does not.',
        display: 'standalone',
        start_url: base,
        scope: base,
        background_color: ink,
        theme_color: ink,
        icons: [
          { src: 'brand/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'brand/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'brand/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'brand/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,mp3,wasm}', 'radio/manifest.json'],
        globIgnores: ['**/node_modules/**/*', 'sw.js', 'workbox-*.js', '404.html', 'brand/og.png'],
        navigateFallback: 'index.html',
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallbackDenylist: [new RegExp(`^${base}(api|report|ingress|admin|signal|health)`)],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
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

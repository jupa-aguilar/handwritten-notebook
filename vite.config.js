import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Stamped into the bundle so the running app can say which build it is. The
// service worker serves the previous version until the new one takes over, so
// "did my change land?" is otherwise unanswerable from the screen.
const buildSha = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'local'; // no git (a tarball build, say) — the date still tells you
  }
})();

// Relative asset URLs so the same build also works from file:// (Electron)
// and under a GitHub Pages subpath.
export default defineConfig({
  base: './',
  define: {
    __BUILD_SHA__: JSON.stringify(buildSha),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png', 'favicon.svg'],
      manifest: {
        name: 'My Notebook',
        short_name: 'Notebook',
        description: 'Digital notebook for scanned handwritten pages',
        display: 'standalone',
        background_color: '#2b2622',
        theme_color: '#2b2622',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
});

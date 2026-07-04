import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Relative asset URLs so the same build also works from file:// (Electron)
// and under a GitHub Pages subpath.
export default defineConfig({
  base: './',
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

import { defineConfig } from 'vite';

// Relative asset URLs so the same build also works from file:// (Electron).
export default defineConfig({
  base: './',
});

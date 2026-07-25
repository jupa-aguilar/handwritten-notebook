import { defineConfig } from 'vitest/config';

// A config of its own, deliberately: the app's vite.config.js runs the PWA
// plugin, which has nothing to do with the tests and would only generate
// service workers on every run.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.js'],
    include: ['test/**/*.test.js'],
  },
});

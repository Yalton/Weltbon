import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    // jsdom rendering and user-event typing slow down in step with the CPU, so
    // the 5s default fails long interaction tests on a busy machine.
    testTimeout: 20_000,
    // Playwright E2E specs live in e2e/ and run under `pnpm test:e2e`, not vitest.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});

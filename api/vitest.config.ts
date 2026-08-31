import { defineConfig } from 'vitest/config';
import { DB_GATED_TESTS } from './ci/integration-tiers.mjs';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 10_000,
    // DB setup/teardown can exceed the per-test timeout under CI contention.
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: DB_GATED_TESTS,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: DB_GATED_TESTS,
          pool: 'forks',
          poolOptions: {
            forks: { singleFork: true },
          },
        },
      },
    ],
  },
});

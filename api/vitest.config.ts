import { defineConfig } from 'vitest/config';
import { DB_GATED_TESTS } from './ci/integration-tiers.mjs';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 10_000,
    // DB setup/teardown and the cold app imports some suites do in beforeAll
    // take well over 30s when the machine is busy (see tests/helpers/timeouts.ts).
    hookTimeout: 60_000,
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

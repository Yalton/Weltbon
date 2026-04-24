import { afterAll, beforeAll } from 'vitest';

// Set minimum valid env BEFORE any module (including config.ts) is imported.
// Tests that validate the guard itself explicitly call loadEnv(customEnv).
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-that-is-at-least-32-characters-long';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://weltbon:weltbon_dev@127.0.0.1:5433/weltbon';
process.env.PORT = process.env.PORT ?? '3001';

beforeAll(async () => {
  // Placeholder — auth.test.ts and universes.test.ts will use helpers.createTestDb()
  // which creates an isolated schema. No-op here keeps setup.ts generic.
});

afterAll(async () => {
  // No-op at setup level; per-test-file helpers handle their own teardown.
});

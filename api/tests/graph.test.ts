import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { setTestDb } from '../src/db/client.js';

// Wave 0 stub suite for Phase 3 graph-data endpoint (GRAPH-01).
// Downstream plan 03-04 converts skips to real assertions.

describe.skip('graph-data route (Wave 0 stub — Plan 03-04)', () => {
  let handle: TestDbHandle;
  let app: ReturnType<typeof createApp> | undefined;

  beforeAll(async () => {
    handle = await createTestDb();
    setTestDb(handle.db as any, handle.pool);
    app = createApp();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
  });

  // NOTE: variables below will be used once skipped tests are filled in by downstream plan.
  // Using @ts-ignore-style void-cast guarded by describe.skip (the hooks never run).
  void app; void authHeader; void createTestUser; void expect;

  describe('GET /universes/:uid/graph-data — GRAPH-01', () => {
    it.skip('returns { nodes, edges, positions } composed in a single endpoint', () => {
      expect.fail('Wave 0 stub — Plan 03-04 must implement this test');
    });
  });
});

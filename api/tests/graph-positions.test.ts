import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { setTestDb } from '../src/db/client.js';

// Wave 0 stub suite for Phase 3 graph position persistence (GRAPH-05).
// Downstream plan 03-04 converts skips to real assertions.

describe.skip('graph-positions routes (Wave 0 stub — Plan 03-04)', () => {
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

  describe('POST /universes/:uid/graph-positions upserts — GRAPH-05 shift+click persistence', () => {
    it.skip('upserts (universeId, entryId) position row on shift+click pin', () => {
      expect.fail('Wave 0 stub — Plan 03-04 must implement this test');
    });
  });

  describe('DELETE /universes/:uid/graph-positions resets all — GRAPH-05 reset', () => {
    it.skip('deletes all pinned positions for the universe (reset layout)', () => {
      expect.fail('Wave 0 stub — Plan 03-04 must implement this test');
    });
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, seedLargeUniverse, type TestDbHandle } from './helpers.js';
import { setTestDb } from '../src/db/client.js';

// Wave 0 stub suite for Phase 3 entry list filters + full-text search (NAV-01..05).
// Downstream plan 03-03 converts skips to real assertions.

describe.skip('entry list filters + search (Wave 0 stub — Plan 03-03)', () => {
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
  void app; void authHeader; void createTestUser; void seedLargeUniverse; void expect;

  describe('GET /entries?type= — NAV-01', () => {
    it.skip('narrows entry list to the given entryType only', () => {
      expect.fail('Wave 0 stub — Plan 03-03 must implement this test');
    });
  });

  describe('GET /entries?tag=a&tag=b AND — NAV-02', () => {
    it.skip('returns entries with BOTH tag a AND tag b (AND semantics, not OR)', () => {
      expect.fail('Wave 0 stub — Plan 03-03 must implement this test');
    });
  });

  describe('GET /entries?category= — NAV-03', () => {
    it.skip('supports categoryId filter and the uncategorized sentinel', () => {
      expect.fail('Wave 0 stub — Plan 03-03 must implement this test');
    });
  });

  describe('GET /entries?q= FTS — NAV-04', () => {
    it.skip('returns entries whose title/summary/body/tags match the tsquery, ordered by rank', () => {
      expect.fail('Wave 0 stub — Plan 03-03 must implement this test');
    });
  });

  describe('GET /entries?q=...&type=... combined — NAV-05', () => {
    it.skip('combines FTS with type/tag/category filters via AND', () => {
      expect.fail('Wave 0 stub — Plan 03-03 must implement this test');
    });
  });

  describe('FTS p95 < 1000ms at 220 seeded entries — NAV-04 perf', () => {
    // TODO(plan-03-03): seed via seedLargeUniverse(handle, userId, { entryCount: 220 })
    // and assert the p95 of N queries stays under the 1000ms budget.
    it.skip('FTS p95 under 1s at 220 entries (uses seedLargeUniverse fixture)', () => {
      expect.fail('Wave 0 stub — Plan 03-03 must implement this perf test');
    });
  });
});

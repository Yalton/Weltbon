import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { setTestDb } from '../src/db/client.js';

// Wave 0 stub suite for Phase 3 categories work (CAT-01..05).
// Downstream plans will:
//   1. Remove `.skip` from the outer describe below.
//   2. Replace each `it.skip` body with real assertions exercising the new routes.
// Per plan 03-01: every requirement slot is present and named exactly per 03-VALIDATION.md.

describe.skip('categories routes (Wave 0 stub — Plan 03-02)', () => {
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

  describe('POST /universes/:uid/categories — CAT-01', () => {
    it.skip('creates category with label + optional icon', () => {
      expect.fail('Wave 0 stub — Plan 03-02 must implement this test');
    });
  });

  describe('PATCH /entries/:id — CAT-02', () => {
    it.skip('assigns entry to a category via categoryId', () => {
      expect.fail('Wave 0 stub — Plan 03-02 must implement this test');
    });
  });

  describe('PUT /categories/reorder — CAT-03', () => {
    it.skip('rewrites sort_order in the order of ids provided', () => {
      expect.fail('Wave 0 stub — Plan 03-02 must implement this test');
    });
  });

  describe('DELETE /categories/:id sets entries.category_id NULL — CAT-04', () => {
    it.skip('deleting a category nulls category_id on its entries (ON DELETE SET NULL)', () => {
      expect.fail('Wave 0 stub — Plan 03-02 must implement this test');
    });
  });

  describe('GET /categories returns entries count join — CAT-05', () => {
    it.skip('returns categories with per-category entryCount + uncategorizedCount', () => {
      expect.fail('Wave 0 stub — Plan 03-02 must implement this test');
    });
  });
});

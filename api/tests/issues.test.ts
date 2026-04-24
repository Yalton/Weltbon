import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { setTestDb } from '../src/db/client.js';

// Wave 0 stub suite for Phase 3 issue tracker (ISS-01..05).
// Downstream plan 03-05 converts skips to real assertions.

describe.skip('issues routes (Wave 0 stub — Plan 03-05)', () => {
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

  describe('POST /universes/:uid/issues — ISS-01', () => {
    it.skip('creates issue with title + description + severity (validated against enum)', () => {
      expect.fail('Wave 0 stub — Plan 03-05 must implement this test');
    });
  });

  describe('associates with entries via issue_entries — ISS-02', () => {
    it.skip('associates a new issue with one or more entries (join table)', () => {
      expect.fail('Wave 0 stub — Plan 03-05 must implement this test');
    });
  });

  describe('PATCH /issues/:id resolved — ISS-03', () => {
    it.skip('marks an issue resolved via PATCH { resolved: true }', () => {
      expect.fail('Wave 0 stub — Plan 03-05 must implement this test');
    });
  });

  describe('PATCH/DELETE /issues/:id — ISS-04', () => {
    it.skip('edits or deletes an existing issue', () => {
      expect.fail('Wave 0 stub — Plan 03-05 must implement this test');
    });
  });

  describe('GET /issues?severity=&resolved= — ISS-05', () => {
    it.skip('filters by severity and/or resolved query params', () => {
      expect.fail('Wave 0 stub — Plan 03-05 must implement this test');
    });
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb, db } from '../src/db/client.js';
import { links } from '../src/db/schema.js';

describe('export/import (EXP-01, IMP-01..03)', () => {
  let handle: TestDbHandle;
  let app: ReturnType<typeof createApp>;

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

  async function userWithToken(email: string) {
    const user = await createTestUser(handle, { email, password: 'longenoughpw12' });
    const token = await issueAccessToken(user.id);
    return { user, token, hdrs: authHeader(token) };
  }

  async function req(method: string, path: string, opts?: { headers?: Record<string, string>; body?: unknown }) {
    const url = `http://localhost${path}`;
    const init: RequestInit = { method, headers: { ...opts?.headers } };
    if (opts?.body !== undefined) {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return app.request(url, init);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function json(res: Response): Promise<any> {
    return res.json();
  }

  async function createUniverse(hdrs: Record<string, string>, name = 'TestWorld') {
    const res = await req('POST', '/universes', { headers: hdrs, body: { name } });
    return json(res);
  }

  async function createEntry(uid: string, hdrs: Record<string, string>, overrides: Record<string, unknown> = {}) {
    const body = {
      title: 'Test Entry',
      entryType: 'concept',
      summary: 'A test entry',
      body: 'Full body text',
      tags: ['test'],
      meta: { key: 'value' },
      icon: 'star',
      ...overrides,
    };
    const res = await req('POST', `/universes/${uid}/entries`, { headers: hdrs, body });
    return json(res);
  }

  /** Insert a link directly via DB (link routes may not exist yet) */
  async function insertLink(universeId: string, sourceEntryId: string, targetEntryId: string, label: string, bidirectional = false) {
    const [created] = await db()
      .insert(links)
      .values({ universeId, sourceEntryId, targetEntryId, label, bidirectional })
      .returning();
    return created;
  }

  // EXP-01: export empty universe
  it('export empty universe returns valid JSON with weltbon_version', async () => {
    const { hdrs } = await userWithToken('exp1@test.com');
    const universe = await createUniverse(hdrs, 'EmptyWorld');

    const res = await req('GET', `/universes/${universe.id}/export?format=json`, { headers: hdrs });
    expect(res.status).toBe(200);

    const data = await json(res);
    expect(data.weltbon_version).toBe('1.0.0');
    expect(data.exported_at).toBeTruthy();
    expect(data.universe.name).toBe('EmptyWorld');
    expect(data.entries).toEqual([]);
    expect(data.links).toEqual([]);
  });

  // EXP-01: export universe with entries and links
  it('export universe with entries and links returns correct counts', async () => {
    const { hdrs } = await userWithToken('exp2@test.com');
    const universe = await createUniverse(hdrs, 'PopulatedWorld');

    const entry1 = await createEntry(universe.id, hdrs, { title: 'The Sundering', entryType: 'event' });
    const entry2 = await createEntry(universe.id, hdrs, { title: 'Elara', entryType: 'entity' });
    const entry3 = await createEntry(universe.id, hdrs, { title: 'Crystal Tower', entryType: 'location' });

    await insertLink(universe.id, entry1.id, entry2.id, 'affected');
    await insertLink(universe.id, entry2.id, entry3.id, 'resides in');

    const res = await req('GET', `/universes/${universe.id}/export?format=json`, { headers: hdrs });
    expect(res.status).toBe(200);

    const data = await json(res);
    expect(data.entries).toHaveLength(3);
    expect(data.links).toHaveLength(2);
    expect(data.entries[0].title).toBeTruthy();
    expect(data.links[0].label).toBeTruthy();
  });

  // EXP-01: export includes Content-Disposition header
  it('export returns Content-Disposition header', async () => {
    const { hdrs } = await userWithToken('exp3@test.com');
    const universe = await createUniverse(hdrs, 'HeaderWorld');

    const res = await req('GET', `/universes/${universe.id}/export?format=json`, { headers: hdrs });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('.json');
  });

  // IMP-01: import valid JSON creates universe
  it('import valid JSON creates universe with 201', async () => {
    const { hdrs } = await userWithToken('imp1@test.com');

    const importData = {
      weltbon_version: '1.0.0',
      exported_at: new Date().toISOString(),
      universe: { name: 'ImportedWorld', description: 'A test import' },
      entries: [
        { id: 'a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0', title: 'Test Entry', entryType: 'concept', summary: '', body: '', tags: [], meta: {}, icon: '', categoryId: null },
      ],
      links: [],
    };

    const res = await req('POST', '/universes/import', { headers: hdrs, body: importData });
    expect(res.status).toBe(201);

    const result = await json(res);
    expect(result.universeId).toBeTruthy();
    expect(result.universeName).toBe('ImportedWorld');
    expect(result.entryCount).toBe(1);
    expect(result.linkCount).toBe(0);
  });

  // IMP-01 + EXP-01: round-trip preserves data
  it('import round-trip preserves entry and link counts', async () => {
    const { hdrs } = await userWithToken('rt@test.com');
    const universe = await createUniverse(hdrs, 'RoundTripWorld');

    const entry1 = await createEntry(universe.id, hdrs, { title: 'Alpha', entryType: 'concept' });
    const entry2 = await createEntry(universe.id, hdrs, { title: 'Beta', entryType: 'entity' });
    const entry3 = await createEntry(universe.id, hdrs, { title: 'Gamma', entryType: 'location' });

    await insertLink(universe.id, entry1.id, entry2.id, 'relates to');
    await insertLink(universe.id, entry2.id, entry3.id, 'located in');

    // Export original
    const exportRes = await req('GET', `/universes/${universe.id}/export?format=json`, { headers: hdrs });
    const exportData = await json(exportRes);

    // Import to create new universe
    const importRes = await req('POST', '/universes/import', { headers: hdrs, body: exportData });
    expect(importRes.status).toBe(201);
    const importResult = await json(importRes);

    // Export the new universe
    const reExportRes = await req('GET', `/universes/${importResult.universeId}/export?format=json`, { headers: hdrs });
    const reExportData = await json(reExportRes);

    // Compare counts
    expect(reExportData.entries).toHaveLength(exportData.entries.length);
    expect(reExportData.links).toHaveLength(exportData.links.length);

    // Compare titles
    const origTitles = exportData.entries.map((e: { title: string }) => e.title).sort();
    const newTitles = reExportData.entries.map((e: { title: string }) => e.title).sort();
    expect(newTitles).toEqual(origTitles);

    // Compare link labels
    const origLabels = exportData.links.map((l: { label: string }) => l.label).sort();
    const newLabels = reExportData.links.map((l: { label: string }) => l.label).sort();
    expect(newLabels).toEqual(origLabels);
  });

  // IMP-03: import rejects incompatible version
  it('import rejects incompatible weltbon_version with 400', async () => {
    const { hdrs } = await userWithToken('ver@test.com');

    const importData = {
      weltbon_version: '99.0.0',
      universe: { name: 'BadVersion' },
      entries: [],
      links: [],
    };

    const res = await req('POST', '/universes/import', { headers: hdrs, body: importData });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.toLowerCase()).toContain('version');
  });

  // IMP-03: import rejects malformed JSON
  it('import rejects malformed data with 400', async () => {
    const { hdrs } = await userWithToken('bad@test.com');

    const importData = {
      weltbon_version: '1.0.0',
      // missing universe, entries, links
    };

    const res = await req('POST', '/universes/import', { headers: hdrs, body: importData });
    expect(res.status).toBe(400);
  });

  // IMP-02: import atomic on failure -- no partial universe
  it('import atomic: failed import leaves no new universe', async () => {
    const { hdrs } = await userWithToken('atomic@test.com');

    // List universes before import attempt
    const beforeRes = await req('GET', '/universes', { headers: hdrs });
    const beforeUniverses = await json(beforeRes);
    const countBefore = beforeUniverses.length;

    const importData = {
      weltbon_version: '1.0.0',
      universe: { name: 'AtomicFail' },
      entries: [
        { id: 'b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0', title: 'Entry', entryType: 'concept', summary: '', body: '', tags: [], meta: {}, icon: '', categoryId: null },
      ],
      links: [
        { id: 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0', sourceEntryId: 'b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0', targetEntryId: 'd0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0', label: 'bad ref', bidirectional: false },
      ],
    };

    const res = await req('POST', '/universes/import', { headers: hdrs, body: importData });
    expect(res.status).toBe(400);

    // Verify no new universe was created
    const afterRes = await req('GET', '/universes', { headers: hdrs });
    const afterUniverses = await json(afterRes);
    expect(afterUniverses.length).toBe(countBefore);
  });

  // Import creates new UUIDs (not reused from source)
  it('import creates new UUIDs different from original', async () => {
    const { hdrs } = await userWithToken('uuid@test.com');
    const universe = await createUniverse(hdrs, 'UUIDWorld');

    const entry = await createEntry(universe.id, hdrs, { title: 'Original', entryType: 'concept' });
    const originalEntryId = entry.id;

    // Export
    const exportRes = await req('GET', `/universes/${universe.id}/export?format=json`, { headers: hdrs });
    const exportData = await json(exportRes);

    // Import
    const importRes = await req('POST', '/universes/import', { headers: hdrs, body: exportData });
    expect(importRes.status).toBe(201);
    const importResult = await json(importRes);

    // Export the new universe and check IDs differ
    const reExportRes = await req('GET', `/universes/${importResult.universeId}/export?format=json`, { headers: hdrs });
    const reExportData = await json(reExportRes);

    expect(reExportData.entries).toHaveLength(1);
    expect(reExportData.entries[0].id).not.toBe(originalEntryId);
  });
});

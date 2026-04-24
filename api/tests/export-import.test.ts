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

  // --- CAT round-trip ---

  async function createCategory(uid: string, hdrs: Record<string, string>, body: Record<string, unknown>) {
    const res = await req('POST', `/universes/${uid}/categories`, { headers: hdrs, body });
    return json(res);
  }

  async function patchEntry(uid: string, entryId: string, hdrs: Record<string, string>, body: Record<string, unknown>) {
    const res = await req('PATCH', `/universes/${uid}/entries/${entryId}`, { headers: hdrs, body });
    return json(res);
  }

  it('export includes categories array with label, icon, sortOrder', async () => {
    const { hdrs } = await userWithToken('cat-exp@test.com');
    const universe = await createUniverse(hdrs, 'CatsExport');
    await createCategory(universe.id, hdrs, { label: 'Locations', icon: '🗺️' });
    await createCategory(universe.id, hdrs, { label: 'Factions', icon: '⚔️' });

    const res = await req('GET', `/universes/${universe.id}/export?format=json`, { headers: hdrs });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(Array.isArray(data.categories)).toBe(true);
    expect(data.categories).toHaveLength(2);
    const labels = data.categories.map((c: { label: string }) => c.label).sort();
    expect(labels).toEqual(['Factions', 'Locations']);
    expect(data.categories[0]).toHaveProperty('sortOrder');
  });

  it('round-trip preserves categories and entry→category associations by label', async () => {
    const { hdrs } = await userWithToken('cat-rt@test.com');
    const universe = await createUniverse(hdrs, 'CatRoundTrip');

    const locations = await createCategory(universe.id, hdrs, { label: 'Locations' });
    const factions = await createCategory(universe.id, hdrs, { label: 'Factions' });

    const e1 = await createEntry(universe.id, hdrs, { title: 'Capital' });
    const e2 = await createEntry(universe.id, hdrs, { title: 'Harbor' });
    const e3 = await createEntry(universe.id, hdrs, { title: 'Guild' });
    const e4 = await createEntry(universe.id, hdrs, { title: 'Loose Note' });

    await patchEntry(universe.id, e1.id, hdrs, { categoryId: locations.id });
    await patchEntry(universe.id, e2.id, hdrs, { categoryId: locations.id });
    await patchEntry(universe.id, e3.id, hdrs, { categoryId: factions.id });
    // e4 stays uncategorized

    // Export
    const exportRes = await req('GET', `/universes/${universe.id}/export?format=json`, { headers: hdrs });
    const exportData = await json(exportRes);

    // Import under same user
    const importRes = await req('POST', '/universes/import', { headers: hdrs, body: exportData });
    expect(importRes.status).toBe(201);
    const importResult = await json(importRes);
    expect(importResult.categoryCount).toBe(2);

    // List imported categories with counts
    const listRes = await req('GET', `/universes/${importResult.universeId}/categories`, { headers: hdrs });
    const listData = await json(listRes);
    const byLabel = new Map<string, { id: string; entryCount: number }>(
      listData.categories.map((c: { id: string; label: string; entryCount: number }) => [c.label, c])
    );
    expect(byLabel.get('Locations')!.entryCount).toBe(2);
    expect(byLabel.get('Factions')!.entryCount).toBe(1);
    expect(listData.uncategorizedCount).toBe(1);

    // Sanity: the newly-imported entries point at the NEWLY created category ids
    const reExportRes = await req('GET', `/universes/${importResult.universeId}/export?format=json`, { headers: hdrs });
    const reExport = await json(reExportRes);
    const newLocationsId = byLabel.get('Locations')!.id;
    const newFactionsId = byLabel.get('Factions')!.id;
    const entryCatByTitle = new Map<string, string | null>(
      reExport.entries.map((e: { title: string; categoryId: string | null }) => [e.title, e.categoryId])
    );
    expect(entryCatByTitle.get('Capital')).toBe(newLocationsId);
    expect(entryCatByTitle.get('Harbor')).toBe(newLocationsId);
    expect(entryCatByTitle.get('Guild')).toBe(newFactionsId);
    expect(entryCatByTitle.get('Loose Note')).toBeNull();
  });

  it('import accepts Phase-2-era JSON without a categories field (backward compat)', async () => {
    const { hdrs } = await userWithToken('cat-bc@test.com');

    // Older export shape — no categories field at all
    const legacyImport = {
      weltbon_version: '1.0.0',
      exported_at: new Date().toISOString(),
      universe: { name: 'LegacyWorld', description: '' },
      entries: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          title: 'Legacy Entry',
          entryType: 'concept',
          summary: '',
          body: '',
          tags: [],
          meta: {},
          icon: '',
          categoryId: null,
        },
      ],
      links: [],
    };

    const res = await req('POST', '/universes/import', { headers: hdrs, body: legacyImport });
    expect(res.status).toBe(201);
    const result = await json(res);
    expect(result.entryCount).toBe(1);
    expect(result.categoryCount).toBe(0);
  });

  // --- Issue round-trip (ISS-01..06 export/import coverage) ---

  async function createIssue(uid: string, hdrs: Record<string, string>, body: Record<string, unknown>) {
    const res = await req('POST', `/universes/${uid}/issues`, { headers: hdrs, body });
    return json(res);
  }

  async function patchIssue(uid: string, issueId: string, hdrs: Record<string, string>, body: Record<string, unknown>) {
    const res = await req('PATCH', `/universes/${uid}/issues/${issueId}`, { headers: hdrs, body });
    return json(res);
  }

  it('export includes issues array with entryIds denormalized per issue', async () => {
    const { hdrs } = await userWithToken('iss-exp@test.com');
    const universe = await createUniverse(hdrs, 'IssExport');
    const e1 = await createEntry(universe.id, hdrs, { title: 'E1' });
    const e2 = await createEntry(universe.id, hdrs, { title: 'E2' });

    await createIssue(universe.id, hdrs, { title: 'Open one', severity: 'critical', entryIds: [e1.id] });
    const iss2 = await createIssue(universe.id, hdrs, { title: 'Will resolve', severity: 'minor', entryIds: [e1.id, e2.id] });
    await patchIssue(universe.id, iss2.id, hdrs, { resolved: true });

    const res = await req('GET', `/universes/${universe.id}/export?format=json`, { headers: hdrs });
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(Array.isArray(data.issues)).toBe(true);
    expect(data.issues).toHaveLength(2);
    // Each issue exposes entryIds array
    const byTitle = new Map<string, { severity: string; resolved: boolean; entryIds: string[] }>(
      data.issues.map((i: { title: string; severity: string; resolved: boolean; entryIds: string[] }) => [i.title, i])
    );
    expect(byTitle.get('Open one')!.severity).toBe('critical');
    expect(byTitle.get('Open one')!.resolved).toBe(false);
    expect(byTitle.get('Open one')!.entryIds).toHaveLength(1);
    expect(byTitle.get('Will resolve')!.resolved).toBe(true);
    expect(byTitle.get('Will resolve')!.entryIds.sort()).toEqual([e1.id, e2.id].sort());
  });

  it('round-trip preserves issues + entry associations + resolved state', async () => {
    const { hdrs } = await userWithToken('iss-rt@test.com');
    const universe = await createUniverse(hdrs, 'IssRoundTrip');
    const e1 = await createEntry(universe.id, hdrs, { title: 'E1' });
    const e2 = await createEntry(universe.id, hdrs, { title: 'E2' });
    const e3 = await createEntry(universe.id, hdrs, { title: 'E3' });

    await createIssue(universe.id, hdrs, { title: 'Open', severity: 'major', entryIds: [e1.id] });
    const iss2 = await createIssue(universe.id, hdrs, { title: 'Resolved', severity: 'minor', entryIds: [e1.id, e2.id] });
    await patchIssue(universe.id, iss2.id, hdrs, { resolved: true });
    void e3; // not associated with any issue

    // Export
    const exportRes = await req('GET', `/universes/${universe.id}/export?format=json`, { headers: hdrs });
    const exportData = await json(exportRes);
    expect(exportData.issues).toHaveLength(2);
    const origAssocCount = exportData.issues.reduce(
      (sum: number, i: { entryIds: string[] }) => sum + i.entryIds.length,
      0
    );
    expect(origAssocCount).toBe(3);

    // Import
    const importRes = await req('POST', '/universes/import', { headers: hdrs, body: exportData });
    expect(importRes.status).toBe(201);
    const importResult = await json(importRes);
    expect(importResult.issueCount).toBe(2);

    // Re-export
    const reExportRes = await req('GET', `/universes/${importResult.universeId}/export?format=json`, { headers: hdrs });
    const reExport = await json(reExportRes);

    expect(reExport.issues).toHaveLength(2);
    const byTitle = new Map<string, { severity: string; resolved: boolean; entryIds: string[] }>(
      reExport.issues.map((i: { title: string; severity: string; resolved: boolean; entryIds: string[] }) => [i.title, i])
    );
    expect(byTitle.get('Open')!.severity).toBe('major');
    expect(byTitle.get('Open')!.resolved).toBe(false);
    expect(byTitle.get('Open')!.entryIds).toHaveLength(1);
    expect(byTitle.get('Resolved')!.resolved).toBe(true);
    expect(byTitle.get('Resolved')!.entryIds).toHaveLength(2);

    // Associations point to the NEW entry uuids, not the originals
    const newEntryIds = new Set(reExport.entries.map((e: { id: string }) => e.id));
    for (const issue of reExport.issues) {
      for (const eid of issue.entryIds) {
        expect(newEntryIds.has(eid)).toBe(true);
      }
    }

    const reAssocCount = reExport.issues.reduce(
      (sum: number, i: { entryIds: string[] }) => sum + i.entryIds.length,
      0
    );
    expect(reAssocCount).toBe(origAssocCount);
  });

  it('import accepts legacy JSON without issues field (backward compat)', async () => {
    const { hdrs } = await userWithToken('iss-bc@test.com');

    const legacy = {
      weltbon_version: '1.0.0',
      exported_at: new Date().toISOString(),
      universe: { name: 'NoIssues', description: '' },
      entries: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          title: 'Only Entry',
          entryType: 'concept',
          summary: '',
          body: '',
          tags: [],
          meta: {},
          icon: '',
          categoryId: null,
        },
      ],
      links: [],
      // NO issues field at all
    };

    const res = await req('POST', '/universes/import', { headers: hdrs, body: legacy });
    expect(res.status).toBe(201);
    const result = await json(res);
    expect(result.issueCount).toBe(0);
    expect(result.entryCount).toBe(1);
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

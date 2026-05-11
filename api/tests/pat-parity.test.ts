/**
 * PAT Parity E2E round-trip integration test (API-04)
 *
 * This test is the API-04 acceptance gate: it proves that every capability class
 * accessible to JWT bearers is also accessible via PAT bearer, and that the data
 * survives an export→import round-trip with identity preserved.
 *
 * D-10: Single E2E round-trip — mint a PAT via JWT, then drive:
 *   create universe → category → entries → link → issue → timeline pin →
 *   graph-data (smoke) → export JSON → import to new universe → re-export →
 *   assert round-trip identity (titles, labels, category names match).
 *
 * D-11: Plus a tiny smoke check confirming PAT meta-API rejects PAT bearer
 *   (D-13 regression guard). Already covered deeply in tokens.test.ts; this
 *   is just the wiring check post-Phase 10 migration.
 *
 * Skip pattern: tests skip if DATABASE_URL is not available (matches project-wide
 * pattern for DB-dependent integration suites).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';

describe('PAT parity round-trip (API-04)', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  beforeAll(async () => {
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    setTestDb(handle.db as any, handle.pool);
    const indexModule = await import('../src/index.js');
    app = indexModule.createApp();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
  });

  // ─── Helpers ─────────────────────────────────────────────────────────────

  async function appRequest(
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {}
  ) {
    const headers: Record<string, string> = { ...options.headers };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const req = new Request(`http://localhost${path}`, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const res = await app.fetch(req);
    let json: unknown = null;
    try {
      const text = await res.text();
      if (text) json = JSON.parse(text);
    } catch {
      // no body or non-JSON
    }
    return { status: res.status, body: json as any };
  }

  async function createUserAndJwt(email = 'parity@test.com') {
    const { issueAccessToken } = await import('../src/services/auth.js');
    const user = await createTestUser(handle, { email, password: 'longenoughpw12' });
    const jwt = await issueAccessToken(user.id);
    return { userId: user.id, jwt };
  }

  // ─── Test 1: Full PAT parity round-trip ─────────────────────────────────

  it('round-trip: mint PAT via JWT then drive all capability classes with PAT bearer', async () => {
    const { jwt } = await createUserAndJwt('roundtrip@test.com');

    // Step 1: Mint a PAT via JWT (the only JWT-required step per D-13)
    const mintRes = await appRequest('POST', '/api/auth/tokens', {
      body: { label: 'parity-test-pat' },
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(mintRes.status, 'mint PAT').toBe(200);
    const patPlaintext: string = mintRes.body.plaintext;
    expect(patPlaintext).toMatch(/^wbn_pat_/);

    const patHdr = { Authorization: `Bearer ${patPlaintext}` };

    // Step 2: Create a universe (PAT)
    const uRes = await appRequest('POST', '/api/universes', {
      body: { name: 'Parity Test World', description: 'Round-trip universe' },
      headers: patHdr,
    });
    expect(uRes.status, 'create universe').toBe(201);
    const uid: string = uRes.body.id;
    expect(uid).toBeTruthy();

    // Step 3: Create a category (PAT)
    const catRes = await appRequest('POST', `/api/universes/${uid}/categories`, {
      body: { label: 'Locations', icon: '' },
      headers: patHdr,
    });
    expect(catRes.status, 'create category').toBe(201);
    const categoryId: string = catRes.body.id;

    // Step 4: Create entry A (PAT)
    const entryARes = await appRequest('POST', `/api/universes/${uid}/entries`, {
      body: {
        title: 'The Sundering',
        entryType: 'event',
        summary: 'A great cataclysm',
        body: 'Long description of the sundering',
        tags: ['cataclysm', 'origin'],
        meta: {},
        icon: 'fire',
        categoryId,
      },
      headers: patHdr,
    });
    expect(entryARes.status, 'create entry A').toBe(201);
    const entryAId: string = entryARes.body.id;

    // Step 5: Create entry B (PAT) — uncategorized initially
    const entryBRes = await appRequest('POST', `/api/universes/${uid}/entries`, {
      body: {
        title: 'Elara',
        entryType: 'entity',
        summary: 'A key figure',
        body: 'Details about Elara',
        tags: ['character'],
        meta: {},
        icon: 'person',
        categoryId: null,
      },
      headers: patHdr,
    });
    expect(entryBRes.status, 'create entry B').toBe(201);
    const entryBId: string = entryBRes.body.id;

    // Step 6: Link A → B (PAT)
    const linkRes = await appRequest('POST', `/api/universes/${uid}/links`, {
      body: {
        sourceEntryId: entryAId,
        targetEntryId: entryBId,
        label: 'caused by',
        bidirectional: false,
      },
      headers: patHdr,
    });
    expect(linkRes.status, 'create link').toBe(201);

    // Step 7: Create an issue tagged to entry A (PAT)
    const issueRes = await appRequest('POST', `/api/universes/${uid}/issues`, {
      body: {
        title: 'Timeline inconsistency',
        description: 'The sundering timeline needs verification',
        severity: 'major',
        entryIds: [entryAId],
      },
      headers: patHdr,
    });
    expect(issueRes.status, 'create issue').toBe(201);

    // Step 8: Pin entry A to the timeline (PAT)
    const pinRes = await appRequest('POST', `/api/universes/${uid}/entries/${entryAId}/pin`, {
      body: { label: 'Year 0 — The Sundering', position: 0, precision: 'exact' },
      headers: patHdr,
    });
    expect(pinRes.status, 'pin timeline entry').toBe(200);

    // Step 9: Smoke check graph-data endpoint reachable (PAT)
    const graphRes = await appRequest('GET', `/api/universes/${uid}/graph-data`, {
      headers: patHdr,
    });
    expect(graphRes.status, 'graph-data smoke').toBe(200);
    expect(Array.isArray(graphRes.body.nodes), 'graph has nodes array').toBe(true);
    expect(graphRes.body.nodes.length, 'graph has at least 2 nodes').toBeGreaterThanOrEqual(2);

    // Step 9a: graph-positions round-trip
    // graph-positions: write via POST /bulk, read back via GET /graph-data (positions array)
    const positionsPayload = [
      { entryId: entryAId, x: 100, y: 200 },
      { entryId: entryBId, x: 300, y: 400 },
    ];
    const bulkPosRes = await appRequest('POST', `/api/universes/${uid}/graph-positions/bulk`, {
      body: positionsPayload,
      headers: patHdr,
    });
    expect(bulkPosRes.status, 'graph-positions bulk upsert').toBe(200);
    expect(bulkPosRes.body.upserted, 'bulk upserted 2').toBe(2);

    // Read back positions via GET /graph-data (graph-positions has no GET route)
    const graphDataRes = await appRequest('GET', `/api/universes/${uid}/graph-data`, {
      headers: patHdr,
    });
    expect(graphDataRes.status, 'graph-data after positions write').toBe(200);
    const posA = (graphDataRes.body.positions as Array<{ entryId: string; x: number; y: number }>).find(
      (p) => p.entryId === entryAId,
    );
    const posB = (graphDataRes.body.positions as Array<{ entryId: string; x: number; y: number }>).find(
      (p) => p.entryId === entryBId,
    );
    expect(posA, 'posA found in positions').toBeTruthy();
    expect(posA!.x, 'posA.x').toBe(100);
    expect(posA!.y, 'posA.y').toBe(200);
    expect(posB, 'posB found in positions').toBeTruthy();
    expect(posB!.x, 'posB.x').toBe(300);
    expect(posB!.y, 'posB.y').toBe(400);

    // Step 9b: timeline-list round-trip
    const timelineRes = await appRequest('GET', `/api/universes/${uid}/timeline`, {
      headers: patHdr,
    });
    expect(timelineRes.status, 'timeline list').toBe(200);
    // The pin from Step 8 used label: 'Year 0 — The Sundering'
    expect(JSON.stringify(timelineRes.body)).toContain('Year 0 — The Sundering');

    // Step 10: Export universe as JSON (PAT)
    const exportRes = await appRequest('GET', `/api/universes/${uid}/export?format=json`, {
      headers: patHdr,
    });
    expect(exportRes.status, 'export json').toBe(200);
    const exportedJson = exportRes.body;
    expect(exportedJson.weltbon_version).toBe('1.0.0');
    expect(exportedJson.entries).toHaveLength(2);
    expect(exportedJson.links).toHaveLength(1);

    // Step 10a: markdown export (binary ZIP response)
    const mdRes = await app.fetch(new Request(`http://localhost/api/universes/${uid}/export?format=markdown`, { headers: patHdr }));
    expect(mdRes.status, 'markdown export status').toBe(200);
    const mdCT = mdRes.headers.get('content-type') ?? '';
    expect(mdCT.toLowerCase()).toMatch(/(application\/zip|text\/markdown)/);
    const mdBuf = Buffer.from(await mdRes.arrayBuffer());
    expect(mdBuf.length, 'markdown export non-empty').toBeGreaterThan(0);

    // Step 10b: docx export
    const docxRes = await app.fetch(new Request(`http://localhost/api/universes/${uid}/export?format=docx`, { headers: patHdr }));
    expect(docxRes.status, 'docx export status').toBe(200);
    expect(docxRes.headers.get('content-type') ?? '').toContain('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const docxBuf = Buffer.from(await docxRes.arrayBuffer());
    expect(docxBuf.length, 'docx export non-empty').toBeGreaterThan(0);
    // DOCX files are ZIP archives; magic bytes are 'PK\x03\x04'
    expect(docxBuf[0]).toBe(0x50);
    expect(docxBuf[1]).toBe(0x4b);

    // Step 10c: pdf export (skip-safe if Chromium unavailable)
    // PDF rendering requires Chromium. If unavailable, skip the format-pdf assertion gracefully.
    const chromiumPath = process.env.CHROMIUM_PATH;
    const skipPdf = !chromiumPath;
    if (!skipPdf) {
      const pdfRes = await app.fetch(new Request(`http://localhost/api/universes/${uid}/export?format=pdf`, { headers: patHdr }));
      expect(pdfRes.status, 'pdf export status').toBe(200);
      expect(pdfRes.headers.get('content-type') ?? '').toContain('application/pdf');
      const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
      expect(pdfBuf.length, 'pdf export non-empty').toBeGreaterThan(0);
      // PDF magic bytes are '%PDF'
      expect(pdfBuf.subarray(0, 4).toString('ascii')).toBe('%PDF');
    }

    // Step 11: Import into a NEW universe (PAT)
    const importRes = await appRequest('POST', '/api/universes/import', {
      body: exportedJson,
      headers: patHdr,
    });
    expect(importRes.status, 'import to new universe').toBe(201);
    const importedUid: string = importRes.body.universeId;
    expect(importedUid).toBeTruthy();
    expect(importedUid).not.toBe(uid);

    // Step 12: Re-export the imported universe (PAT)
    const reExportRes = await appRequest('GET', `/api/universes/${importedUid}/export?format=json`, {
      headers: patHdr,
    });
    expect(reExportRes.status, 're-export imported universe').toBe(200);
    const reExportedJson = reExportRes.body;

    // ─── Round-trip identity assertion (D-10) ────────────────────────────────
    // Entry titles must be preserved (modulo new IDs/timestamps)
    const origTitles = exportedJson.entries
      .map((e: { title: string }) => e.title)
      .sort();
    const reimportTitles = reExportedJson.entries
      .map((e: { title: string }) => e.title)
      .sort();
    expect(reimportTitles, 'round-trip: entry titles match').toEqual(origTitles);

    // Link labels must be preserved
    const origLinkLabels = exportedJson.links
      .map((l: { label: string }) => l.label)
      .sort();
    const reimportLinkLabels = reExportedJson.links
      .map((l: { label: string }) => l.label)
      .sort();
    expect(reimportLinkLabels, 'round-trip: link labels match').toEqual(origLinkLabels);

    // Category labels must be preserved
    const origCatLabels = (exportedJson.categories ?? [])
      .map((c: { label: string }) => c.label)
      .sort();
    const reimportCatLabels = (reExportedJson.categories ?? [])
      .map((c: { label: string }) => c.label)
      .sort();
    expect(reimportCatLabels, 'round-trip: category labels match').toEqual(origCatLabels);

    // Issue titles must be preserved
    const origIssueTitles = (exportedJson.issues ?? [])
      .map((i: { title: string }) => i.title)
      .sort();
    const reimportIssueTitles = (reExportedJson.issues ?? [])
      .map((i: { title: string }) => i.title)
      .sort();
    expect(reimportIssueTitles, 'round-trip: issue titles match').toEqual(origIssueTitles);

    // Timeline pins must be preserved (label + position + precision)
    type Pin = { label: string; position: number; precision: string };
    const origPins = (exportedJson.timelinePins ?? []) as Pin[];
    const reimportPins = (reExportedJson.timelinePins ?? []) as Pin[];
    expect(reimportPins, 'round-trip: pin count matches').toHaveLength(origPins.length);
    for (const p of origPins) {
      const match = reimportPins.find(
        (x) => x.label === p.label && x.position === p.position && x.precision === p.precision,
      );
      expect(match, `round-trip: pin "${p.label}" preserved`).toBeTruthy();
    }

    // Step 13: ingest preview + commit round-trip (PAT)
    const fixtureMd = '# Ingested Test Entry\n\nA tiny body for parity coverage.\n';
    const form = new FormData();
    form.append('files', new Blob([fixtureMd], { type: 'text/markdown' }), 'ingested-test.md');
    const ingestRes = await app.fetch(
      new Request(`http://localhost/api/universes/${uid}/ingest`, {
        method: 'POST',
        headers: patHdr, // do NOT set Content-Type; fetch will set the multipart boundary
        body: form,
      }),
    );
    expect(ingestRes.status, 'ingest preview').toBe(200);
    const preview = await ingestRes.json() as { entries: Array<any> };
    expect(Array.isArray(preview.entries), 'preview.entries is array').toBe(true);
    expect(preview.entries.length, 'preview has the fixture entry').toBe(1);

    // Build commit body from preview — each entry needs a decision
    const commitBody = {
      entries: preview.entries.map((e: any) => ({
        ...e,
        decision: { disposition: 'accept' },
        category: null,
      })),
    };
    const commitRes = await appRequest('POST', `/api/universes/${uid}/ingest/commit`, {
      body: commitBody,
      headers: patHdr,
    });
    expect(commitRes.status, 'ingest commit').toBe(200);
    expect(Array.isArray(commitRes.body.entryIds), 'commit returns entryIds[]').toBe(true);
    expect(commitRes.body.entryIds.length, 'commit created 1 entry').toBe(1);

    // Verify the ingested entry is queryable via the entries list
    const entriesRes = await appRequest('GET', `/api/universes/${uid}/entries`, { headers: patHdr });
    expect(entriesRes.status).toBe(200);
    const titles = (entriesRes.body as Array<{ title: string }>).map((e) => e.title);
    expect(titles, 'ingested entry surfaces in entries list').toContain('Ingested Test Entry');
  });

  // ─── Test 2: PAT meta-API rejection smoke (D-11 / D-13 regression guard) ─

  it('smoke: GET /api/auth/tokens with PAT bearer returns 401 (D-13 regression guard)', async () => {
    const { jwt } = await createUserAndJwt('d13smoke@test.com');

    // Mint a PAT via JWT
    const mintRes = await appRequest('POST', '/api/auth/tokens', {
      body: { label: 'smoke-pat' },
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(mintRes.status).toBe(200);
    const { plaintext } = mintRes.body;

    // PAT bearer must be rejected on the meta-API (D-13)
    const res = await appRequest('GET', '/api/auth/tokens', {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    expect(res.status, 'PAT bearer rejected on meta-API').toBe(401);
  });
});

import yauzl from 'yauzl';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { generateShareToken } from '../src/services/share-token.js';
import { setTestDb, db } from '../src/db/client.js';
import {
  dictionaryWords,
  diagrams,
  diagramNodes,
  shareTokens,
  entries,
  links,
  universes,
  type Calendar,
  type UniverseTheme,
  type FieldRegistryEntry,
} from '../src/db/schema.js';

describe('export/import completeness', () => {
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

  /** Extract and parse manifest.json from an export ZIP buffer (mirrors export-import.test.ts :50-83). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function extractManifest(zipBytes: Buffer): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      yauzl.fromBuffer(zipBytes, { lazyEntries: true }, (err, zipfile) => {
        if (err || !zipfile) return reject(err ?? new Error('yauzl.fromBuffer returned no zipfile'));
        zipfile.on('error', reject);
        zipfile.on('entry', (entry: yauzl.Entry) => {
          if (entry.fileName !== 'manifest.json') {
            zipfile.readEntry();
            return;
          }
          zipfile.openReadStream(entry, (streamErr, rs) => {
            if (streamErr || !rs) return reject(streamErr ?? new Error('no readStream'));
            const chunks: Buffer[] = [];
            rs.on('data', (c: Buffer) => chunks.push(c));
            rs.on('end', () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
              catch (parseErr) { reject(parseErr); }
            });
            rs.on('error', reject);
          });
        });
        zipfile.on('end', () => reject(new Error('manifest.json not found in ZIP')));
        zipfile.readEntry();
      });
    });
  }

  /** Export a universe as a ZIP buffer (the ?format=json route returns application/zip). */
  async function exportAsZipBuffer(uid: string, hdrs: Record<string, string>): Promise<Buffer> {
    const res = await app.request(`http://localhost/api/universes/${uid}/export?format=json`, {
      headers: { ...hdrs },
    });
    if (res.status !== 200) throw new Error(`export failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** GET the ?format=json export ZIP and return its parsed manifest.json. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function exportManifest(uid: string, hdrs: Record<string, string>): Promise<Record<string, any>> {
    return extractManifest(await exportAsZipBuffer(uid, hdrs));
  }

  /** Import a ZIP buffer via multipart POST and return the import result JSON. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function importZipBuffer(zipBytes: Buffer, hdrs: Record<string, string>): Promise<{ status: number; body: any }> {
    const fd = new FormData();
    const blob = new Blob([zipBytes], { type: 'application/zip' });
    fd.append('file', blob, 'universe.zip');
    const res = await app.request('http://localhost/api/universes/import', {
      method: 'POST',
      headers: { ...hdrs },
      body: fd,
    });
    return { status: res.status, body: await res.json() };
  }

  async function createUniverse(hdrs: Record<string, string>, name = 'TestWorld') {
    const res = await req('POST', '/api/universes', { headers: hdrs, body: { name } });
    return json(res);
  }

  async function createEntry(uid: string, hdrs: Record<string, string>, overrides: Record<string, unknown> = {}) {
    const body = {
      title: 'Test Entry',
      entryType: 'entity',
      summary: 'A test entry',
      body: 'Full body text',
      tags: ['test'],
      meta: { key: 'value' },
      icon: 'star',
      ...overrides,
    };
    const res = await req('POST', `/api/universes/${uid}/entries`, { headers: hdrs, body });
    return json(res);
  }

  // A distinctive, fully-populated Calendar so misrouted fields fail loudly.
  function buildCalendar(): Calendar {
    return {
      eras: [{ name: 'Second Age', abbr: 'SA', startPosition: 0 }],
      months: [{ name: 'Frostmoon', lengthDays: 30 }],
      weekdays: ['Moonday', 'Starday'],
      moons: [{ name: 'Selene', cycleDays: 28 }],
      beforeEraAbbr: 'BE',
    };
  }

  function buildTheme(): UniverseTheme {
    return { palette: 'ember', accent: '#ff8800' };
  }

  function buildFieldRegistry(): FieldRegistryEntry[] {
    return [{ name: 'Power Level', type: 'number', hint: 'Combat rating' }];
  }

  // ── Scenario 1: manifest completeness ─────────────────────────────────────

  it('manifest completeness: version 2.2.0 + dictionary/diagrams/shareTokens + link styling + universe state + updatedAt spot-checks', async () => {
    const { hdrs, user } = await userWithToken('completeness-exp@test.com');
    const universe = await createUniverse(hdrs, 'CompletenessWorld');

    const langEntry = await createEntry(universe.id, hdrs, { title: 'Quenya' });
    const subjectA = await createEntry(universe.id, hdrs, { title: 'Diagram Subject A' });
    const subjectB = await createEntry(universe.id, hdrs, { title: 'Diagram Subject B' });

    const wipEntry = await createEntry(universe.id, hdrs, { title: 'Draft Entry', wip: true });

    // Dictionary: one entry-scoped word, one universe-level (languageEntryId: null).
    await db().insert(dictionaryWords).values([
      {
        universeId: universe.id,
        languageEntryId: langEntry.id,
        word: 'quenya-word',
        ipa: 'ˈkwɛn.jɑ',
        partOfSpeech: 'noun',
        gloss: 'star',
        etymology: 'archaic root',
        tags: ['noun-class-1'],
      },
      {
        universeId: universe.id,
        languageEntryId: null,
        word: 'universal-word',
        gloss: 'universal fallback gloss',
      },
    ]);

    const [diagram] = await db()
      .insert(diagrams)
      .values({ universeId: universe.id, name: 'Family Tree', description: 'a test diagram' })
      .returning();
    await db().insert(diagramNodes).values([
      { diagramId: diagram!.id, entryId: subjectA.id, x: 10, y: 20 },
      { diagramId: diagram!.id, entryId: subjectB.id, x: 30, y: 40 },
    ]);


    // is asserted HERE and only here: it is deliberately not importable (import
    // mints fresh diagram ids), so the round-trip scenario structurally cannot
    // catch its removal from the manifest.
    await db().insert(links).values({
      universeId: universe.id,
      sourceEntryId: subjectA.id,
      targetEntryId: subjectB.id,
      direction: 'directed',
      linkType: 'sibling',
      diagramId: diagram!.id,
      lineStyle: 'dashed',
      color: '#ff0000',
    });

    const seed = generateShareToken();
    await db().insert(shareTokens).values({
      userId: user.id,
      universeId: universe.id,
      scope: 'entry',
      scopeEntryId: langEntry.id,
      label: 'completeness-share',
      hash: seed.hash,
      bodySuffix: seed.bodySuffix,
    });

    await db()
      .update(universes)
      .set({
        calendar: buildCalendar(),
        theme: buildTheme(),
        fieldRegistry: buildFieldRegistry(),
        auditEnabled: true,
        auditProvider: 'anthropic',
        auditModel: 'claude-test-model',
      })
      .where(eq(universes.id, universe.id));

    const data = await exportManifest(universe.id, hdrs);

    expect(data.weltbon_version).toBe('2.2.0');
    expect(data.dictionaryWords).toHaveLength(2);
    expect(data.diagrams).toHaveLength(1);
    expect(data.diagramNodes).toHaveLength(2);
    expect(data.shareTokens).toHaveLength(1);

    expect(data.universe.calendar.months[0].name).toBe('Frostmoon');
    expect(data.universe.theme.palette).toBe('ember');
    expect(data.universe.fieldRegistry[0].name).toBe('Power Level');
    expect(data.universe.auditEnabled).toBe(true);
    expect(data.universe.auditProvider).toBe('anthropic');
    expect(data.universe.auditModel).toBe('claude-test-model');


    // used to omit id/createdAt/updatedAt entirely (B-06 merge prerequisite).
    expect(data.universe.id).toBe(universe.id);
    expect(data.universe.createdAt).toBeTruthy();
    expect(data.universe.updatedAt).toBeTruthy();


    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const draftEntry = data.entries.find((e: any) => e.id === wipEntry.id);
    expect(draftEntry).toBeTruthy();
    expect(draftEntry.wip).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const langEntryManifest = data.entries.find((e: any) => e.id === langEntry.id);
    expect(langEntryManifest.wip).toBe(false);

    // updatedAt spot-checks: entries + dictionaryWords.
    expect(data.entries[0].updatedAt).toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const scopedWord = data.dictionaryWords.find((w: any) => w.word === 'quenya-word');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const universalWord = data.dictionaryWords.find((w: any) => w.word === 'universal-word');
    expect(scopedWord).toBeTruthy();
    expect(scopedWord.updatedAt).toBeTruthy();
    expect(scopedWord.createdAt).toBeTruthy();
    expect(scopedWord.languageEntryId).toBe(langEntry.id);
    expect(universalWord.languageEntryId).toBeNull();


    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exportedLink = data.links.find((l: any) => l.lineStyle !== null);
    expect(exportedLink).toBeDefined();
    expect(exportedLink.lineStyle).toBe('dashed');
    expect(exportedLink.color).toBe('#ff0000');
    expect(exportedLink.link_type).toBe('sibling');
    // Diagram edge membership — carried by sync (S-05 preserves ids), never by import.
    expect(exportedLink.diagramId).toBe(diagram!.id);

    expect(data.diagrams[0].updatedAt).toBeTruthy();
    expect(data.diagramNodes[0].updatedAt).toBeTruthy();
    expect(data.shareTokens[0].updatedAt).toBeTruthy();
    expect(data.shareTokens[0].hash).toBe(seed.hash);
  });

  // ── Scenario 2: round-trip fidelity ───────────────────────────────────────

  it('round-trip fidelity: remapped languageEntryId/diagram entryIds/scopeEntryId, original hash, importer-owned userId, universe state equality', async () => {
    const { hdrs: hdrs1, user: user1 } = await userWithToken('rt-exp@test.com');
    const universe = await createUniverse(hdrs1, 'RTWorld');

    const langEntry = await createEntry(universe.id, hdrs1, { title: 'Quenya' });
    const diagramSubject = await createEntry(universe.id, hdrs1, { title: 'Diagram Subject' });

    await createEntry(universe.id, hdrs1, { title: 'Draft Entry', wip: true });

    await db().insert(dictionaryWords).values([
      { universeId: universe.id, languageEntryId: langEntry.id, word: 'quenya-word', gloss: 'star' },
      { universeId: universe.id, languageEntryId: null, word: 'universal-word', gloss: 'universal' },
    ]);

    const [diagram] = await db()
      .insert(diagrams)
      .values({ universeId: universe.id, name: 'Family Tree' })
      .returning();
    await db().insert(diagramNodes).values([
      { diagramId: diagram!.id, entryId: diagramSubject.id, x: 1, y: 2 },
    ]);


    await db().insert(links).values({
      universeId: universe.id,
      sourceEntryId: langEntry.id,
      targetEntryId: diagramSubject.id,
      direction: 'directed',
      diagramId: diagram!.id,
      lineStyle: 'dashed',
      color: '#ff0000',
    });

    const seed = generateShareToken();
    await db().insert(shareTokens).values({
      userId: user1.id,
      universeId: universe.id,
      scope: 'entry',
      scopeEntryId: langEntry.id,
      label: 'rt-share',
      hash: seed.hash,
      bodySuffix: seed.bodySuffix,
    });

    await db()
      .update(universes)
      .set({
        calendar: buildCalendar(),
        theme: buildTheme(),
        fieldRegistry: buildFieldRegistry(),
        auditEnabled: true,
      })
      .where(eq(universes.id, universe.id));

    const zipBytes = await exportAsZipBuffer(universe.id, hdrs1);

    // The `hash` column is globally unique (not per-universe) — A2-04's restore
    // scenario assumes the source token is no longer live (the backup/restore
    // use case, D-XX). Delete the source row so the import below isn't skipped
    // by onConflictDoNothing against itself.
    await db().delete(shareTokens).where(eq(shareTokens.hash, seed.hash));

    const { hdrs: hdrs2, user: user2 } = await userWithToken('rt-imp@test.com');
    const { status, body: importResult } = await importZipBuffer(zipBytes, hdrs2);
    expect(status).toBe(201);
    expect(importResult.dictionaryWordCount).toBe(2);
    expect(importResult.diagramCount).toBe(1);
    expect(importResult.diagramNodeCount).toBe(1);
    expect(importResult.shareTokenCount).toBe(1);

    const importedEntries = await db().select().from(entries).where(eq(entries.universeId, importResult.universeId));
    const newLangEntry = importedEntries.find((e) => e.title === 'Quenya');
    const newSubjectEntry = importedEntries.find((e) => e.title === 'Diagram Subject');
    expect(newLangEntry).toBeTruthy();
    expect(newSubjectEntry).toBeTruthy();
    expect(newLangEntry!.id).not.toBe(langEntry.id);


    const newDraftEntry = importedEntries.find((e) => e.title === 'Draft Entry');
    expect(newDraftEntry).toBeTruthy();
    expect(newDraftEntry!.wip).toBe(true);
    expect(newLangEntry!.wip).toBe(false);

    const importedWords = await db().select().from(dictionaryWords).where(eq(dictionaryWords.universeId, importResult.universeId));
    const scopedWord = importedWords.find((w) => w.word === 'quenya-word');
    const universalWord = importedWords.find((w) => w.word === 'universal-word');
    expect(scopedWord).toBeTruthy();
    expect(scopedWord!.languageEntryId).toBe(newLangEntry!.id);
    expect(scopedWord!.languageEntryId).not.toBe(langEntry.id);
    expect(universalWord).toBeTruthy();
    expect(universalWord!.languageEntryId).toBeNull();

    const importedNodes = await db()
      .select({ diagramId: diagramNodes.diagramId, entryId: diagramNodes.entryId })
      .from(diagramNodes)
      .innerJoin(diagrams, eq(diagrams.id, diagramNodes.diagramId))
      .where(eq(diagrams.universeId, importResult.universeId));
    expect(importedNodes).toHaveLength(1);
    expect(importedNodes[0]!.entryId).toBe(newSubjectEntry!.id);
    expect(importedNodes[0]!.entryId).not.toBe(diagramSubject.id);


    // (import mints fresh diagram ids — sync, not import, preserves it).
    const importedLinks = await db().select().from(links).where(eq(links.universeId, importResult.universeId));
    expect(importedLinks).toHaveLength(1);
    expect(importedLinks[0]!.lineStyle).toBe('dashed');
    expect(importedLinks[0]!.color).toBe('#ff0000');
    // ...but diagramId does NOT: the seeded link belonged to a diagram, and import
    // mints fresh diagram ids, so the incoming value is meaningless here by design.
    expect(importedLinks[0]!.diagramId).toBeNull();
    expect(importedLinks[0]!.sourceEntryId).toBe(newLangEntry!.id);
    expect(importedLinks[0]!.targetEntryId).toBe(newSubjectEntry!.id);

    const importedTokens = await db().select().from(shareTokens).where(eq(shareTokens.universeId, importResult.universeId));
    expect(importedTokens).toHaveLength(1);
    expect(importedTokens[0]!.hash).toBe(seed.hash);
    expect(importedTokens[0]!.userId).toBe(user2.id);
    expect(importedTokens[0]!.userId).not.toBe(user1.id);
    expect(importedTokens[0]!.scopeEntryId).toBe(newLangEntry!.id);

    const [importedUniverse] = await db().select().from(universes).where(eq(universes.id, importResult.universeId));
    expect((importedUniverse!.calendar as Calendar).months[0]!.name).toBe('Frostmoon');
    expect((importedUniverse!.theme as UniverseTheme).palette).toBe('ember');
    expect((importedUniverse!.fieldRegistry as FieldRegistryEntry[])[0]!.name).toBe('Power Level');
    expect(importedUniverse!.auditEnabled).toBe(true);


    // import always mints a fresh universe id (sync, not import, preserves ids).
    expect(importedUniverse!.id).not.toBe(universe.id);
    expect(importedUniverse!.id).toBe(importResult.universeId);
  });

  // ── Scenario 3: timestamps re-stamped on import (A2-03) ───────────────────

  it('timestamps re-stamped on import: imported dictionary word createdAt reflects the import moment, not the source row (A2-03)', async () => {
    const { hdrs: hdrs1 } = await userWithToken('stamp-exp@test.com');
    const universe = await createUniverse(hdrs1, 'StampWorld');

    const oldDate = new Date('2020-01-01T00:00:00.000Z');
    await db().insert(dictionaryWords).values({
      universeId: universe.id,
      word: 'ancient-word',
      gloss: 'an old gloss',
      createdAt: oldDate,
      updatedAt: oldDate,
    });

    const zipBytes = await exportAsZipBuffer(universe.id, hdrs1);
    const manifest = await extractManifest(zipBytes);
    // Confirm the manifest itself carries the OLD timestamp (payload fidelity).
    expect(manifest.dictionaryWords[0].createdAt).toBe(oldDate.toISOString());

    const beforeImport = new Date();
    const { hdrs: hdrs2 } = await userWithToken('stamp-imp@test.com');
    const { status, body: importResult } = await importZipBuffer(zipBytes, hdrs2);
    expect(status).toBe(201);

    const importedWords = await db().select().from(dictionaryWords).where(eq(dictionaryWords.universeId, importResult.universeId));
    expect(importedWords).toHaveLength(1);
    const importedCreatedAt = importedWords[0]!.createdAt as Date;
    expect(importedCreatedAt.getTime()).toBeGreaterThanOrEqual(beforeImport.getTime());
    expect(importedCreatedAt.getTime()).not.toBe(oldDate.getTime());
  });

  // ── Scenario 4: double-import hash skip (A2-04) ────────────────────────────

  it('double-import hash skip: re-importing the same manifest twice succeeds and leaves the second universe with 0 share tokens (A2-04)', async () => {
    const { hdrs: hdrs1, user: user1 } = await userWithToken('dup-exp@test.com');
    const universe = await createUniverse(hdrs1, 'DupWorld');

    const seed = generateShareToken();
    await db().insert(shareTokens).values({
      userId: user1.id,
      universeId: universe.id,
      label: 'dup-share',
      hash: seed.hash,
      bodySuffix: seed.bodySuffix,
    });

    const zipBytes = await exportAsZipBuffer(universe.id, hdrs1);

    // The `hash` column is globally unique (not per-universe) — delete the
    // source row so the FIRST import below isn't skipped by onConflictDoNothing
    // against the still-live source token (mirrors the round-trip test's fix;
    // this simulates the backup/restore scenario where the source is gone).
    await db().delete(shareTokens).where(eq(shareTokens.hash, seed.hash));

    const { hdrs: hdrs2 } = await userWithToken('dup-imp@test.com');

    const first = await importZipBuffer(zipBytes, hdrs2);
    expect(first.status).toBe(201);
    const firstTokens = await db().select().from(shareTokens).where(eq(shareTokens.universeId, first.body.universeId));
    expect(firstTokens).toHaveLength(1);
    expect(firstTokens[0]!.hash).toBe(seed.hash);

    // Import the SAME zip bytes again — the hash unique constraint means the
    // second universe gets zero share-token rows, but the import still succeeds.
    const second = await importZipBuffer(zipBytes, hdrs2);
    expect(second.status).toBe(201);
    expect(second.body.universeId).not.toBe(first.body.universeId);
    const secondTokens = await db().select().from(shareTokens).where(eq(shareTokens.universeId, second.body.universeId));
    expect(secondTokens).toHaveLength(0);
  });

  // ── Scenario 5: legacy manifests import cleanly ────────────────────────────

  it('legacy manifests: minimal 2.0.0 and 1.0.0 payloads import cleanly with new collections empty and universe fields at defaults', async () => {
    const { hdrs } = await userWithToken('legacy@test.com');

    const legacy200 = {
      weltbon_version: '2.0.0',
      exported_at: new Date().toISOString(),
      universe: { name: 'Legacy200World', description: '' },
      entries: [
        {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
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
      // NO dictionaryWords/diagrams/diagramNodes/shareTokens/calendar/theme/fieldRegistry/audit* keys.
    };

    const res200 = await req('POST', '/api/universes/import', { headers: hdrs, body: legacy200 });
    expect(res200.status).toBe(201);
    const result200 = await json(res200);
    expect(result200.dictionaryWordCount).toBe(0);
    expect(result200.diagramCount).toBe(0);
    expect(result200.diagramNodeCount).toBe(0);
    expect(result200.shareTokenCount).toBe(0);

    const [universe200] = await db().select().from(universes).where(eq(universes.id, result200.universeId));
    expect(universe200!.calendar).toBeNull();
    expect(universe200!.theme).toBeNull();
    expect(universe200!.fieldRegistry).toEqual([]);
    expect(universe200!.auditEnabled).toBe(false);
    expect(universe200!.auditProvider).toBeNull();
    expect(universe200!.auditModel).toBeNull();

    const legacy100 = {
      weltbon_version: '1.0.0',
      exported_at: new Date().toISOString(),
      universe: { name: 'Legacy100World', description: '' },
      entries: [
        {
          id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
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
    };

    const res100 = await req('POST', '/api/universes/import', { headers: hdrs, body: legacy100 });
    expect(res100.status).toBe(201);
    const result100 = await json(res100);
    expect(result100.entryCount).toBe(1);
    expect(result100.dictionaryWordCount).toBe(0);
    expect(result100.diagramCount).toBe(0);
    expect(result100.diagramNodeCount).toBe(0);
    expect(result100.shareTokenCount).toBe(0);

    const [universe100] = await db().select().from(universes).where(eq(universes.id, result100.universeId));
    expect(universe100!.calendar).toBeNull();
    expect(universe100!.theme).toBeNull();
    expect(universe100!.fieldRegistry).toEqual([]);
    expect(universe100!.auditEnabled).toBe(false);
  });

  // ── Scenario 6: strict-FK orphan is atomic ────────────────────────────────

  it('strict-FK failure is atomic: diagramNodes referencing a nonexistent entry fails the import and leaves no new universe row', async () => {
    const { hdrs } = await userWithToken('atomic-diagram@test.com');

    const beforeRes = await req('GET', '/api/universes', { headers: hdrs });
    const beforeUniverses = await json(beforeRes);
    const countBefore = beforeUniverses.length;

    const importData = {
      weltbon_version: '2.2.0',
      exported_at: new Date().toISOString(),
      universe: { name: 'DiagramAtomicFail', description: '' },
      entries: [],
      links: [],
      diagrams: [
        { id: '11111111-1111-4111-8111-111111111111', name: 'Orphan Diagram' },
      ],
      diagramNodes: [
        {
          diagramId: '11111111-1111-4111-8111-111111111111',
          entryId: '22222222-2222-4222-8222-222222222222', // does not exist
          x: 0,
          y: 0,
        },
      ],
    };

    const res = await req('POST', '/api/universes/import', { headers: hdrs, body: importData });
    expect(res.status).toBe(400);

    const afterRes = await req('GET', '/api/universes', { headers: hdrs });
    const afterUniverses = await json(afterRes);
    expect(afterUniverses.length).toBe(countBefore);
  });
});

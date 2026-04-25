import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { fromBuffer, type ZipFile, type Entry } from 'yauzl';
import { createApp } from '../src/index.js';
import {
  createTestDb,
  cleanDb,
  createTestUser,
  authHeader,
  type TestDbHandle,
} from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb, db } from '../src/db/client.js';
import {
  categories as categoriesTable,
  entries as entriesTable,
  links as linksTable,
  issues as issuesTable,
  issueEntries as issueEntriesTable,
} from '../src/db/schema.js';

/**
 * Plan 04-04 EXP-04 + EXP-05 (DOCX) integration coverage.
 *
 * Builds a small fixture universe, exports as ?format=docx, unzips the
 * resulting .docx (which is a ZIP), and asserts on word/document.xml for
 * the required style references (Title / Heading1 / Heading2), the
 * TableOfContents field code, features.updateFields, bold/italic
 * formatting from the markdown body, and the absence of resolved-issue
 * content.
 */

describe('EXP-04: DOCX exporter — full integration', () => {
  let handle: TestDbHandle;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    handle = await createTestDb();
    setTestDb(handle.db as never, handle.pool);
    app = createApp();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
  });

  /** Read word/document.xml out of a .docx ZIP buffer. */
  function readDocumentXml(buf: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      fromBuffer(buf, { lazyEntries: true }, (err: Error | null, zip?: ZipFile) => {
        if (err || !zip) return reject(err ?? new Error('no zip'));
        zip.readEntry();
        zip.on('entry', (entry: Entry) => {
          if (entry.fileName !== 'word/document.xml') {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (err2: Error | null, stream) => {
            if (err2 || !stream) return reject(err2 ?? new Error('no stream'));
            const chunks: Buffer[] = [];
            stream.on('data', (c: Buffer) => chunks.push(c));
            stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            stream.on('error', reject);
          });
        });
        zip.on('end', () => reject(new Error('word/document.xml not found')));
        zip.on('error', reject);
      });
    });
  }

  it('produces a valid DOCX with Title style, Heading1/2 hierarchy, TOC field, updateFields, walker-rendered formatting, and resolved issues filtered out', async () => {
    const user = await createTestUser(handle, {
      email: 'docx-export@test.com',
      password: 'longenoughpw12',
    });
    const token = await issueAccessToken(user.id);
    const hdrs = authHeader(token);

    const createUniverseRes = await app.request('http://localhost/universes', {
      method: 'POST',
      headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Docx Test World', description: 'A small world' }),
    });
    const universe = await createUniverseRes.json();

    // 2 categories
    const [people] = await db()
      .insert(categoriesTable)
      .values({ universeId: universe.id, label: 'People', icon: '', sortOrder: 0 })
      .returning();
    const [places] = await db()
      .insert(categoriesTable)
      .values({ universeId: universe.id, label: 'Places', icon: '', sortOrder: 1 })
      .returning();

    // 3 entries — entry A has rich markdown body (bold, italic, list, link, H1)
    const [entryA] = await db()
      .insert(entriesTable)
      .values({
        universeId: universe.id,
        title: 'Alice',
        entryType: 'entity',
        summary: 'A protagonist',
        body:
          '# inner heading\n\n' +
          'A line with **bold text** and *italic text* and `code`.\n\n' +
          '- list item one\n- list item two\n\n' +
          '[example](https://example.com)\n',
        tags: ['hero'],
        meta: {},
        icon: '',
        categoryId: people.id,
      })
      .returning();
    const [entryB] = await db()
      .insert(entriesTable)
      .values({
        universeId: universe.id,
        title: 'Bob',
        entryType: 'entity',
        summary: '',
        body: 'Plain body.',
        tags: [],
        meta: {},
        icon: '',
        categoryId: people.id,
      })
      .returning();
    const [entryC] = await db()
      .insert(entriesTable)
      .values({
        universeId: universe.id,
        title: 'Capital',
        entryType: 'location',
        summary: '',
        body: '',
        tags: [],
        meta: {},
        icon: '',
        categoryId: places.id,
      })
      .returning();

    // 1 link (A → C, knows)
    await db()
      .insert(linksTable)
      .values({
        universeId: universe.id,
        sourceEntryId: entryA.id,
        targetEntryId: entryC.id,
        label: 'knows',
        bidirectional: false,
      });

    // 1 open issue on A (CRITICAL), 1 resolved issue on B
    const [openIssue] = await db()
      .insert(issuesTable)
      .values({
        universeId: universe.id,
        title: 'A blocking concern about Alice',
        description: 'Needs follow-up',
        severity: 'critical',
        resolved: false,
      })
      .returning();
    await db()
      .insert(issueEntriesTable)
      .values({ issueId: openIssue.id, entryId: entryA.id });

    const [resolvedIssue] = await db()
      .insert(issuesTable)
      .values({
        universeId: universe.id,
        title: 'Already resolved historical issue',
        description: 'Old',
        severity: 'minor',
        resolved: true,
      })
      .returning();
    await db()
      .insert(issueEntriesTable)
      .values({ issueId: resolvedIssue.id, entryId: entryB.id });

    // ---------- export docx ----------
    const res = await app.request(
      `http://localhost/universes/${universe.id}/export?format=docx`,
      { headers: hdrs },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(/attachment;\s*filename="docx-test-world-\d{4}-\d{2}-\d{2}\.docx"/);

    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(1000); // not empty

    // ZIP magic
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);

    const xml = await readDocumentXml(buf);

    // ---------- Title style on universe name ----------
    expect(xml).toContain('w:val="Title"');
    expect(xml).toContain('Docx Test World');

    // ---------- Heading1: TOC heading + 2 categories with entries ----------
    // "Contents" Heading1 + "People" Heading1 + "Places" Heading1 = 3 occurrences
    const heading1Count = (xml.match(/w:val="Heading1"/g) ?? []).length;
    expect(heading1Count).toBeGreaterThanOrEqual(3);

    // ---------- Heading2: 3 entry titles (Alice, Bob, Capital) ----------
    const heading2Count = (xml.match(/w:val="Heading2"/g) ?? []).length;
    expect(heading2Count).toBeGreaterThanOrEqual(3);

    // ---------- TableOfContents field code ----------
    // The TOC writes <w:instrText> containing "TOC \o ..."
    expect(xml).toContain('TOC');
    // headingStyleRange: '1-2' surfaces in the field instruction
    expect(xml).toMatch(/TOC[^<]*1-2/);

    // ---------- features.updateFields = true ----------
    // docx package serializes this as <w:updateFields w:val="true"/> in settings.xml
    // — but settings.xml is not document.xml. Read settings.xml separately.
    const settingsXml = await readSettingsXml(buf);
    expect(settingsXml).toMatch(/<w:updateFields\s+w:val="true"/);

    // ---------- Walker output: bold + italic in body ----------
    expect(xml).toMatch(/<w:b\s*\/>/);
    expect(xml).toMatch(/<w:i\s*\/>/);
    expect(xml).toContain('bold text');
    expect(xml).toContain('italic text');

    // ---------- Resolved issue title MUST NOT appear ----------
    expect(xml).not.toContain('Already resolved historical issue');

    // ---------- Open issue surfaces ----------
    expect(xml).toContain('A blocking concern about Alice');
    expect(xml).toContain('[CRITICAL]');

    // ---------- Body markdown body H1 downshifts to Heading3 ----------
    expect(xml).toContain('w:val="Heading3"');
    expect(xml).toContain('inner heading');

    // ---------- Links section ----------
    expect(xml).toContain('Links');
    expect(xml).toContain('knows');
    expect(xml).toContain('Capital');

    // entry counts line on title page
    expect(xml).toMatch(/2 categories/);
    expect(xml).toMatch(/3 entries/);

    // Reference unused fixtures to keep the linter happy.
    void entryB;
    void entryC;
    void places;
  }, 30_000);

  /** Read word/settings.xml out of a .docx ZIP buffer. */
  function readSettingsXml(buf: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      fromBuffer(buf, { lazyEntries: true }, (err: Error | null, zip?: ZipFile) => {
        if (err || !zip) return reject(err ?? new Error('no zip'));
        zip.readEntry();
        zip.on('entry', (entry: Entry) => {
          if (entry.fileName !== 'word/settings.xml') {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (err2: Error | null, stream) => {
            if (err2 || !stream) return reject(err2 ?? new Error('no stream'));
            const chunks: Buffer[] = [];
            stream.on('data', (c: Buffer) => chunks.push(c));
            stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            stream.on('error', reject);
          });
        });
        zip.on('end', () => reject(new Error('word/settings.xml not found')));
        zip.on('error', reject);
      });
    });
  }
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { fromBuffer, type ZipFile, type Entry } from 'yauzl';
import yaml from 'yaml';
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
import { eq } from 'drizzle-orm';

/**
 * Plan 04-02 EXP-02 + EXP-05 (markdown ZIP) integration coverage.
 *
 * Layout: a small fixture universe (3 categories, 5 entries, 4 links,
 * 2 issues — 1 open, 1 resolved) is exported as ?format=markdown,
 * unzipped via yauzl, and asserted on at the .md content level.
 */
describe('EXP-02: markdown ZIP exporter — full integration', () => {
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

  /** Unzip a buffer into a Map<path, utf8 contents>. yauzl is callback-based; wrap in a Promise. */
  async function unzipToMap(buf: Buffer): Promise<Map<string, string>> {
    return new Promise((resolve, reject) => {
      fromBuffer(buf, { lazyEntries: true }, (err: Error | null, zip?: ZipFile) => {
        if (err || !zip) return reject(err ?? new Error('no zip'));
        const out = new Map<string, string>();
        zip.readEntry();
        zip.on('entry', (entry: Entry) => {
          if (/\/$/.test(entry.fileName)) {
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (err2: Error | null, stream) => {
            if (err2 || !stream) return reject(err2 ?? new Error('no stream'));
            const chunks: Buffer[] = [];
            stream.on('data', (c: Buffer) => chunks.push(c));
            stream.on('end', () => {
              out.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
              zip.readEntry();
            });
            stream.on('error', reject);
          });
        });
        zip.on('end', () => resolve(out));
        zip.on('error', reject);
      });
    });
  }

  /** Parse a YAML frontmatter block out of an .md file body. */
  function parseFrontmatter(content: string): Record<string, unknown> {
    const m = content.match(/^---\n([\s\S]*?)\n---/);
    expect(m, 'frontmatter block').toBeTruthy();
    return yaml.parse(m![1]) as Record<string, unknown>;
  }

  it('produces a well-formed ZIP with _index.md, per-category folders, frontmatter that parses, working relative links, bidirectional links on both sides, backlinks, and only open issues', async () => {
    // ---------- seed user + universe ----------
    const user = await createTestUser(handle, {
      email: 'md-export@test.com',
      password: 'longenoughpw12',
    });
    const token = await issueAccessToken(user.id);
    const hdrs = authHeader(token);

    const createUniverseRes = await app.request('http://localhost/universes', {
      method: 'POST',
      headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Markdown Test World' }),
    });
    const universe = await createUniverseRes.json();

    // ---------- seed 3 categories with explicit sortOrder ----------
    const [people] = await db()
      .insert(categoriesTable)
      .values({ universeId: universe.id, label: 'People', icon: '', sortOrder: 0 })
      .returning();
    const [places] = await db()
      .insert(categoriesTable)
      .values({ universeId: universe.id, label: 'Places', icon: '', sortOrder: 1 })
      .returning();
    const [items] = await db()
      .insert(categoriesTable)
      .values({ universeId: universe.id, label: 'Items', icon: '', sortOrder: 2 })
      .returning();

    // ---------- seed 5 entries: 2 People, 2 Places, 1 uncategorized ----------
    // Entry A includes a colon in title (Pitfall 6 frontmatter coverage was for fields,
    // but covering H1 colon too costs nothing). Entry B has tag with colons — that's
    // the actual frontmatter colon-coverage assertion.
    const [entryA] = await db()
      .insert(entriesTable)
      .values({
        universeId: universe.id,
        title: 'Test: A Subject',
        entryType: 'entity',
        summary: 'Multi-line\nsummary case',
        body: 'Body of A.',
        tags: ['tag:with:colons', 'plain'],
        meta: { rank: 1 },
        icon: '',
        categoryId: people.id,
      })
      .returning();
    const [entryB] = await db()
      .insert(entriesTable)
      .values({
        universeId: universe.id,
        title: 'Beatrice',
        entryType: 'entity',
        summary: 'A second person',
        body: 'Body of B.',
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
        summary: 'Big city',
        body: 'Body of C.',
        tags: [],
        meta: {},
        icon: '',
        categoryId: places.id,
      })
      .returning();
    const [entryD] = await db()
      .insert(entriesTable)
      .values({
        universeId: universe.id,
        title: 'Harbor',
        entryType: 'location',
        summary: '',
        body: 'Body of D.',
        tags: [],
        meta: {},
        icon: '',
        categoryId: places.id,
      })
      .returning();
    const [entryE] = await db()
      .insert(entriesTable)
      .values({
        universeId: universe.id,
        title: 'Loose Note',
        entryType: 'concept',
        summary: '',
        body: 'Body of E.',
        tags: [],
        meta: {},
        icon: '',
        categoryId: null, // uncategorized
      })
      .returning();

    // ---------- seed 4 links ----------
    // A → B "knows", A → C "located in" (bidirectional), D → E "owns",
    // A → D "knows" (same relation as A→B; both should land under one ### knows heading).
    await db()
      .insert(linksTable)
      .values({
        universeId: universe.id,
        sourceEntryId: entryA.id,
        targetEntryId: entryB.id,
        label: 'knows',
        direction: 'directed' as const,
      });
    await db()
      .insert(linksTable)
      .values({
        universeId: universe.id,
        sourceEntryId: entryA.id,
        targetEntryId: entryC.id,
        label: 'located in',
        direction: 'undirected' as const,
      });
    await db()
      .insert(linksTable)
      .values({
        universeId: universe.id,
        sourceEntryId: entryD.id,
        targetEntryId: entryE.id,
        label: 'owns',
        direction: 'directed' as const,
      });
    await db()
      .insert(linksTable)
      .values({
        universeId: universe.id,
        sourceEntryId: entryA.id,
        targetEntryId: entryD.id,
        label: 'knows',
        direction: 'directed' as const,
      });

    // ---------- seed 2 issues: 1 open on A (CRITICAL), 1 resolved on B ----------
    const [openIssue] = await db()
      .insert(issuesTable)
      .values({
        universeId: universe.id,
        title: 'A blocking concern',
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
        title: 'Already resolved',
        description: 'Old issue',
        severity: 'minor',
        resolved: true,
      })
      .returning();
    await db()
      .insert(issueEntriesTable)
      .values({ issueId: resolvedIssue.id, entryId: entryB.id });

    // ---------- export markdown ----------
    const res = await app.request(
      `http://localhost/universes/${universe.id}/export?format=markdown`,
      { headers: hdrs },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(/filename="markdown-test-world-\d{4}-\d{2}-\d{2}\.zip"/);

    const buf = Buffer.from(await res.arrayBuffer());
    const files = await unzipToMap(buf);

    // ---------- folder structure ----------
    const root = 'markdown-test-world';
    expect(files.has(`${root}/_index.md`)).toBe(true);
    // Entry slugs come from payload.entrySlugMap (custom asciiSlug)
    expect(files.has(`${root}/People/test-a-subject.md`)).toBe(true);
    expect(files.has(`${root}/People/beatrice.md`)).toBe(true);
    expect(files.has(`${root}/Places/capital.md`)).toBe(true);
    expect(files.has(`${root}/Places/harbor.md`)).toBe(true);
    expect(files.has(`${root}/Uncategorized/loose-note.md`)).toBe(true);

    // ---------- _index.md contents ----------
    const indexMd = files.get(`${root}/_index.md`)!;
    expect(indexMd).toContain('# Markdown Test World');
    expect(indexMd).toContain('5 entries · 3 categories · 4 links');

    // sortOrder: People → Places → Items (Items will be omitted since empty)
    // → Uncategorized last.
    const peoplePos = indexMd.indexOf('## People');
    const placesPos = indexMd.indexOf('## Places');
    const itemsPos = indexMd.indexOf('## Items');
    const uncatPos = indexMd.indexOf('## Uncategorized');
    expect(peoplePos).toBeGreaterThan(-1);
    expect(placesPos).toBeGreaterThan(peoplePos);
    expect(itemsPos).toBe(-1); // empty category section is omitted
    expect(uncatPos).toBeGreaterThan(placesPos);

    // ---------- frontmatter parses for every .md (even with colons in tags) ----------
    for (const [path, content] of files) {
      if (path.endsWith('_index.md')) continue;
      if (!path.endsWith('.md')) continue;
      const fm = parseFrontmatter(content);
      expect(fm).toHaveProperty('type');
      expect(fm).toHaveProperty('tags');
      expect(fm).toHaveProperty('category');
      expect(fm).toHaveProperty('meta');
    }

    // Entry A's tags include "tag:with:colons" — survives YAML round-trip cleanly.
    const aMd = files.get(`${root}/People/test-a-subject.md`)!;
    const aFm = parseFrontmatter(aMd);
    expect(aFm.tags).toEqual(['tag:with:colons', 'plain']);
    expect(aFm.category).toBe('People');
    expect(aFm.type).toBe('entity');

    // ---------- entry A: outbound links (knows: B, D) and (located in: C) ----------
    expect(aMd).toContain('## Links');
    expect(aMd).toContain('### knows');
    expect(aMd).toContain('### located in');
    expect(aMd).toMatch(/- \[Beatrice\]\(\.\/beatrice\.md\)/);
    expect(aMd).toMatch(/- \[Harbor\]\(\.\.\/Places\/harbor\.md\)/);
    expect(aMd).toMatch(/- \[Capital\]\(\.\.\/Places\/capital\.md\)/);

    // ---------- entry C: bidirectional appears as outbound on C's side too ----------
    const cMd = files.get(`${root}/Places/capital.md`)!;
    expect(cMd).toContain('## Links');
    expect(cMd).toContain('### located in');
    expect(cMd).toMatch(/- \[Test: A Subject\]\(\.\.\/People\/test-a-subject\.md\)/);

    // ---------- entry B: backlinks contain A (B has no outbound; A→B is non-bidirectional) ----------
    const bMd = files.get(`${root}/People/beatrice.md`)!;
    expect(bMd).toContain('## Backlinks');
    expect(bMd).toMatch(/- \[Test: A Subject\]\(\.\/test-a-subject\.md\)/);
    // B's only issue was resolved → NO Open Issues section
    expect(bMd).not.toContain('## Open Issues');

    // ---------- entry A: open issue surfaces with severity badge ----------
    expect(aMd).toContain('## Open Issues');
    expect(aMd).toContain('**[CRITICAL]** A blocking concern');
    expect(aMd).toContain('  Needs follow-up');
    // The resolved issue's title must NOT appear anywhere in the ZIP.
    for (const [, content] of files) {
      expect(content).not.toContain('Already resolved');
    }

    // ---------- relative link from A to C resolves to a file that exists in the ZIP ----------
    // A is at {root}/People/test-a-subject.md; link "../Places/capital.md" resolves to
    // {root}/Places/capital.md (which we already asserted exists).
    expect(files.has(`${root}/Places/capital.md`)).toBe(true);

    // ---------- A's body and summary present ----------
    expect(aMd).toContain('# Test: A Subject');
    expect(aMd).toContain('> Multi-line');
    expect(aMd).toContain('> summary case');
    expect(aMd).toContain('Body of A.');

    // ---------- entry E (uncategorized) frontmatter category is "Uncategorized" ----------
    const eMd = files.get(`${root}/Uncategorized/loose-note.md`)!;
    const eFm = parseFrontmatter(eMd);
    expect(eFm.category).toBe('Uncategorized');
    // E has an inbound link from D ("owns"); D's only outbound is to E,
    // and the link is non-bidirectional, so E's backlinks lists D.
    expect(eMd).toContain('## Backlinks');
    expect(eMd).toMatch(/- \[Harbor\]\(\.\.\/Places\/harbor\.md\)/);

    // Re-export idempotency — second export shouldn't crash or mutate state.
    const res2 = await app.request(
      `http://localhost/universes/${universe.id}/export?format=markdown`,
      { headers: hdrs },
    );
    expect(res2.status).toBe(200);
    const buf2 = Buffer.from(await res2.arrayBuffer());
    const files2 = await unzipToMap(buf2);
    expect(files2.size).toBe(files.size);

    // Reference an unused variable to silence linters since we only seed `items`
    // to verify its empty section is omitted (no entries reference its id).
    void items;

    // Sanity: entry rows we inserted still match the count (no DB drift from export).
    const rowCount = await db()
      .select()
      .from(entriesTable)
      .where(eq(entriesTable.universeId, universe.id));
    expect(rowCount).toHaveLength(5);

    // entryC body for completeness
    void entryC;
  });
});

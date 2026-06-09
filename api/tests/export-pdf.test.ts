import fs from 'node:fs';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
 * Plan 04-03 EXP-03 + EXP-05 (PDF) integration coverage.
 *
 * Skip guard: PDF tests need a Chromium binary on disk. CI without
 * Chromium installed should NOT fail — the suite skips entirely until
 * the operator sets `CHROMIUM_PATH=$(which chromium)` and re-runs.
 *
 * `d` is `describe` when Chromium is present, `describe.skip` otherwise.
 * vitest's `skipIf` API differs across versions; the conditional ternary
 * is the portable form (matches what plan 04-04 will use for DOCX-Word
 * smoke tests).
 */
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const HAS_CHROMIUM = Boolean(CHROMIUM_PATH && fs.existsSync(CHROMIUM_PATH));
const d = HAS_CHROMIUM ? describe : describe.skip;

d('EXP-03: PDF exporter — full integration', () => {
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

  /** Seed a fixture universe with 2 categories, 4 entries, 2 links, 1 open issue. */
  async function seedFixture() {
    const user = await createTestUser(handle, {
      email: 'pdf-export@test.com',
      password: 'longenoughpw12',
    });
    const token = await issueAccessToken(user.id);
    const hdrs = authHeader(token);

    const createUniverseRes = await app.request('http://localhost/universes', {
      method: 'POST',
      headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Pdf Test World' }),
    });
    const universe = (await createUniverseRes.json()) as { id: string };

    const [people] = await db()
      .insert(categoriesTable)
      .values({ universeId: universe.id, label: 'People', icon: '', sortOrder: 0 })
      .returning();
    const [places] = await db()
      .insert(categoriesTable)
      .values({ universeId: universe.id, label: 'Places', icon: '', sortOrder: 1 })
      .returning();

    const [entryA] = await db()
      .insert(entriesTable)
      .values({
        universeId: universe.id,
        categoryId: people.id,
        title: 'Alice the Protagonist',
        entryType: 'entity',
        summary: 'A short summary of Alice',
        body: 'Alice has a long history.\n\nShe **fights**.',
        tags: ['hero'],
      })
      .returning();
    const [entryB] = await db()
      .insert(entriesTable)
      .values({
        universeId: universe.id,
        categoryId: people.id,
        title: 'Bob the Sidekick',
        entryType: 'entity',
        summary: '',
        body: 'Bob accompanies Alice everywhere.',
        tags: [],
      })
      .returning();
    const [entryC] = await db()
      .insert(entriesTable)
      .values({
        universeId: universe.id,
        categoryId: places.id,
        title: 'Capital City',
        entryType: 'entity',
        summary: 'The seat of power',
        body: 'A bustling metropolis.',
        tags: ['urban'],
      })
      .returning();
    const [entryD] = await db()
      .insert(entriesTable)
      .values({
        universeId: universe.id,
        categoryId: null,
        title: 'Floating Idea',
        entryType: 'concept',
        summary: '',
        body: 'A loose concept not yet placed.',
        tags: [],
      })
      .returning();

    await db().insert(linksTable).values({
      universeId: universe.id,
      sourceEntryId: entryA.id,
      targetEntryId: entryB.id,
      label: 'knows',
      direction: 'directed' as const,
    });
    await db().insert(linksTable).values({
      universeId: universe.id,
      sourceEntryId: entryA.id,
      targetEntryId: entryC.id,
      label: 'lives in',
      direction: 'undirected' as const,
    });

    const [openIssue] = await db()
      .insert(issuesTable)
      .values({
        universeId: universe.id,
        title: 'Need to clarify Alice motive',
        description: 'Open question for chapter 2',
        severity: 'critical',
        resolved: false,
      })
      .returning();
    await db().insert(issueEntriesTable).values({
      issueId: openIssue.id,
      entryId: entryA.id,
    });

    return { hdrs, universe, entryA, entryB, entryC, entryD };
  }

  it('returns 200 application/pdf with dated filename and a non-empty PDF body containing universe + every entry title', async () => {
    const { hdrs, universe } = await seedFixture();

    const res = await app.request(
      `http://localhost/universes/${universe.id}/export?format=pdf`,
      { headers: hdrs },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(/attachment;\s*filename="pdf-test-world-\d{4}-\d{2}-\d{2}\.pdf"/);

    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(5000); // a real PDF is at least a few KB
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');

    // Use pdf-parse to extract text — the legacy import path is the only
    // one that works without invoking pdf-parse's bundled test scripts.
    const pdfParseMod = (await import('pdf-parse')) as unknown as {
      default: (b: Buffer) => Promise<{ text: string; numpages: number }>;
    };
    const data = await pdfParseMod.default(buf);
    expect(data.numpages).toBeGreaterThanOrEqual(2);
    expect(data.text).toContain('Pdf Test World');
    expect(data.text).toContain('People');
    expect(data.text).toContain('Places');
    expect(data.text).toContain('Uncategorized');
    expect(data.text).toContain('Alice the Protagonist');
    expect(data.text).toContain('Bob the Sidekick');
    expect(data.text).toContain('Capital City');
    expect(data.text).toContain('Floating Idea');
    // Open issue surfaces with severity pill text.
    expect(data.text).toContain('CRITICAL');
    expect(data.text).toContain('Need to clarify Alice motive');
  }, 60_000);

  it('footer universe-name appears (page-2-onward) — heuristic: pdf-parse text contains the name MORE than once (title page + at least one footer instance)', async () => {
    const { hdrs, universe } = await seedFixture();
    const res = await app.request(
      `http://localhost/universes/${universe.id}/export?format=pdf`,
      { headers: hdrs },
    );
    const buf = Buffer.from(await res.arrayBuffer());
    const pdfParseMod = (await import('pdf-parse')) as unknown as {
      default: (b: Buffer) => Promise<{ text: string; numpages: number }>;
    };
    const data = await pdfParseMod.default(buf);

    // Title page contributes one occurrence; the @page :first margin trick
    // suppresses the page-1 footer, so each subsequent page contributes one
    // more occurrence via its footer. Total occurrences MUST be > 1.
    const occurrences = (data.text.match(/Pdf Test World/g) ?? []).length;
    expect(occurrences).toBeGreaterThan(1);
  }, 60_000);
});

/**
 * EXP-05 leak test: assert browser.close() is called exactly once after
 * the response body is fully drained. This test does NOT need Chromium —
 * we mock puppeteer-core for unit-level isolation. Lives here rather than
 * in export-pdf-render.test.ts because it exercises the full HTTP path
 * (route → renderUniversePdf → c.body(stream)).
 */
import { vi, beforeEach as beforeEachLeak, afterEach as afterEachLeak } from 'vitest';

beforeEachLeak(() => {
  vi.resetModules();
});
afterEachLeak(() => {
  vi.doUnmock('puppeteer-core');
  vi.resetModules();
});

describe('EXP-05: PDF browser-leak (mock-based; no Chromium required)', () => {
  it('browser.close() runs exactly once after full response drain', async () => {
    let closeCount = 0;

    const fakePage = {
      setContent: vi.fn(async () => {}),
      evaluateHandle: vi.fn(async () => ({})),
      createPDFStream: vi.fn(
        async () =>
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x0a]));
              c.enqueue(new Uint8Array([0x25, 0x25, 0x45, 0x4f, 0x46]));
              c.close();
            },
          }),
      ),
    };
    const fakeBrowser = {
      newPage: vi.fn(async () => fakePage),
      close: vi.fn(async () => {
        closeCount++;
      }),
    };
    vi.doMock('puppeteer-core', () => ({
      default: { launch: vi.fn(async () => fakeBrowser) },
    }));

    // Re-import after the mock is registered so the route's transitive
    // import of puppeteer-core picks up the fake. Re-import setTestDb from
    // the fresh module graph too — vi.resetModules() makes the freshly
    // imported route bind to a NEW db/client module, not the one the
    // top-of-file `setTestDb` import points at.
    const { createApp: createAppLocal } = await import('../src/index.js');
    const { setTestDb: setTestDbLocal } = await import('../src/db/client.js');
    const handle = await createTestDb();
    setTestDbLocal(handle.db as never, handle.pool);
    const app = createAppLocal();

    try {
      const user = await createTestUser(handle, {
        email: 'pdf-leak@test.com',
        password: 'longenoughpw12',
      });
      const token = await issueAccessToken(user.id);
      const hdrs = authHeader(token);
      const ures = await app.request('http://localhost/universes', {
        method: 'POST',
        headers: { ...hdrs, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Leak Test' }),
      });
      const u = (await ures.json()) as { id: string };

      const res = await app.request(
        `http://localhost/universes/${u.id}/export?format=pdf`,
        { headers: hdrs },
      );
      expect(res.status).toBe(200);
      // Drain the body so the wrapper's start() finishes its read loop.
      await res.arrayBuffer();

      // Allow the finally block in start() to run.
      await new Promise((r) => setTimeout(r, 10));
      expect(closeCount).toBe(1);
    } finally {
      await handle.cleanup();
    }
  });
});

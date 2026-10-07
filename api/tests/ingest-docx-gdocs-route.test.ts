/**
 * The Google-Docs-shaped fixtures (fixtures/ingest/docx-gdocs/) through the
 * real import path: multipart preview, then the atomic commit, then the rows.
 * Conversion details live in ingest-docx-gdocs-fixtures.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';
import { universes, entries } from '../src/db/schema.js';
import { DB_GATED_TESTS } from '../ci/integration-tiers.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ingest', 'docx-gdocs');
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const FIXTURES = ['pantheon-tabs.docx', 'ranked-orders.docx', 'chronicle.docx'];

interface PreviewEntry {
  filename: string; path: string; title: string; type: string; tags: string[];
  body: string; meta: Record<string, unknown>; linksOut: unknown[];
}
interface PreviewBody {
  summary: { markdown_files_parsed: number; docx_files_converted: number };
  entries: PreviewEntry[];
  warnings: Array<{ file: string; message: string }>;
  docx: { files: Array<{ path: string; headings: { unstyledCandidates: number; promoted: boolean } }> };
}

describe('Google Docs fixtures through POST /ingest and /ingest/commit', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let token: string;
  let universeId: string;

  beforeAll(async () => {
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setTestDb(handle.db as any, handle.pool);
    app = (await import('../src/index.js')).createApp();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
    const user = await createTestUser(handle, { email: 'gdocs@test.dev', password: 'password123' });
    const { issueAccessToken } = await import('../src/services/auth.js');
    token = await issueAccessToken(user.id);
    const [u] = await handle.db.insert(universes).values({ userId: user.id, name: 'Lore' }).returning();
    universeId = u.id;
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function preview(names: string[], promote: number[] = []): Promise<PreviewBody> {
    const fd = new FormData();
    for (const name of names) {
      fd.append('files', new File([readFileSync(join(DIR, name))], name, { type: DOCX_MIME }), name);
    }
    for (const i of promote) fd.append('docx_promote_index', String(i));
    const res = await app.request(`/api/universes/${universeId}/ingest`, {
      method: 'POST', headers: auth(), body: fd,
    });
    expect(res.status).toBe(200);
    return (await res.json()) as PreviewBody;
  }

  async function commitAll(body: PreviewBody) {
    const res = await app.request(`/api/universes/${universeId}/ingest/commit`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({
        entries: body.entries.map((e) => ({
          filename: e.filename, path: e.path, title: e.title, entryType: e.type,
          tags: e.tags, category: null, body: e.body, meta: e.meta,
          linksOut: e.linksOut, decision: { disposition: 'accept' },
        })),
      }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { entryIds: string[] };
  }

  const storedTitles = async () =>
    (await handle.db.select({ title: entries.title }).from(entries)
      .where(eq(entries.universeId, universeId))).map((r) => r.title).sort();

  it('is registered in DB_GATED_TESTS', () => {
    expect(DB_GATED_TESTS).toContain('tests/ingest-docx-gdocs-route.test.ts');
  });

  it('imports the three notes as three entries titled from their filenames', async () => {
    const body = await preview(FIXTURES);
    expect(body.summary.docx_files_converted).toBe(3);
    expect(body.entries.map((e) => e.title).sort()).toEqual(
      ['Chronicle', 'Pantheon tabs', 'Ranked orders'],
    );
    const chronicle = body.docx.files.find((f) => f.path === 'chronicle.docx');
    expect(chronicle?.headings).toMatchObject({ unstyledCandidates: 3, promoted: false });
    expect(body.warnings.some((w) => w.file === 'chronicle.docx'
      && /comment was not imported/.test(w.message))).toBe(true);

    const result = await commitAll(body);
    expect(result.entryIds).toHaveLength(3);
    expect(await storedTitles()).toEqual(['Chronicle', 'Pantheon tabs', 'Ranked orders']);
  });

  it('a promoted chronicle alone splits into one stored entry per era', async () => {
    const body = await preview(['chronicle.docx'], [0]);
    expect(body.entries.map((e) => e.title)).toEqual(
      ['The Quiet Era', 'The Era of Wardens', 'The Long Argument'],
    );
    expect(body.entries[1].body).toContain('1,200 BC/0: The first raft crosses the ford');

    await commitAll(body);
    expect(await storedTitles()).toEqual(['The Era of Wardens', 'The Long Argument', 'The Quiet Era']);
  });
});

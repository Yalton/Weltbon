/**
 * POST /api/universes/:uid/ingest/repair-links — issue #60 backfill endpoint.
 *
 * The planner is unit-tested in repair-wikilinks-plan.test.ts. What can only be
 * tested here is that the dry run reports exactly what apply writes, that apply
 * is atomic, and that a second apply is a no-op — the property that makes the
 * endpoint safe to run on a universe whose state nobody is sure about.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';
import { universes, entries, links } from '../src/db/schema.js';

describe('POST /api/universes/:uid/ingest/repair-links (#60)', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  beforeAll(async () => {
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  async function createUserAndJwt(email = 'repair@test.com') {
    const { issueAccessToken } = await import('../src/services/auth.js');
    const user = await createTestUser(handle, { email, password: 'longenoughpw12' });
    const jwt = await issueAccessToken(user.id);
    return { userId: user.id, jwt };
  }

  /** An imported-before-#60 universe: filename refs, no aliases, no link rows. */
  async function seedBrokenImport(userId: string) {
    const [u] = await handle.db
      .insert(universes)
      .values({ userId, name: 'AyinsEdge', description: '', entryTypes: ['concept'] })
      .returning({ id: universes.id });

    const inserted = await handle.db
      .insert(entries)
      .values([
        {
          universeId: u.id,
          title: 'Index',
          entryType: 'concept',
          body: 'See [[ayin_pockets|Ayin pocket]] and [[the_deep_below]].',
        },
        { universeId: u.id, title: 'Ayin Pockets', entryType: 'concept', body: '' },
        { universeId: u.id, title: 'The Deep Below', entryType: 'concept', body: '' },
      ])
      .returning({ id: entries.id, title: entries.title });

    return { universeId: u.id, byTitle: new Map(inserted.map((e) => [e.title, e.id])) };
  }

  async function repair(uid: string, jwt: string, body: object) {
    const req = new Request(`http://localhost/api/universes/${uid}/ingest/repair-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify(body),
    });
    const res = await app.fetch(req);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json()) as any };
  }

  it('dry run reports the plan and writes nothing', async () => {
    const { userId, jwt } = await createUserAndJwt('repair-dry@test.com');
    const { universeId } = await seedBrokenImport(userId);

    const res = await repair(universeId, jwt, {});
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(res.body.entriesScanned).toBe(3);
    expect(res.body.aliasesAdded).toBe(2);
    expect(res.body.linksCreated).toBe(2);
    expect(res.body.unresolved).toEqual([]);

    const rows = await handle.db
      .select({ aliases: entries.aliases })
      .from(entries)
      .where(eq(entries.universeId, universeId));
    expect(rows.every((r) => r.aliases.length === 0)).toBe(true);
    const linkRows = await handle.db
      .select({ id: links.id })
      .from(links)
      .where(eq(links.universeId, universeId));
    expect(linkRows).toHaveLength(0);
  });

  it('apply writes the aliases and links the dry run promised', async () => {
    const { userId, jwt } = await createUserAndJwt('repair-apply@test.com');
    const { universeId, byTitle } = await seedBrokenImport(userId);

    const dry = await repair(universeId, jwt, {});
    const applied = await repair(universeId, jwt, { apply: true });

    expect(applied.status).toBe(200);
    expect(applied.body.applied).toBe(true);
    // Same counts as the dry run — the promise the endpoint makes.
    expect(applied.body.aliasesAdded).toBe(dry.body.aliasesAdded);
    expect(applied.body.linksCreated).toBe(dry.body.linksCreated);

    const [pockets] = await handle.db
      .select({ aliases: entries.aliases })
      .from(entries)
      .where(eq(entries.id, byTitle.get('Ayin Pockets')!));
    expect(pockets.aliases).toEqual(['ayin_pockets']);

    const linkRows = await handle.db
      .select({ sourceEntryId: links.sourceEntryId, targetEntryId: links.targetEntryId })
      .from(links)
      .where(eq(links.universeId, universeId));
    expect(linkRows).toHaveLength(2);
    expect(linkRows.every((l) => l.sourceEntryId === byTitle.get('Index'))).toBe(true);
  });

  it('a second apply is a no-op', async () => {
    const { userId, jwt } = await createUserAndJwt('repair-twice@test.com');
    const { universeId } = await seedBrokenImport(userId);

    await repair(universeId, jwt, { apply: true });
    const second = await repair(universeId, jwt, { apply: true });

    expect(second.body.aliasesAdded).toBe(0);
    expect(second.body.linksCreated).toBe(0);

    const linkRows = await handle.db
      .select({ id: links.id })
      .from(links)
      .where(eq(links.universeId, universeId));
    expect(linkRows).toHaveLength(2);
  });

  it('reports an ambiguous ref instead of guessing', async () => {
    const { userId, jwt } = await createUserAndJwt('repair-ambig@test.com');
    const [u] = await handle.db
      .insert(universes)
      .values({ userId, name: 'Ambiguous', description: '', entryTypes: ['concept'] })
      .returning({ id: universes.id });
    await handle.db.insert(entries).values([
      { universeId: u.id, title: 'Index', entryType: 'concept', body: 'See [[ayin_pockets]].' },
      { universeId: u.id, title: 'Ayin Pockets', entryType: 'concept', body: '' },
      { universeId: u.id, title: 'AYIN POCKETS!', entryType: 'concept', body: '' },
    ]);

    const res = await repair(u.id, jwt, { apply: true });
    expect(res.body.aliasesAdded).toBe(0);
    expect(res.body.linksCreated).toBe(0);
    expect(res.body.unresolved).toEqual([
      expect.objectContaining({ target: 'ayin_pockets', reason: 'ambiguous' }),
    ]);
  });

  it('rejects a universe owned by another user', async () => {
    const { userId } = await createUserAndJwt('repair-owner@test.com');
    const { universeId } = await seedBrokenImport(userId);
    const other = await createUserAndJwt('repair-intruder@test.com');

    const res = await repair(universeId, other.jwt, { apply: true });
    expect(res.status).toBe(403);
  });

  it('requires a bearer token', async () => {
    const { userId } = await createUserAndJwt('repair-anon@test.com');
    const { universeId } = await seedBrokenImport(userId);

    const req = new Request(`http://localhost/api/universes/${universeId}/ingest/repair-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(401);
  });
});

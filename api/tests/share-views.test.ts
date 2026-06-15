/**
 * api/tests/share-views.test.ts — Phase 29 SHARE-04 privacy invariants
 * (per-route assertions for the /api/share/* visitor read surface).
 *
 * Asserts the four privacy invariants that the share-views.ts service
 * functions implement, plus the revoke/expire 404 contract:
 *
 *  A. GET /api/share/entries returns ONLY entries where is_public = true
 *     (T-29-23 — regression dropping the is_public filter).
 *  B. GET /api/share/entries/{id} for a private entry returns 404
 *     (T-29-16 + D-13 — private indistinguishable from missing).
 *  C. GET /api/share/entries/{public-id} backlinks omit backlinks whose
 *     source entry is private — silent drop, no count, no placeholder
 *     (T-29-24 + D-12).
 *  D. GET /api/share/graph-data omits private nodes AND drops any edge
 *     with at least one private endpoint (T-29-25 + D-14 + T-29-19 —
 *     cap-after-filter; the cap operates on the public-filtered set).
 *  E. Revoked share-token returns 404 (NOT 401, NOT 200) on the share
 *     read surface (T-29-26 + D-06 — immediate revocation).
 *  F. Expired share-token returns 404 (D-05 — bonus coverage).
 *
 * Lane: DB-gated (integration). Uses createTestDb + cleanDb so each test
 * starts from a known empty state; per-test seeding builds exactly the
 * (public, private) entry / link pairs the test needs.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createTestDb,
  cleanDb,
  createTestUser,
  type TestDbHandle,
} from './helpers.js';
import { entries, links, shareTokens, universes } from '../src/db/schema.js';

let handle: TestDbHandle;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: any;

// Per-test state populated in beforeEach.
let userId: string;
let universeId: string;
let activeTokenPlaintext: string;
let activeTokenHash: string;

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
  // Each test starts with an empty DB so seed shapes don't leak across tests.
  await cleanDb(handle);

  const user = await createTestUser(handle, {
    email: `share-views-${Date.now()}-${Math.random()}@test.local`,
    password: 'longenoughpw12',
    displayName: 'Share Views Tester',
  });
  userId = user.id;

  const [univ] = await handle.db
    .insert(universes)
    .values({ userId: user.id, name: 'Share Views Test Universe' })
    .returning();
  universeId = univ!.id;

  const { generateShareToken } = await import('../src/services/share-token.js');
  const seed = generateShareToken();
  activeTokenPlaintext = seed.plaintext;
  activeTokenHash = seed.hash;
  await handle.db.insert(shareTokens).values({
    userId: user.id,
    universeId: univ!.id,
    label: 'share-views-test',
    hash: seed.hash,
    bodySuffix: seed.bodySuffix,
  });
});

async function appRequest(
  method: string,
  path: string,
  options: { headers?: Record<string, string> } = {},
) {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { ...options.headers },
  });
  const res = await app.fetch(req);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = null;
  if (res.status !== 204) {
    try {
      json = await res.json();
    } catch {
      /* no body */
    }
  }
  return { status: res.status, body: json };
}

async function seedEntry(opts: { isPublic: boolean; title?: string; entryType?: string }) {
  const [row] = await handle.db
    .insert(entries)
    .values({
      universeId,
      title: opts.title ?? 'Test Entry',
      entryType: opts.entryType ?? 'note',
      isPublic: opts.isPublic,
    })
    .returning();
  return row!;
}

async function seedLink(opts: { sourceEntryId: string; targetEntryId: string; label?: string }) {
  const [row] = await handle.db
    .insert(links)
    .values({
      universeId,
      sourceEntryId: opts.sourceEntryId,
      targetEntryId: opts.targetEntryId,
      label: opts.label ?? 'links-to',
      direction: 'directed',
    })
    .returning();
  return row!;
}

describe('Phase 29 share-view privacy invariants', () => {
  // ────────────────────────────────────────────────────────────────────
  // Test A — T-29-23: list filter on is_public
  // ────────────────────────────────────────────────────────────────────
  it('GET /api/share/entries returns only is_public=true entries', async () => {
    const pub = await seedEntry({ isPublic: true, title: 'Public Entry' });
    await seedEntry({ isPublic: false, title: 'Private Entry' });

    const res = await appRequest('GET', '/api/share/entries', {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(200);
    // Phase 33: share /entries returns a bare array (matches authenticated contract)
    expect(Array.isArray(res.body)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = res.body as any[];
    expect(
      list.length,
      `T-29-23: GET /api/share/entries returned ${list.length} entries — expected exactly 1 ` +
        `(the public one). A removed is_public filter would surface the private entry too. ` +
        `Returned ids: ${JSON.stringify(list.map((e) => e.id))}`,
    ).toBe(1);
    expect(list[0].id).toBe(pub.id);
    expect(list[0].isPublic).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────
  // Test B — T-29-16 + D-13: private entry direct GET → 404
  // ────────────────────────────────────────────────────────────────────
  it('GET /api/share/entries/{id} returns 404 for a private entry (T-29-16 + D-13)', async () => {
    const priv = await seedEntry({ isPublic: false, title: 'Private Direct GET' });

    const res = await appRequest('GET', `/api/share/entries/${priv.id}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(
      res.status,
      `T-29-16/D-13: a private entry id MUST return 404 (NOT 200, NOT 403). ` +
        `A 403 would distinguish "private" from "missing" — direct id enumeration ` +
        `MUST be indistinguishable from a non-existent id.`,
    ).toBe(404);
  });

  // ────────────────────────────────────────────────────────────────────
  // Test C — T-29-24 + D-12: backlinks silent-drop on private source
  // ────────────────────────────────────────────────────────────────────
  it('GET /api/share/entries/{id} backlinks omit private-source backlinks (D-12, T-29-24)', async () => {
    const target = await seedEntry({ isPublic: true, title: 'Public Target' });
    const privateSource = await seedEntry({ isPublic: false, title: 'Private Source' });
    await seedLink({ sourceEntryId: privateSource.id, targetEntryId: target.id, label: 'mentions' });

    const res = await appRequest('GET', `/api/share/entries/${target.id}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('backlinks');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const backlinks = res.body.backlinks as any[];
    expect(
      backlinks.length,
      `T-29-24/D-12 silent drop: backlinks on a public entry whose source is PRIVATE ` +
        `must be filtered server-side at the SQL layer — no placeholder rows, no count. ` +
        `Observed backlinks: ${JSON.stringify(backlinks)}`,
    ).toBe(0);
  });

  // ────────────────────────────────────────────────────────────────────
  // Test D — T-29-25 + D-14: graph filter on BOTH nodes and edges
  // ────────────────────────────────────────────────────────────────────
  it('GET /api/share/graph-data omits private nodes AND drops edges touching a private endpoint (D-14, T-29-25, T-29-19)', async () => {
    const A = await seedEntry({ isPublic: true, title: 'A public' });
    const B = await seedEntry({ isPublic: false, title: 'B private' });
    const C = await seedEntry({ isPublic: true, title: 'C public' });
    // Edges: A→C (public→public — kept), A→B (public→private — dropped),
    // C→B (public→private — dropped). After filter: 2 nodes, 1 edge.
    await seedLink({ sourceEntryId: A.id, targetEntryId: C.id, label: 'A-to-C' });
    await seedLink({ sourceEntryId: A.id, targetEntryId: B.id, label: 'A-to-B' });
    await seedLink({ sourceEntryId: C.id, targetEntryId: B.id, label: 'C-to-B' });

    const res = await appRequest('GET', '/api/share/graph-data', {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('nodes');
    expect(res.body).toHaveProperty('edges');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodes = res.body.nodes as Array<{ id: string }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const edges = res.body.edges as Array<{ source: string; target: string }>;
    const nodeIds = new Set(nodes.map((n) => n.id));

    expect(
      nodes.length,
      `T-29-25/D-14: graph nodes count MUST be 2 (A, C) — the private node B must be ` +
        `dropped at the SQL layer. Observed nodeIds: ${JSON.stringify([...nodeIds])}`,
    ).toBe(2);
    expect(nodeIds.has(A.id)).toBe(true);
    expect(nodeIds.has(C.id)).toBe(true);
    expect(
      nodeIds.has(B.id),
      `T-29-25: private node B leaked into graph nodes — server-side filter broken`,
    ).toBe(false);

    expect(
      edges.length,
      `T-29-19/D-14: edges MUST be exactly 1 (A→C). Edges A→B and C→B both touch the ` +
        `private node B and must be dropped at the SQL layer BEFORE any 300-node cap ` +
        `applies. Observed edges: ${JSON.stringify(edges)}`,
    ).toBe(1);
    expect(nodeIds.has(edges[0]!.source)).toBe(true);
    expect(nodeIds.has(edges[0]!.target)).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────
  // Test E — T-29-26 + D-06: revoked token returns 404 (NOT 401, NOT 200)
  // ────────────────────────────────────────────────────────────────────
  it('revoked share-token returns 404 on /api/share/entries (D-06, T-29-26)', async () => {
    await seedEntry({ isPublic: true, title: 'Public Pre-Revoke' });

    // Sanity: baseline 200 before revoke (otherwise the post-revoke 404 could
    // be passing for the wrong reason — e.g. the seed-token never worked).
    const baseline = await appRequest('GET', '/api/share/entries', {
      headers: { 'share-token': activeTokenPlaintext },
    });
    expect(
      baseline.status,
      `Pre-revoke baseline broken: the active token should return 200 before revoke; ` +
        `got ${baseline.status}. The post-revoke assertion is meaningless without this check.`,
    ).toBe(200);

    // Revoke by setting revoked_at to NOW().
    await handle.db
      .update(shareTokens)
      .set({ revokedAt: new Date() })
      .where(eq(shareTokens.hash, activeTokenHash));

    const res = await appRequest('GET', '/api/share/entries', {
      headers: { 'share-token': activeTokenPlaintext },
    });
    expect(
      res.status,
      `T-29-26/D-06: a revoked share-token MUST return 404 (NOT 200, NOT 401) on /api/share/*. ` +
        `D-05/D-06 require ALL failure modes (missing / wrong prefix / unknown / revoked / expired) ` +
        `to collapse to the same 404 so visitors cannot distinguish them.`,
    ).toBe(404);
  });

  // ────────────────────────────────────────────────────────────────────
  // Test G — T-33-04 + T-33-05: ?type= filter on public share entries
  // (Phase 33 CONLANG-04 N+1 fix: server-side entryType narrowing)
  // ────────────────────────────────────────────────────────────────────
  it('GET /api/share/entries?type=language returns only public language entries (T-33-04/T-33-05)', async () => {
    const publicLang = await seedEntry({ isPublic: true, title: 'Public Language', entryType: 'language' });
    const publicNote = await seedEntry({ isPublic: true, title: 'Public Note', entryType: 'note' });
    const privateLang = await seedEntry({ isPublic: false, title: 'Private Language', entryType: 'language' });

    const res = await appRequest('GET', '/api/share/entries?type=language', {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(200);
    // Phase 33: share /entries returns a bare array (matches authenticated contract)
    expect(Array.isArray(res.body)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = res.body as any[];
    const ids = list.map((e: { id: string }) => e.id);

    expect(
      list.length,
      `T-33-04: ?type=language must return exactly 1 entry (the public language one). ` +
        `The private language entry (isPublic=false) must be excluded. ` +
        `The public note entry (wrong type) must be excluded. ` +
        `Returned ids: ${JSON.stringify(ids)}`,
    ).toBe(1);
    expect(ids).toContain(publicLang.id);
    expect(ids).not.toContain(publicNote.id);
    expect(ids).not.toContain(privateLang.id);
  });

  it('GET /api/share/entries (no ?type=) returns all public entries regardless of type (T-33-04)', async () => {
    await seedEntry({ isPublic: true, title: 'Public Language', entryType: 'language' });
    await seedEntry({ isPublic: true, title: 'Public Note', entryType: 'note' });
    await seedEntry({ isPublic: false, title: 'Private Language', entryType: 'language' });

    const res = await appRequest('GET', '/api/share/entries', {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(200);
    // Phase 33: share /entries returns a bare array (matches authenticated contract)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = res.body as any[];
    expect(
      list.length,
      `T-33-04: no ?type= must return all 2 public entries (both language and note). ` +
        `Private entries must never appear. Got ${list.length}.`,
    ).toBe(2);
    expect(list.every((e: { isPublic: boolean }) => e.isPublic === true)).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────
  // Test F — D-05 + T-29-26 bonus: expired token returns 404
  // ────────────────────────────────────────────────────────────────────
  it('expired share-token returns 404 (D-05, T-29-26 bonus)', async () => {
    // Insert a SEPARATE share token whose expires_at is 60s in the past.
    const { generateShareToken } = await import('../src/services/share-token.js');
    const seed = generateShareToken();
    await handle.db.insert(shareTokens).values({
      userId,
      universeId,
      label: 'expired-test',
      hash: seed.hash,
      bodySuffix: seed.bodySuffix,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const res = await appRequest('GET', '/api/share/entries', {
      headers: { 'share-token': seed.plaintext },
    });
    expect(
      res.status,
      `D-05/T-29-26: an expired share-token MUST return 404 — same code as not-found / revoked.`,
    ).toBe(404);
  });
});

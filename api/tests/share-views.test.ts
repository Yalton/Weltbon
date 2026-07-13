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
import { assets, entries, links, maps, mapPins, mapRegions, mapRoutes, shareTokens, universes } from '../src/db/schema.js';

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

async function seedEntry(opts: {
  isPublic: boolean;
  title?: string;
  entryType?: string;
  aliases?: string[];
}) {
  const [row] = await handle.db
    .insert(entries)
    .values({
      universeId,
      title: opts.title ?? 'Test Entry',
      entryType: opts.entryType ?? 'note',
      isPublic: opts.isPublic,
      ...(opts.aliases !== undefined ? { aliases: opts.aliases } : {}),
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
  // Wire-shape tripwire — the runtime check the framework does NOT give us.
  // ────────────────────────────────────────────────────────────────────
  it('share entry detail leaks no undeclared columns (zod does NOT strip at runtime)', async () => {
    // @hono/zod-openapi response schemas are typing + docs ONLY — they do not validate or
    // strip response bodies. A bare .select() spread would ship raw DB columns (this test
    // was added because it shipped `searchVector` to anonymous visitors). The projection is
    // the only real gate, so pin the wire shape here.
    const pub = await seedEntry({ isPublic: true, title: 'Shape Check' });
    const { status, body } = await appRequest('GET', `/api/share/entries/${pub.id}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });
    expect(status).toBe(200);

    const ALLOWED = new Set([
      // Columns projected by getPublicEntryById (must mirror publicEntryDetailResponseSchema).
      'id',
      'universeId',
      'title',
      'entryType',
      'summary',
      'body',
      'tags',
      'aliases',
      'meta',
      'icon',
      'categoryId',
      'isPublic',
      'wip',
      'coverImageId',
      'createdAt',
      'updatedAt',
      // Computed fields assembled by the service (not DB columns).
      'outboundLinks',
      'backlinks',
      'coverImageUrl',
      'assetUrls',
    ]);
    const unexpected = Object.keys(body).filter((k) => !ALLOWED.has(k));
    expect(
      unexpected,
      `Share entry-detail is shipping undeclared fields: ${unexpected.join(', ')}. ` +
        `zod does NOT strip them — fix the projection in getPublicEntryById.`,
    ).toEqual([]);
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

describe('XREF-07: private-reference leak invariants (hover-card / embed share path)', () => {
  // ────────────────────────────────────────────────────────────────────
  // Test XREF-07-1 — T-49-04: hover-card / embed lazy fetch of a private
  // referenced entry returns 404 (no title/summary/body leaks)
  //
  // EntryHoverCard lazy useEntry and EntryEmbed's useEntry both call
  // GET /api/share/entries/{id} in share mode. A private target → null in
  // getPublicEntryById → route returns 404. The hover card shows no excerpt
  // and the embed shows the D-10 "unavailable" affordance instead of content.
  // ────────────────────────────────────────────────────────────────────
  it('hover-card/embed lazy fetch of a private referenced entry returns 404 (T-49-04)', async () => {
    // Seed: a PUBLIC entry whose body contains wikilink and embed references to
    // a PRIVATE entry titled "Secret". This mirrors the threat: a public page
    // references private content via [[ ]] and ![[ ]] markers.
    const publicEntry = await seedEntry({
      isPublic: true,
      title: 'Public Entry Referencing Secret',
    });
    const privateEntry = await seedEntry({ isPublic: false, title: 'Secret' });

    // Verify the public entry can be fetched to confirm the token / universe work
    const pubRes = await appRequest('GET', `/api/share/entries/${publicEntry.id}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });
    expect(pubRes.status).toBe(200);

    // The critical assertion: GET /api/share/entries/{privateId} — the EXACT path
    // EntryHoverCard's lazy useEntry and EntryEmbed's useEntry hit in share mode.
    // A 404 means no title/summary/body reaches the hover card or embed callout.
    const res = await appRequest('GET', `/api/share/entries/${privateEntry.id}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });
    expect(
      res.status,
      `T-49-04: GET /api/share/entries/{privateId} MUST return 404 (NOT 200, NOT 403). ` +
        `A private entry referenced by [[ ]] / ![[ ]] in a public body must be ` +
        `indistinguishable from a missing entry. ` +
        `A 200 would leak the private entry's title/summary/body to any share visitor ` +
        `who inspects the hover-card or embed fetch. ` +
        `Affected components: EntryHoverCard lazy useEntry + EntryEmbed useEntry in share mode. ` +
        `Root cause if failing: getPublicEntryById is_public filter at share-views.ts removed/bypassed.`,
    ).toBe(404);
  });

  // ────────────────────────────────────────────────────────────────────
  // Test XREF-07-2 — T-49-05: share resolver corpus excludes the private
  // referenced entry AND carries no body (LIST-omits-body invariant)
  //
  // The resolver corpus a share visitor reads (GET /api/share/entries) is used
  // by WikilinkText / the share-mode resolver to look up entry titles by id.
  // It must:
  //   (a) omit the private "Secret" entry (is_public filter at L100)
  //   (b) carry NO body property on any row (the LIST-omits-body invariant —
  //       memory: list-endpoint-body-projection-false-green; getPublicEntries
  //       SELECT explicitly omits body, L104-119)
  // A regression in either would allow a share-mode resolver to surface private
  // content or any body from the list path.
  // ────────────────────────────────────────────────────────────────────
  it('GET /api/share/entries excludes private referenced entry AND no row carries body (T-49-05)', async () => {
    // Seed the same public + private pair as T-49-04.
    const publicEntry = await seedEntry({ isPublic: true, title: 'Public Entry' });
    await seedEntry({ isPublic: false, title: 'Secret' });

    const res = await appRequest('GET', '/api/share/entries', {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(200);

    // Phase 33 / T-49-08: share /entries returns a bare array.
    expect(
      Array.isArray(res.body),
      `T-49-08: GET /api/share/entries MUST return a bare array (not a wrapper object). ` +
        `A wrapper-shape regression breaks the transparent web seam (share-seam-bare-array-contract).`,
    ).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = res.body as any[];

    // (a) private entry must be absent from the resolver corpus
    const ids = list.map((e: { id: string }) => e.id);
    expect(
      list.length,
      `T-49-05a: GET /api/share/entries MUST return exactly 1 entry (the public one). ` +
        `The private "Secret" entry (isPublic=false) must be excluded by the is_public filter. ` +
        `Returned ids: ${JSON.stringify(ids)}`,
    ).toBe(1);
    expect(ids).toContain(publicEntry.id);

    // (b) no row in the list must carry a body property
    // getPublicEntries SELECT (share-views.ts L104-119) deliberately omits body.
    // This assertion locks the LIST-omits-body invariant: a share-mode resolver
    // can never surface private body content via the list corpus.
    const rowsWithBody = list.filter(
      (e: Record<string, unknown>) => 'body' in e && e.body !== undefined,
    );
    expect(
      rowsWithBody.length,
      `T-49-05b (LIST-omits-body invariant): GET /api/share/entries rows MUST NOT carry a ` +
        `'body' property. The getPublicEntries SELECT explicitly omits body so the resolver ` +
        `corpus never exposes raw entry markdown to share visitors (memory: ` +
        `list-endpoint-body-projection-false-green). ` +
        `Rows with body: ${JSON.stringify(rowsWithBody.map((e: { id: string }) => e.id))}`,
    ).toBe(0);
  });

  // ────────────────────────────────────────────────────────────────────
  // Test XREF-07-3 — positive control: a PUBLIC referenced target IS
  // reachable via GET /api/share/entries/{visibleId} with body present
  //
  // This guards against a false-green where everything 404s (e.g. the share
  // router is unmounted or requireShareToken always rejects). Embeds of
  // public targets MUST render — getPublicEntryById returns the full row
  // including body for public entries (share-views.ts L141-152 full select).
  // ────────────────────────────────────────────────────────────────────
  it('public referenced entry returns 200 with body present (positive control, T-49-04)', async () => {
    // Seed a public entry with an explicit body so we can assert it is present.
    const [publicVisible] = await handle.db
      .insert(entries)
      .values({
        universeId,
        title: 'Visible Public Entry',
        entryType: 'note',
        isPublic: true,
        body: 'This body content must be visible to share visitors via the detail path.',
      })
      .returning();

    const res = await appRequest('GET', `/api/share/entries/${publicVisible!.id}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(
      res.status,
      `T-49-04 positive control: GET /api/share/entries/{publicId} MUST return 200 for a ` +
        `public entry. If this fails, the test suite is in a false-green state where ALL ` +
        `entry-detail fetches return 404 (e.g. share router unmounted, requireShareToken broken).`,
    ).toBe(200);

    // The detail path (getPublicEntryById) returns the full row including body,
    // so embeds of public targets render correctly. Assert body is present.
    expect(
      res.body,
      `Public entry detail response must be an object with a body property`,
    ).toHaveProperty('body');
    expect(
      typeof res.body.body === 'string' && res.body.body.length > 0,
      `T-49-04 positive control: body MUST be a non-empty string for a public entry ` +
        `fetched via the detail path (getPublicEntryById full select). ` +
        `EntryEmbed uses this path to render the transcluded content.`,
    ).toBe(true);
  });
});

describe('XREF-04/XREF-07: alias projection in share-list (BLOCKER-01 closure)', () => {
  // ─────────────────────────────────────────────────────────────────────────────
  // Test A — alias availability: a public entry's aliases appear in the list
  //
  // The web entryAliases map (EntryDetail.tsx:86-98) is built from the share
  // LIST response. getPublicEntries must project `aliases: entries.aliases` so
  // [[alias]]-form wikilinks and alias-addressed ![[alias]] embeds resolve to
  // the correct entry in /share/:token.
  // ─────────────────────────────────────────────────────────────────────────────
  it('public entry aliases appear in GET /api/share/entries list response (XREF-04, Test A)', async () => {
    const pub = await seedEntry({
      isPublic: true,
      title: 'Bobby Brown',
      aliases: ['Bob', 'Bobby'],
    });

    const res = await appRequest('GET', '/api/share/entries', {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = res.body as any[];

    const row = list.find((e: { id: string }) => e.id === pub.id);
    expect(
      row,
      `XREF-04 alias-availability: the public entry seeded with aliases ['Bob','Bobby'] ` +
        `must appear in the GET /api/share/entries list.`,
    ).toBeDefined();
    expect(
      row?.aliases,
      `XREF-04 alias-availability: the list row's aliases field must be an array — ` +
        `getPublicEntries SELECT omitted aliases before this fix, returning undefined here.`,
    ).toEqual(['Bob', 'Bobby']);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test B — alias privacy: a private entry's aliases NEVER appear in the list
  //
  // The is_public=true filter already gates which rows reach share visitors.
  // This assertion proves the filter extends to alias values: a private entry
  // seeded with a distinctive alias must be absent from the list entirely, and
  // no returned row may carry that alias (information-disclosure threat T-49.1-01).
  // ─────────────────────────────────────────────────────────────────────────────
  it('private entry aliases are absent from GET /api/share/entries list response (XREF-04, Test B)', async () => {
    await seedEntry({ isPublic: true, title: 'Visible Entry' });
    await seedEntry({
      isPublic: false,
      title: 'Hidden Character',
      aliases: ['SecretName'],
    });

    const res = await appRequest('GET', '/api/share/entries', {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = res.body as any[];

    // The private entry must be absent from the list entirely.
    expect(
      list.length,
      `XREF-04 alias-privacy: GET /api/share/entries must return exactly 1 entry ` +
        `(the public one). Private entry with aliases=['SecretName'] must be excluded ` +
        `by the eq(entries.isPublic, true) filter. Got ${list.length} rows.`,
    ).toBe(1);

    // No returned row may carry the private alias.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const leakingRows = list.filter((e: any) =>
      Array.isArray(e.aliases) && e.aliases.includes('SecretName'),
    );
    expect(
      leakingRows.length,
      `XREF-04 alias-privacy (T-49.1-01): no list row may carry the private alias ` +
        `'SecretName'. A leak here means the is_public filter failed to exclude the ` +
        `private entry's aliases from the share corpus.`,
    ).toBe(0);
  });
});

describe('MAP-UI-03: getPublicMap summary projection (D-09 / share-projection-mirrors-auth-projection)', () => {
  // ──────────────────────────────────────────────────────────────────────────────
  // Background: In share mode there is NO client-side useEntries join for map pins.
  // The tooltip excerpt source (summary) MUST come from the server projection.
  // Plan 50-03 adds `summary: entries.summary` to the getPublicMap pins select.
  // The entries table is already INNER JOINed for the is_public=true privacy filter,
  // so no new join is required — summary only ever reflects a public entry.
  //
  // These two tests implement D-09 (share-parity):
  //   Test 1 — presence: a public pin's summary is projected correctly.
  //   Test 2 — absence/privacy: a private entry's pin is dropped entirely (INNER JOIN
  //            excludes it) and its distinctive summary never appears in the response.
  // ──────────────────────────────────────────────────────────────────────────────

  async function seedMap(name: string) {
    const [row] = await handle.db
      .insert(maps)
      .values({ universeId, name })
      .returning();
    return row!;
  }

  async function seedEntryWithSummary(opts: {
    isPublic: boolean;
    title: string;
    summary: string;
  }) {
    const [row] = await handle.db
      .insert(entries)
      .values({
        universeId,
        title: opts.title,
        entryType: 'location',
        isPublic: opts.isPublic,
        summary: opts.summary,
      })
      .returning();
    return row!;
  }

  async function seedPin(mapId: string, entryId: string) {
    const [row] = await handle.db
      .insert(mapPins)
      .values({ mapId, entryId, x: 0.5, y: 0.5 })
      .returning();
    return row!;
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Test 1 — MAP-UI-03 presence: a public pin carries summary equal to seeded value
  // ──────────────────────────────────────────────────────────────────────────────
  it('public pin summary matches seeded entry summary in getPublicMap response (MAP-UI-03 presence)', async () => {
    const seededSummary = 'A grand coastal city known for its silver towers.';
    const map = await seedMap('Test Map Presence');
    const entry = await seedEntryWithSummary({
      isPublic: true,
      title: 'Silverhaven',
      summary: seededSummary,
    });
    await seedPin(map.id, entry.id);

    const res = await appRequest('GET', `/api/share/maps/${map.id}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(
      res.status,
      `MAP-UI-03 presence: GET /api/share/maps/${map.id} must return 200. ` +
        `If 404, the map was not seeded under the share token's universe.`,
    ).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pins: any[] = res.body?.pins ?? [];
    expect(
      pins.length,
      `MAP-UI-03 presence: response must include exactly 1 pin (the public entry pin). ` +
        `Got ${pins.length} pins. Pins: ${JSON.stringify(pins)}`,
    ).toBe(1);

    const pin = pins[0];
    expect(
      pin,
      `MAP-UI-03 presence (D-09): the pin must carry a 'summary' property. ` +
        `Missing 'summary' means getPublicMap pins select omitted entries.summary ` +
        `(share-projection-mirrors-auth-projection invariant violated).`,
    ).toHaveProperty('summary');

    expect(
      pin.summary,
      `MAP-UI-03 presence (D-09): pin.summary must equal the seeded entry summary. ` +
        `Expected: "${seededSummary}". Got: "${pin.summary}". ` +
        `A mismatch means the select is joining the wrong row or defaulting incorrectly.`,
    ).toBe(seededSummary);
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // Test 2 — MAP-UI-03 privacy/absence: a private entry's pin is dropped entirely
  // and its distinctive summary string never appears in the serialized response.
  //
  // The INNER JOIN on entries + eq(entries.isPublic, true) is the privacy gate.
  // If the filter is bypassed, T-50-05 (Information Disclosure) is violated.
  // ──────────────────────────────────────────────────────────────────────────────
  it('private entry pin is absent and its summary never appears in getPublicMap response (MAP-UI-03 privacy)', async () => {
    const secretSummary = 'SEKRET_SUMMARY_7f3a9b: hidden antagonist lair coordinates.';
    const map = await seedMap('Test Map Privacy');

    // Seed a public entry (positive control — ensures the response is not vacuously empty)
    const publicEntry = await seedEntryWithSummary({
      isPublic: true,
      title: 'Public Location',
      summary: 'A visible landmark.',
    });
    await seedPin(map.id, publicEntry.id);

    // Seed a PRIVATE entry with a distinctive summary that must never reach the share visitor
    const privateEntry = await seedEntryWithSummary({
      isPublic: false,
      title: 'Hidden Lair',
      summary: secretSummary,
    });
    await seedPin(map.id, privateEntry.id);

    const res = await appRequest('GET', `/api/share/maps/${map.id}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(
      res.status,
      `MAP-UI-03 privacy: GET /api/share/maps/${map.id} must return 200.`,
    ).toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pins: any[] = res.body?.pins ?? [];

    // The private entry's pin must be absent (INNER JOIN drops is_public=false entries).
    const privatePin = pins.find((p: { entryId: string }) => p.entryId === privateEntry.id);
    expect(
      privatePin,
      `MAP-UI-03 privacy (T-50-05): the private entry's pin must NOT appear in getPublicMap.pins. ` +
        `Found pin: ${JSON.stringify(privatePin)}. ` +
        `Root cause if failing: eq(entries.isPublic, true) INNER JOIN filter removed/bypassed ` +
        `in getPublicMap pins select (share-views.ts).`,
    ).toBeUndefined();

    // The positive control: the public pin must be present.
    expect(
      pins.length,
      `MAP-UI-03 privacy positive control: exactly 1 pin must be returned (the public entry). ` +
        `Got ${pins.length} pins.`,
    ).toBe(1);

    // The distinctive secret summary must never appear anywhere in the serialized response
    // (not in pins, not leaked through any other field).
    const serialized = JSON.stringify(res.body);
    expect(
      serialized.includes(secretSummary),
      `MAP-UI-03 privacy (T-50-05 / Information Disclosure): the private entry's summary ` +
        `"${secretSummary}" must never appear anywhere in the share map response. ` +
        `If this fails, the is_public filter failed to gate the private summary ` +
        `(share-projection-mirrors-auth-projection invariant violated).`,
    ).toBe(false);
  });
});

// ─── ROUTE-03 RED gate: getPublicMap must return a routes bare array ───────────
//
// This minimal test acts as the TDD RED gate for Task 1. It will fail until
// getPublicMap in share-views.ts projects routes. Once the implementation lands
// (GREEN), the full coverage suite (describe 'ROUTE-03: route projection') takes
// over with field-presence, field-absence, and standalone assertions.

describe('ROUTE-03 RED gate: getPublicMap routes bare array', () => {
  async function seedMapForRoute(name: string) {
    const [row] = await handle.db
      .insert(maps)
      .values({ universeId, name })
      .returning();
    return row!;
  }

  it('GET /api/share/maps/:mid returns a routes bare array (ROUTE-03 share contract)', async () => {
    const map = await seedMapForRoute('Route Red Gate Map');

    const res = await appRequest('GET', `/api/share/maps/${map.id}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(
      res.status,
      `ROUTE-03 RED gate: GET /api/share/maps/${map.id} must return 200.`,
    ).toBe(200);
    expect(
      Array.isArray(res.body?.routes),
      `ROUTE-03 RED gate: map detail must include a 'routes' bare array. ` +
        `Got: ${JSON.stringify(res.body?.routes)}. ` +
        `Root cause: getPublicMap in share-views.ts does not yet project mapRoutes.`,
    ).toBe(true);
  });
});

// ─── ROUTE-03: route projection — presence / absence / standalone ─────────────
//
// Full coverage suite for the ROUTE-03 share route projection requirement.
// Proves the three invariants from the threat model (T-51-02, T-51-08):
//
//   Test A (field-presence)  — a route on a PUBLIC entry appears with every
//     authenticated field present (lineStyle, width, showArrow, color, points,
//     name, entryId, id, mapId, createdAt). Fails if the projection omits a
//     field that the auth routeSchema returns ([[share-projection-mirrors-auth-projection]]).
//
//   Test B (field-absence)   — a route on a PRIVATE entry is silently dropped
//     from routes[]. Fails if the INNER JOIN isPublic=true gate is removed.
//
//   Test C (standalone)      — a route with entryId=null always appears
//     regardless of entry privacy (D-11 equivalent).
//
// Lane: DB-gated integration. Re-uses the module-level handle/app/universe/token
// state established in beforeEach.

describe('ROUTE-03: getPublicMap route projection (T-51-02 / T-51-08)', () => {
  async function seedMapR(name: string) {
    const [row] = await handle.db
      .insert(maps)
      .values({ universeId, name })
      .returning();
    return row!;
  }

  async function seedEntryR(opts: { isPublic: boolean; title?: string }) {
    const [row] = await handle.db
      .insert(entries)
      .values({
        universeId,
        title: opts.title ?? 'Route Test Entry',
        entryType: 'location',
        isPublic: opts.isPublic,
      })
      .returning();
    return row!;
  }

  async function seedRoute(opts: {
    mapId: string;
    entryId?: string | null;
    name?: string;
    color?: string | null;
    lineStyle?: string;
    width?: number;
    showArrow?: boolean;
  }) {
    const [row] = await handle.db
      .insert(mapRoutes)
      .values({
        mapId: opts.mapId,
        entryId: opts.entryId ?? null,
        name: opts.name ?? 'Test Route',
        points: JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }]),
        color: opts.color ?? '#ff0000',
        lineStyle: opts.lineStyle ?? 'solid',
        width: opts.width ?? 4,
        showArrow: opts.showArrow ?? false,
      })
      .returning();
    return row!;
  }

  // ──────────────────────────────────────────────────────────────────────────────
  // Test A — field-presence: route on a PUBLIC entry carries all auth fields
  // (T-51-08: share-projection-mirrors-auth-projection)
  // ──────────────────────────────────────────────────────────────────────────────
  it('route linked to a public entry appears with all authenticated fields present (T-51-08 field-presence)', async () => {
    const map = await seedMapR('Route Presence Map');
    const entry = await seedEntryR({ isPublic: true, title: 'Public Route Entry' });
    const route = await seedRoute({
      mapId: map.id,
      entryId: entry.id,
      name: 'Grand Road',
      color: '#00aaff',
      lineStyle: 'dashed',
      width: 6,
      showArrow: true,
    });

    const res = await appRequest('GET', `/api/share/maps/${map.id}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status, 'ROUTE-03 T-51-08: map detail must return 200').toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const routes: any[] = res.body?.routes ?? [];
    expect(
      routes.length,
      `T-51-08 field-presence: expected exactly 1 route. Got ${routes.length}.`,
    ).toBe(1);

    const r = routes[0];
    expect(r.id, 'T-51-08: id must be present').toBe(route.id);
    expect(r.mapId, 'T-51-08: mapId must be present').toBe(map.id);
    expect(r.entryId, 'T-51-08: entryId must be present').toBe(entry.id);
    expect(r.name, 'T-51-08: name must match seeded value').toBe('Grand Road');
    expect(typeof r.points, 'T-51-08: points must be a string').toBe('string');
    expect(r.color, 'T-51-08: color must match seeded value').toBe('#00aaff');
    expect(
      r.lineStyle,
      'T-51-08: lineStyle must be present (field absent if projection dropped it)',
    ).toBe('dashed');
    expect(
      r.width,
      'T-51-08: width must be present (field absent if projection dropped it)',
    ).toBe(6);
    expect(
      r.showArrow,
      'T-51-08: showArrow must be present (field absent if projection dropped it)',
    ).toBe(true);
    expect(r.createdAt, 'T-51-08: createdAt must be present').toBeDefined();
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // Test B — field-absence: route on a PRIVATE entry is silently dropped
  // (T-51-02: INNER JOIN entries WHERE isPublic=true gate)
  // ──────────────────────────────────────────────────────────────────────────────
  it('route linked to a private entry is silently dropped from routes[] (T-51-02 field-absence)', async () => {
    const map = await seedMapR('Route Absence Map');
    const privateEntry = await seedEntryR({ isPublic: false, title: 'Secret Entry' });
    const publicEntry = await seedEntryR({ isPublic: true, title: 'Visible Entry' });

    // Route on a private entry — must be dropped
    await seedRoute({ mapId: map.id, entryId: privateEntry.id, name: 'Secret Road' });
    // Route on a public entry — positive control, must appear
    const publicRoute = await seedRoute({ mapId: map.id, entryId: publicEntry.id, name: 'Public Road' });

    const res = await appRequest('GET', `/api/share/maps/${map.id}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status, 'ROUTE-03 T-51-02: map detail must return 200').toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const routes: any[] = res.body?.routes ?? [];

    // Only the public route must appear
    expect(
      routes.length,
      `T-51-02 field-absence: expected 1 route (the public one). Got ${routes.length}. ` +
        `If 2 are returned, the INNER JOIN isPublic=true gate was removed or bypassed.`,
    ).toBe(1);
    expect(
      routes[0].id,
      'T-51-02: the surviving route must be the public-entry one',
    ).toBe(publicRoute.id);

    // The private route's name must never appear in the serialized response
    const serialized = JSON.stringify(res.body);
    expect(
      serialized.includes('Secret Road'),
      'T-51-02 Information Disclosure: private route name must not appear anywhere in the response.',
    ).toBe(false);
  });

  // ──────────────────────────────────────────────────────────────────────────────
  // Test C — standalone: route with entryId=null always appears
  // (D-11 equivalent: no privacy owner to gate on)
  // ──────────────────────────────────────────────────────────────────────────────
  it('standalone route (entryId=null) always appears regardless of other entries (standalone-included)', async () => {
    const map = await seedMapR('Standalone Route Map');
    const privateEntry = await seedEntryR({ isPublic: false, title: 'Private Entry' });

    // Route on a private entry — must be dropped
    await seedRoute({ mapId: map.id, entryId: privateEntry.id, name: 'Dropped Road' });
    // Standalone route (entryId null) — must always appear
    const standalone = await seedRoute({ mapId: map.id, entryId: null, name: 'Standalone Path' });

    const res = await appRequest('GET', `/api/share/maps/${map.id}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status, 'ROUTE-03 standalone: map detail must return 200').toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const routes: any[] = res.body?.routes ?? [];

    expect(
      routes.length,
      `Standalone-included: expected exactly 1 route (the standalone one). Got ${routes.length}. ` +
        `If 0: standaloneRoutes query missing or wrong WHERE. ` +
        `If 2: linked private route leaked through.`,
    ).toBe(1);
    expect(routes[0].id, 'The surviving route must be the standalone one').toBe(standalone.id);
    expect(routes[0].entryId, 'Standalone route entryId must be null').toBeNull();
  });
});

// ─── NEST-01: getPublicMap pin+region targetMapId projection ──────────────────
//
// Phase 53 Plan 03 — TDD RED gate.
//
// These four tests prove the core NEST-01 share invariants:
//
//   Test A (pin-targetMapId)   — a pin linked to a public entry carries the
//     `targetMapId` field on the share response.  Fails until getPublicMap
//     adds `targetMapId: mapPins.targetMapId` to the pin SELECT.
//
//   Test B (map-only-pin)      — a map-only pin (entryId=null, targetMapId set)
//     appears in share pins[].  Fails until the innerJoin-only pin query is
//     replaced with a linked+standalone split (the standalone branch handles
//     map-only pins modeled on the standaloneRegions pattern).
//
//   Test C (privacy-unchanged) — a pin linked to a private entry is still
//     silently dropped.  Regression guard for T-53-03: the null-entryId
//     relaxation must NOT let a private entry's pin slip through.
//
//   Test D (region-targetMapId) — a standalone region carries the `targetMapId`
//     field on the share response.  Fails until getPublicMap adds
//     `targetMapId: mapRegions.targetMapId` to the standalone-regions SELECT.
//
// Lane: DB-gated integration.

describe('NEST-01: getPublicMap pin+region targetMapId projection (T-53-02 / T-53-03)', () => {
  async function seedMapN(name: string) {
    const [row] = await handle.db
      .insert(maps)
      .values({ universeId, name })
      .returning();
    return row!;
  }

  async function seedEntryN(opts: { isPublic: boolean; title?: string }) {
    const [row] = await handle.db
      .insert(entries)
      .values({
        universeId,
        title: opts.title ?? 'NEST-01 Test Entry',
        entryType: 'location',
        isPublic: opts.isPublic,
      })
      .returning();
    return row!;
  }

  async function seedPinN(opts: {
    mapId: string;
    entryId?: string | null;
    targetMapId?: string | null;
    x?: number;
    y?: number;
  }) {
    const [row] = await handle.db
      .insert(mapPins)
      .values({
        mapId: opts.mapId,
        entryId: opts.entryId ?? null,
        targetMapId: opts.targetMapId ?? null,
        x: opts.x ?? 0.5,
        y: opts.y ?? 0.5,
      })
      .returning();
    return row!;
  }

  async function seedRegionN(opts: {
    mapId: string;
    entryId?: string | null;
    targetMapId?: string | null;
    name?: string;
  }) {
    const [row] = await handle.db
      .insert(mapRegions)
      .values({
        mapId: opts.mapId,
        entryId: opts.entryId ?? null,
        targetMapId: opts.targetMapId ?? null,
        name: opts.name ?? 'NEST-01 Test Region',
        points: JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.5, y: 0.9 }]),
      })
      .returning();
    return row!;
  }

  // ────────────────────────────────────────────────────────────────────
  // Test A — pin carries targetMapId on the share response (T-53-02 field-presence)
  //
  // Purpose: verify the explicit `targetMapId: mapPins.targetMapId` SELECT is
  // present. A null targetMapId is valid (the pin has no target map), so the
  // field must still be present in the response object (not undefined).
  // ────────────────────────────────────────────────────────────────────
  it('pin linked to a public entry carries targetMapId field on share response (T-53-02 pin-field-presence)', async () => {
    const currentMap = await seedMapN('NEST-01 Pin-Field-Presence Map');
    const targetMap = await seedMapN('NEST-01 Target Map');
    const entry = await seedEntryN({ isPublic: true, title: 'Pin Target Entry' });
    const pin = await seedPinN({ mapId: currentMap.id, entryId: entry.id, targetMapId: targetMap.id });

    const res = await appRequest('GET', `/api/share/maps/${currentMap.id}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status, 'NEST-01 pin-field-presence: must return 200').toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pins: any[] = res.body?.pins ?? [];
    expect(
      pins.length,
      `NEST-01 pin-field-presence: expected 1 pin in share response. Got ${pins.length}.`,
    ).toBe(1);

    const p = pins[0];
    expect(p.id, 'NEST-01 pin-field-presence: pin id must match seeded pin').toBe(pin.id);

    // targetMapId MUST be present as a key (not undefined) — the field is included, not filtered.
    expect(
      Object.prototype.hasOwnProperty.call(p, 'targetMapId'),
      `NEST-01 pin-field-presence (T-53-02): pin object must carry a 'targetMapId' property. ` +
        `Got pin shape: ${JSON.stringify(Object.keys(p))}. ` +
        `Root cause: getPublicMap pins SELECT omits targetMapId (share-projection-mirrors-auth-projection).`,
    ).toBe(true);

    expect(
      p.targetMapId,
      'NEST-01 pin-field-presence: targetMapId must equal the seeded target map id',
    ).toBe(targetMap.id);
  });

  // ────────────────────────────────────────────────────────────────────
  // Test B — map-only pin survives the share projection (T-53-03 map-only-pin)
  //
  // Purpose: a pin with entryId=null and a targetMapId MUST appear in the
  // share pins[] array. The current innerJoin(entries) drops it — this test
  // drives the standalone-pin branch analogous to standaloneRegions.
  // ────────────────────────────────────────────────────────────────────
  it('map-only pin (entryId=null, targetMapId set) appears in share pins array (T-53-03 map-only-pin)', async () => {
    const currentMap = await seedMapN('NEST-01 Map-Only-Pin Map');
    const targetMap = await seedMapN('NEST-01 Target Map B');
    const mapOnlyPin = await seedPinN({
      mapId: currentMap.id,
      entryId: null,           // map-only (D-01a)
      targetMapId: targetMap.id,
    });

    // Positive control: also seed a regular public-entry pin so the response is non-vacuously populated
    const publicEntry = await seedEntryN({ isPublic: true, title: 'Public Entry Control' });
    await seedPinN({ mapId: currentMap.id, entryId: publicEntry.id });

    const res = await appRequest('GET', `/api/share/maps/${currentMap.id}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status, 'NEST-01 map-only-pin: must return 200').toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pins: any[] = res.body?.pins ?? [];

    const found = pins.find((p: { id: string }) => p.id === mapOnlyPin.id);
    expect(
      found,
      `NEST-01 map-only-pin (T-53-03): the map-only pin (entryId=null, targetMapId=${targetMap.id}) ` +
        `must appear in share pins[]. ` +
        `Got pins: ${JSON.stringify(pins.map((p: { id: string; entryId: unknown; targetMapId: unknown }) => ({ id: p.id, entryId: p.entryId, targetMapId: p.targetMapId })))}. ` +
        `Root cause: innerJoin(entries) drops pins with null entryId; add a standalone-pin branch.`,
    ).toBeDefined();

    expect(
      found.entryId,
      'NEST-01 map-only-pin: map-only pin must carry entryId=null',
    ).toBeNull();

    expect(
      found.targetMapId,
      'NEST-01 map-only-pin: map-only pin must carry the seeded targetMapId',
    ).toBe(targetMap.id);
  });

  // ────────────────────────────────────────────────────────────────────
  // Test C — private-entry pin is still dropped (T-53-03 privacy-unchanged)
  //
  // Regression guard: the nullable-entryId relaxation for map-only pins must
  // NOT create a path where a pin linked to a private entry bypasses isPublic.
  // A pin with a non-null entryId MUST remain gated by the isPublic filter.
  // ────────────────────────────────────────────────────────────────────
  it('pin linked to a private entry is still silently dropped from share pins (T-53-03 privacy-unchanged)', async () => {
    const currentMap = await seedMapN('NEST-01 Privacy Map');
    const privateEntry = await seedEntryN({ isPublic: false, title: 'Private Entry NEST-01' });
    const publicEntry = await seedEntryN({ isPublic: true, title: 'Public Entry NEST-01' });

    // Pin on a private entry — must be dropped by the isPublic filter
    await seedPinN({ mapId: currentMap.id, entryId: privateEntry.id });
    // Positive control: pin on a public entry — must appear
    const publicPin = await seedPinN({ mapId: currentMap.id, entryId: publicEntry.id });

    const res = await appRequest('GET', `/api/share/maps/${currentMap.id}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status, 'NEST-01 privacy-unchanged: must return 200').toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pins: any[] = res.body?.pins ?? [];

    expect(
      pins.length,
      `NEST-01 privacy-unchanged (T-53-03): expected 1 pin (the public-entry one). Got ${pins.length}. ` +
        `If 2 are returned, the standalone-pin branch introduced a path where a non-null entryId ` +
        `bypasses the isPublic=true filter (T-53-03 information disclosure).`,
    ).toBe(1);

    expect(
      pins[0].id,
      'NEST-01 privacy-unchanged: the surviving pin must be the public-entry pin',
    ).toBe(publicPin.id);

    // Verify the private entry's title never leaks via any field
    const serialized = JSON.stringify(res.body);
    expect(
      serialized.includes('Private Entry NEST-01'),
      'NEST-01 privacy-unchanged (T-53-03 Information Disclosure): private entry title must never appear in share response.',
    ).toBe(false);
  });

  // ────────────────────────────────────────────────────────────────────
  // Test D — standalone region carries targetMapId (T-53-02 region-field-presence)
  //
  // Purpose: verify `targetMapId: mapRegions.targetMapId` is selected in the
  // standaloneRegions branch. The property must be present (not undefined) even
  // when the region has no target map (null is fine; absence is not).
  // ────────────────────────────────────────────────────────────────────
  it('standalone region carries targetMapId field on share response (T-53-02 region-field-presence)', async () => {
    const currentMap = await seedMapN('NEST-01 Region-Field-Presence Map');
    const targetMap = await seedMapN('NEST-01 Target Map D');
    const region = await seedRegionN({
      mapId: currentMap.id,
      entryId: null,                // standalone — no entry to gate on
      targetMapId: targetMap.id,
      name: 'NEST-01 Standalone Region',
    });

    const res = await appRequest('GET', `/api/share/maps/${currentMap.id}`, {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status, 'NEST-01 region-field-presence: must return 200').toBe(200);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const regions: any[] = res.body?.regions ?? [];

    const found = regions.find((r: { id: string }) => r.id === region.id);
    expect(
      found,
      `NEST-01 region-field-presence: the standalone region must appear in share regions[]. ` +
        `Got regions: ${JSON.stringify(regions.map((r: { id: string }) => r.id))}.`,
    ).toBeDefined();

    expect(
      Object.prototype.hasOwnProperty.call(found, 'targetMapId'),
      `NEST-01 region-field-presence (T-53-02): region object must carry a 'targetMapId' property. ` +
        `Got region shape: ${JSON.stringify(Object.keys(found))}. ` +
        `Root cause: getPublicMap standaloneRegions SELECT omits targetMapId (share-projection-mirrors-auth-projection).`,
    ).toBe(true);

    expect(
      found.targetMapId,
      'NEST-01 region-field-presence: region targetMapId must equal the seeded target map id',
    ).toBe(targetMap.id);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Universe theming (2026-07-10 spec §1.3): backdrop resolution on the
// share meta payload. GET /api/share/universe must echo `theme` and
// resolve `backdropUrl` as a pre-signed share asset URL — with dangling
// tolerance (asset deleted → null, no throw).
// ──────────────────────────────────────────────────────────────────────
describe('Universe theming: share meta backdrop resolution', () => {
  async function seedBackdropAsset() {
    const assetId = crypto.randomUUID();
    await handle.db.insert(assets).values({
      id: assetId,
      universeId,
      filename: 'backdrop.png',
      mimeType: 'image/png',
      extension: 'png',
      sizeBytes: 128,
      thumbSizeBytes: 128,
    });
    return assetId;
  }

  it('GET /api/share/universe resolves backdropUrl and echoes theme for a valid backdropAssetId', async () => {
    const assetId = await seedBackdropAsset();
    const theme = { palette: 'ember' as const, backdropAssetId: assetId };
    await handle.db
      .update(universes)
      .set({ theme })
      .where(eq(universes.id, universeId));

    const res = await appRequest('GET', '/api/share/universe', {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(200);
    expect(res.body?.universe?.theme).toEqual(theme);
    expect(
      res.body?.universe?.backdropUrl,
      `share meta backdropUrl must be a pre-signed share raw-asset URL. ` +
        `Got: ${JSON.stringify(res.body?.universe?.backdropUrl)}`,
    ).toMatch(new RegExp(`^/api/share/assets/${assetId}/raw\\?`));
  });

  it('GET /api/share/universe returns backdropUrl=null when backdropAssetId dangles (asset deleted)', async () => {
    const assetId = await seedBackdropAsset();
    await handle.db
      .update(universes)
      .set({ theme: { backdropAssetId: assetId } })
      .where(eq(universes.id, universeId));
    // Delete the asset row — the theme now points at a dangling id.
    await handle.db.delete(assets).where(eq(assets.id, assetId));

    const res = await appRequest('GET', '/api/share/universe', {
      headers: { 'share-token': activeTokenPlaintext },
    });

    // No throw, no broken URL: dangling tolerance resolves to null.
    expect(res.status).toBe(200);
    expect(res.body?.universe?.theme).toEqual({ backdropAssetId: assetId });
    expect(res.body?.universe?.backdropUrl).toBeNull();
  });

  it('GET /api/share/universe returns theme=null and backdropUrl=null when no theme is set', async () => {
    const res = await appRequest('GET', '/api/share/universe', {
      headers: { 'share-token': activeTokenPlaintext },
    });

    expect(res.status).toBe(200);
    expect(res.body?.universe?.theme).toBeNull();
    expect(res.body?.universe?.backdropUrl).toBeNull();
  });
});

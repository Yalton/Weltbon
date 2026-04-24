import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, seedLargeUniverse, type TestDbHandle } from './helpers.js';
import { setTestDb } from '../src/db/client.js';
import { issueAccessToken } from '../src/services/auth.js';
import { universes, categories, entries } from '../src/db/schema.js';

const DEFAULT_ENTRY_TYPES = [
  'concept', 'entity', 'location', 'event', 'faction',
  'artifact', 'species', 'culture', 'thread',
];

// NAV-01..05 integration coverage + FTS perf assertion at 220 entries.
describe('entry list filters + search (NAV-01..05)', () => {
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

  async function fetchList(universeId: string, token: string, qs = ''): Promise<Response> {
    const url = `http://t/universes/${universeId}/entries${qs ? `?${qs}` : ''}`;
    return app.fetch(new Request(url, { headers: authHeader(token) }));
  }

  /** Seed a small fixture with deterministic entries covering NAV-01..05 cases. */
  async function seedSmallFixture(userId: string) {
    const [universe] = await handle.db
      .insert(universes)
      .values({ userId, name: 'nav-test', description: '', entryTypes: DEFAULT_ENTRY_TYPES })
      .returning();
    if (!universe) throw new Error('failed to insert universe');

    const [catA] = await handle.db
      .insert(categories)
      .values({ universeId: universe.id, label: 'A', icon: '', sortOrder: 0 })
      .returning();
    const [catB] = await handle.db
      .insert(categories)
      .values({ universeId: universe.id, label: 'B', icon: '', sortOrder: 1 })
      .returning();
    if (!catA || !catB) throw new Error('failed to insert categories');

    const inserted = await handle.db
      .insert(entries)
      .values([
        // 0: location, tags [coast], category A
        {
          universeId: universe.id,
          title: 'Coastal Capital',
          entryType: 'location',
          summary: 'Port city on the southern shore',
          body: 'A bustling harbor town at the edge of the sea.',
          tags: ['coast', 'capital'],
          categoryId: catA.id,
        },
        // 1: entity, tags [dragon, north], category A
        {
          universeId: universe.id,
          title: 'Dragon of the North',
          entryType: 'entity',
          summary: 'A mighty wyrm',
          body: 'The dragon soars through storm clouds above the peaks.',
          tags: ['dragon', 'north'],
          categoryId: catA.id,
        },
        // 2: event, tags [dragon, war] — only tag 'dragon', NOT 'war' intersect with index-1
        {
          universeId: universe.id,
          title: 'The Dragon Wars',
          entryType: 'event',
          summary: 'Ancient conflict between realms',
          body: 'Dragons battled in the skies for a hundred years.',
          tags: ['dragon', 'war'],
          categoryId: catB.id,
        },
        // 3: entity, tags [dragon, north, war] — matches tag=dragon AND tag=north AND tag=war
        {
          universeId: universe.id,
          title: 'Warlord Northern Dragon',
          entryType: 'entity',
          summary: 'Scourge of the realms',
          body: 'A winged terror bringing ruin.',
          tags: ['dragon', 'north', 'war'],
          categoryId: catB.id,
        },
        // 4: event, uncategorized
        {
          universeId: universe.id,
          title: 'Quiet Year',
          entryType: 'event',
          summary: 'A time of peace',
          body: 'Nothing notable occurred.',
          tags: ['era-1'],
          categoryId: null,
        },
        // 5: location, uncategorized
        {
          universeId: universe.id,
          title: 'Forgotten Isle',
          entryType: 'location',
          summary: 'Lost in the mists',
          body: 'No one remembers the way there.',
          tags: ['ruin'],
          categoryId: null,
        },
      ])
      .returning();

    return { universe, catA, catB, entries: inserted };
  }

  // ---------------- NAV-01: type filter ----------------

  describe('GET /entries?type= — NAV-01', () => {
    it('narrows entry list to the given entryType only', async () => {
      const { user, token } = await userWithToken('nav01@test.com');
      const { universe } = await seedSmallFixture(user.id);

      const res = await fetchList(universe.id, token, 'type=location');
      expect(res.status).toBe(200);
      const list = await res.json();

      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBe(2);
      for (const row of list) {
        expect(row.entryType).toBe('location');
      }
      const titles = list.map((r: any) => r.title).sort();
      expect(titles).toEqual(['Coastal Capital', 'Forgotten Isle']);
    });

    it('returns empty list for an unknown type (free-form filter)', async () => {
      const { user, token } = await userWithToken('nav01b@test.com');
      const { universe } = await seedSmallFixture(user.id);

      const res = await fetchList(universe.id, token, 'type=nonexistent');
      expect(res.status).toBe(200);
      const list = await res.json();
      expect(list).toEqual([]);
    });
  });

  // ---------------- NAV-02: tag AND filter ----------------

  describe('GET /entries?tag=a&tag=b AND — NAV-02', () => {
    it('returns entries with BOTH tag a AND tag b (AND semantics, not OR)', async () => {
      const { user, token } = await userWithToken('nav02@test.com');
      const { universe } = await seedSmallFixture(user.id);

      // tag=dragon + tag=north should return ONLY entries with BOTH:
      //   index 1 (Dragon of the North — [dragon, north])
      //   index 3 (Warlord Northern Dragon — [dragon, north, war])
      // NOT index 2 (Dragon Wars — [dragon, war] lacks 'north')
      const res = await fetchList(universe.id, token, 'tag=dragon&tag=north');
      expect(res.status).toBe(200);
      const list = await res.json();

      expect(list).toHaveLength(2);
      const titles = list.map((r: any) => r.title).sort();
      expect(titles).toEqual(['Dragon of the North', 'Warlord Northern Dragon']);

      // Each returned entry must contain both tags
      for (const row of list) {
        expect(row.tags).toContain('dragon');
        expect(row.tags).toContain('north');
      }
    });

    it('single tag filter returns every entry with that tag', async () => {
      const { user, token } = await userWithToken('nav02b@test.com');
      const { universe } = await seedSmallFixture(user.id);

      const res = await fetchList(universe.id, token, 'tag=dragon');
      const list = await res.json();
      expect(list).toHaveLength(3);
      for (const row of list) {
        expect(row.tags).toContain('dragon');
      }
    });
  });

  // ---------------- NAV-03: category filter ----------------

  describe('GET /entries?category= — NAV-03', () => {
    it('filters by a specific categoryId', async () => {
      const { user, token } = await userWithToken('nav03@test.com');
      const { universe, catA } = await seedSmallFixture(user.id);

      const res = await fetchList(universe.id, token, `category=${catA.id}`);
      expect(res.status).toBe(200);
      const list = await res.json();

      expect(list).toHaveLength(2);
      for (const row of list) {
        expect(row.categoryId).toBe(catA.id);
      }
    });

    it("supports ?category=uncategorized sentinel (categoryId IS NULL)", async () => {
      const { user, token } = await userWithToken('nav03b@test.com');
      const { universe } = await seedSmallFixture(user.id);

      const res = await fetchList(universe.id, token, 'category=uncategorized');
      expect(res.status).toBe(200);
      const list = await res.json();

      expect(list).toHaveLength(2);
      for (const row of list) {
        expect(row.categoryId).toBeNull();
      }
      const titles = list.map((r: any) => r.title).sort();
      expect(titles).toEqual(['Forgotten Isle', 'Quiet Year']);
    });

    it('returns 400 when categoryId is not a uuid or sentinel', async () => {
      const { user, token } = await userWithToken('nav03c@test.com');
      const { universe } = await seedSmallFixture(user.id);

      const res = await fetchList(universe.id, token, 'category=not-a-uuid');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeTruthy();
    });
  });

  // ---------------- NAV-04: FTS ?q= ----------------

  describe('GET /entries?q= FTS — NAV-04', () => {
    it('matches entries by title/summary/body/tags and orders by rank', async () => {
      const { user, token } = await userWithToken('nav04@test.com');
      const { universe } = await seedSmallFixture(user.id);

      // 'dragon' appears in title/body/tags of multiple entries.
      const res = await fetchList(universe.id, token, 'q=dragon');
      expect(res.status).toBe(200);
      const list = await res.json();

      // Entries 1 (Dragon of the North), 2 (The Dragon Wars), 3 (Warlord Northern Dragon) should all match.
      expect(list.length).toBeGreaterThanOrEqual(3);
      const titles = list.map((r: any) => r.title);
      expect(titles).toContain('Dragon of the North');
      expect(titles).toContain('The Dragon Wars');
      expect(titles).toContain('Warlord Northern Dragon');

      // Rank field present and monotonically non-increasing
      for (const row of list) {
        expect(typeof row.rank).toBe('number');
      }
      for (let i = 1; i < list.length; i++) {
        expect(list[i - 1].rank).toBeGreaterThanOrEqual(list[i].rank);
      }

      // An entry that doesn't mention "dragon" anywhere should NOT be in the results
      expect(titles).not.toContain('Forgotten Isle');
      expect(titles).not.toContain('Quiet Year');
    });

    it('whitespace-only q is treated as absent (no filter, no rank)', async () => {
      const { user, token } = await userWithToken('nav04b@test.com');
      const { universe } = await seedSmallFixture(user.id);

      const res = await fetchList(universe.id, token, 'q=%20%20');
      expect(res.status).toBe(200);
      const list = await res.json();
      expect(list).toHaveLength(6);
      for (const row of list) {
        expect(row.rank).toBeUndefined();
      }
    });

    it('preserves updatedAt DESC ordering when q is absent', async () => {
      const { user, token } = await userWithToken('nav04c@test.com');
      const { universe } = await seedSmallFixture(user.id);

      const res = await fetchList(universe.id, token);
      expect(res.status).toBe(200);
      const list = await res.json();
      expect(list).toHaveLength(6);
      for (let i = 1; i < list.length; i++) {
        const prev = new Date(list[i - 1].updatedAt).getTime();
        const cur = new Date(list[i].updatedAt).getTime();
        expect(prev).toBeGreaterThanOrEqual(cur);
      }
    });
  });

  // ---------------- NAV-05: combined filters ----------------

  describe('GET /entries?type=&tag=&category=&q= combined — NAV-05', () => {
    it('combines FTS with type/tag/category filters via AND', async () => {
      const { user, token } = await userWithToken('nav05@test.com');
      const { universe, catB } = await seedSmallFixture(user.id);

      // Entry 3 ('Warlord Northern Dragon') is:
      //   entryType=entity, tags=[dragon,north,war], category=catB, body mentions 'dragon'
      // Only entry in the fixture that satisfies ALL four filters below.
      const qs = `type=entity&tag=dragon&tag=north&tag=war&category=${catB.id}&q=dragon`;
      const res = await fetchList(universe.id, token, qs);
      expect(res.status).toBe(200);
      const list = await res.json();

      expect(list).toHaveLength(1);
      expect(list[0].title).toBe('Warlord Northern Dragon');
      expect(list[0].entryType).toBe('entity');
      expect(list[0].categoryId).toBe(catB.id);
      expect(list[0].tags).toEqual(expect.arrayContaining(['dragon', 'north', 'war']));
      expect(typeof list[0].rank).toBe('number');
    });
  });

  // ---------------- Cross-tenant still 403 with filters ----------------

  describe('cross-tenant access remains 403 with filters', () => {
    it('stranger cannot list entries with any filter combination', async () => {
      const owner = await userWithToken('owner-nav@test.com');
      const stranger = await userWithToken('stranger-nav@test.com');
      const { universe } = await seedSmallFixture(owner.user.id);

      const res = await fetchList(universe.id, stranger.token, 'type=entity&tag=dragon&q=dragon');
      expect(res.status).toBe(403);
    });
  });

  // ---------------- NAV-04 perf: p95 < 1000ms at 220 entries ----------------

  describe('FTS p95 < 1000ms at 220 seeded entries — NAV-04 perf', () => {
    it('FTS p95 under 1s at 220 entries (uses seedLargeUniverse fixture)', async () => {
      const { user, token } = await userWithToken('nav-perf@test.com');
      const { universeId } = await seedLargeUniverse(handle, user.id);

      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = Date.now();
        const res = await fetchList(universeId, token, 'q=dragon');
        expect(res.status).toBe(200);
        const list = await res.json();
        expect(Array.isArray(list)).toBe(true);
        times.push(Date.now() - t0);
      }

      times.sort((a, b) => a - b);
      // p95 of 5 samples: index floor(0.95 * 5) = 4 → the max.
      const p95 = times[Math.floor(0.95 * times.length)] ?? times[times.length - 1]!;
      expect(p95).toBeLessThan(1000);
    }, 30_000);
  });
});

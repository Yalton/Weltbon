import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createTestDb, createTestUser, type TestDbHandle } from './helpers.js';
import { universes, maps, mapPins, entries } from '../src/db/schema.js';

/**
 * Plan A (sync foundation): every synced table's updatedAt must
 *  (a) exist as timestamptz, and (b) bump automatically on ORM .update()
 * via $onUpdate — sync LWW (S-03) depends on both.
 */
describe('updatedAt: timestamptz + $onUpdate bump (Plan A)', () => {
  let handle: TestDbHandle;
  let userId: string;

  beforeAll(async () => {
    handle = await createTestDb();
    const user = await createTestUser(handle, {
      email: 'updated-at@test.local',
      password: 'longenoughpw12',
    });
    userId = user.id;
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  it('updated_at columns are timestamptz on converted AND new tables', async () => {
    const rows = await handle.db.execute(sql`
      SELECT table_name, data_type FROM information_schema.columns
      WHERE column_name = 'updated_at'
        AND table_schema = current_schema()
        AND table_name IN ('universes','entries','issues','graph_positions','dictionary_words',
                           'categories','links','timeline_pins','diagrams','diagram_nodes','maps',
                           'map_pins','map_regions','map_routes','map_layers','terrain_types',
                           'share_tokens','sync_links')
    `);
    expect(rows.rows).toHaveLength(18);
    for (const r of rows.rows as Array<{ table_name: string; data_type: string }>) {
      expect(r.data_type, `${r.table_name}.updated_at`).toBe('timestamp with time zone');
    }
  });

  it('ORM .update() bumps updatedAt without setting it explicitly (map_pins — a NEW column)', async () => {
    const [u] = await handle.db.insert(universes).values({ userId, name: 'Bump' }).returning();
    const [e] = await handle.db.insert(entries).values({ universeId: u!.id, title: 'P', entryType: 'location' }).returning();
    const [m] = await handle.db.insert(maps).values({ universeId: u!.id, name: 'M' }).returning();
    const [pin] = await handle.db.insert(mapPins).values({ mapId: m!.id, entryId: e!.id, x: 0.5, y: 0.5 }).returning();

    const before = pin!.updatedAt;
    await new Promise((r) => setTimeout(r, 15)); // ensure clock advances past insert stamp
    await handle.db.update(mapPins).set({ x: 0.6 }).where(eq(mapPins.id, pin!.id));

    const [after] = await handle.db.select().from(mapPins).where(eq(mapPins.id, pin!.id));
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before.getTime());
    expect(after!.x).toBe(0.6);
  });

  it('ORM .update() bumps updatedAt on a CONVERTED column too (entries: naive → timestamptz)', async () => {
    const [u] = await handle.db.insert(universes).values({ userId, name: 'Bump2' }).returning();
    const [e] = await handle.db.insert(entries).values({ universeId: u!.id, title: 'Before', entryType: 'concept' }).returning();

    const before = e!.updatedAt;
    await new Promise((r) => setTimeout(r, 15));
    // Deliberately does NOT set updatedAt — routes set it manually today, but
    // $onUpdate must cover any writer that forgets (sync apply will be one).
    await handle.db.update(entries).set({ title: 'After' }).where(eq(entries.id, e!.id));

    const [after] = await handle.db.select().from(entries).where(eq(entries.id, e!.id));
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });
});

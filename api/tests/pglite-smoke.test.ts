import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import * as schema from '../src/db/schema.js';

// Spike gate: run with PGLITE_SPIKE=1. Not part of normal CI lanes (yet) —
// this file exists to answer desktop spec D-07's go/no-go question.
const spike = process.env.PGLITE_SPIKE === '1';

describe.skipIf(!spike)('PGlite viability smoke (desktop spec D-07)', () => {
  it('runs the full migration chain from zero and answers an FTS query', async () => {
    const client = new PGlite(); // in-memory
    const db = drizzle(client, { schema });

    // The entire real migration chain, including GENERATED tsvector DDL
    // (0002 entries.search_vector, 0018 dictionary_words.search_vector).
    await migrate(db, { migrationsFolder: './drizzle' });

    // Seed a user -> universe -> entry through plain inserts (no API layer —

    const [user] = await db
      .insert(schema.users)
      .values({ email: 'spike@test.local', passwordHash: 'x', displayName: 'Spike' })
      .returning();
    const [universe] = await db
      .insert(schema.universes)
      .values({ userId: user!.id, name: 'Spike World' })
      .returning();
    await db.insert(schema.entries).values({
      universeId: universe!.id,
      title: 'The Amber Citadel',
      entryType: 'location',
      summary: 'A fortress of amber glass',
    });

    // GENERATED tsvector populated + websearch_to_tsquery + ts_rank all work.
    const hits = await db.execute(sql`
      SELECT title, ts_rank(search_vector, websearch_to_tsquery('english', 'amber fortress')) AS rank
      FROM entries
      WHERE search_vector @@ websearch_to_tsquery('english', 'amber fortress')
    `);
    expect(hits.rows).toHaveLength(1);
    expect((hits.rows[0] as { title: string }).title).toBe('The Amber Citadel');

    await client.close();
  }, 60_000);
});

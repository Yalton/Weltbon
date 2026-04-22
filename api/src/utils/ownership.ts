import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { universes } from '../db/schema.js';

/**
 * Returns the universe if it belongs to userId.
 * Throws 404 if the universe does not exist at all.
 * Throws 403 if it exists but belongs to someone else.
 *
 * Called inline at the top of every universe-scoped route handler.
 * Do NOT convert this to middleware -- Hono middleware runs before param validation.
 */
export async function requireUniverse(universeId: string, userId: string) {
  const row = await db().query.universes.findFirst({
    where: eq(universes.id, universeId),
  });
  if (!row) {
    throw new HTTPException(404, { message: 'Universe not found' });
  }
  if (row.userId !== userId) {
    // ROADMAP success criterion #4: 403 on cross-tenant access
    throw new HTTPException(403, { message: 'Forbidden' });
  }
  return row;
}

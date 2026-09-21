import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { universes } from '../db/schema.js';

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

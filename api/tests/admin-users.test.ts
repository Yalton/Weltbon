import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { cleanDb, createTestDb, createTestUser, type TestDbHandle } from './helpers.js';
import { adminAuditLog, personalAccessTokens, users } from '../src/db/schema.js';

describe('production admin user-management persistence', () => {
  let handle: TestDbHandle;

  beforeAll(async () => {
    handle = await createTestDb();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
  });

  it('persists disabled account state and retains its audit snapshot after the target is removed', async () => {
    const admin = await createTestUser(handle, {
      email: 'admin@test.dev',
      password: 'longenoughpw12',
    });
    const target = await createTestUser(handle, {
      email: 'target@test.dev',
      password: 'longenoughpw12',
    });

    await handle.db
      .update(users)
      .set({ isAdmin: true })
      .where(eq(users.id, admin.id));
    await handle.db
      .update(users)
      .set({ disabledAt: new Date('2026-08-24T00:00:00.000Z'), disabledReason: 'Requested removal' })
      .where(eq(users.id, target.id));
    await handle.db.insert(personalAccessTokens).values({
      userId: target.id,
      label: 'automation',
      hash: 'a'.repeat(64),
      bodySuffix: 'abc',
      revokedAt: new Date('2026-08-24T00:00:00.000Z'),
    });
    const [event] = await handle.db.insert(adminAuditLog).values({
      actorUserId: admin.id,
      actorEmail: admin.email,
      targetUserId: target.id,
      targetEmail: target.email,
      action: 'disabled',
      details: { refreshTokensRevoked: 2, patsRevoked: 1 },
    }).returning();

    const stored = await handle.db.query.users.findFirst({
      where: eq(users.id, target.id),
      columns: { disabledAt: true, disabledReason: true },
    });
    expect(stored).toEqual({
      disabledAt: new Date('2026-08-24T00:00:00.000Z'),
      disabledReason: 'Requested removal',
    });

    await handle.db.delete(users).where(eq(users.id, target.id));
    const retained = await handle.db.query.adminAuditLog.findFirst({
      where: eq(adminAuditLog.id, event.id),
    });
    expect(retained).toMatchObject({
      actorEmail: 'admin@test.dev',
      targetEmail: 'target@test.dev',
      targetUserId: null,
      action: 'disabled',
      details: { refreshTokensRevoked: 2, patsRevoked: 1 },
    });
  });
});

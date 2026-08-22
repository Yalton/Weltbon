import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';
import { users } from '../src/db/schema.js';
import { isUniqueViolation, pgErrorOf } from '../src/db/pg-error.js';

/**
 * The companion to pg-error.test.ts, which asserts against error shapes typed
 * out by hand. Hand-written shapes cannot catch the failure that actually
 * happened here: a Drizzle upgrade moved the driver error under a wrapper, every
 * `err.code === '23505'` check in the codebase silently stopped matching, and
 * nothing failed — not a typecheck, not a unit test — because the branch simply
 * became unreachable.
 *
 * So this provokes a REAL unique violation through the REAL driver and asserts
 * the helper still finds the code. If a future Drizzle adds another layer, this
 * is the test that goes red.
 *
 * Runs against whichever driver the suite is pointed at, so
 * WELTBON_TEST_DRIVER=pglite exercises the PGlite wrapper shape too.
 */
describe('pgErrorOf against the live driver', () => {
  let handle: TestDbHandle;

  beforeAll(async () => {
    handle = await createTestDb();
  });

  afterAll(async () => {
    await cleanDb(handle);
    await handle.cleanup();
  });

  it('finds 23505 under whatever wrapper the current Drizzle throws', async () => {
    await cleanDb(handle);
    await createTestUser(handle, { email: 'dupe@test.com', password: 'longenoughpw12' });

    let caught: unknown;
    try {
      // Same email again — users.email is unique, so this must raise 23505.
      await handle.db.insert(users).values({
        email: 'dupe@test.com',
        displayName: 'Second',
        passwordHash: 'x'.repeat(60),
      });
      throw new Error('expected the duplicate insert to throw, but it succeeded');
    } catch (err) {
      caught = err;
    }

    // The assertion that matters: not "some error was thrown", but that the
    // helper can still read the code out of it.
    expect(isUniqueViolation(caught)).toBe(true);
    expect(pgErrorOf(caught)?.code).toBe('23505');

    // The wrapper really is a wrapper — if this ever fails, Drizzle stopped
    // wrapping and the plain `err.code` idiom would work again.
    expect((caught as { code?: string }).code).toBeUndefined();
  });
});

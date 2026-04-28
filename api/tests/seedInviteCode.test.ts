import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, cleanDb, type TestDbHandle } from './helpers.js';
import { inviteCodes } from '../src/db/schema.js';

describe('seedInviteCode (CONT-01 first-boot invite seeder)', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let seedInviteCode: (db: any) => Promise<void>;

  const ORIGINAL_INVITE_CODE = process.env.INVITE_CODE;

  beforeAll(async () => {
    handle = await createTestDb();
    const mod = await import('../src/db/seedInviteCode.js');
    seedInviteCode = mod.seedInviteCode;
  });

  afterAll(async () => {
    if (ORIGINAL_INVITE_CODE === undefined) delete process.env.INVITE_CODE;
    else process.env.INVITE_CODE = ORIGINAL_INVITE_CODE;
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
  });

  afterEach(() => {
    delete process.env.INVITE_CODE;
  });

  async function countInvites(): Promise<number> {
    const res = await handle.db.execute(sql`SELECT COUNT(*)::int AS c FROM invite_codes`);
    return Number((res.rows[0] as { c: number }).c);
  }

  it('INVITE_CODE unset → no-op (no row inserted)', async () => {
    delete process.env.INVITE_CODE;
    await seedInviteCode(handle.db);
    expect(await countInvites()).toBe(0);
  });

  it('INVITE_CODE set + table empty → exactly one row inserted with that code', async () => {
    process.env.INVITE_CODE = 'fresh-clone-invite-abc123';
    await seedInviteCode(handle.db);
    const rows = await handle.db.select().from(inviteCodes);
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe('fresh-clone-invite-abc123');
  });

  it('INVITE_CODE set + table already has rows → no-op (existing rows preserved, no second insert)', async () => {
    // Operator-created invite already there
    await handle.db.insert(inviteCodes).values({ code: 'operator-issued-zzz' });
    process.env.INVITE_CODE = 'env-supplied-aaa';
    await seedInviteCode(handle.db);
    const rows = await handle.db.select().from(inviteCodes);
    // Should NOT have inserted env-supplied-aaa; only the operator code remains.
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe('operator-issued-zzz');
  });

  it('INVITE_CODE set + matching row already inserted (race) → does not throw, idempotent', async () => {
    // Simulate the race: another process already inserted this exact code.
    // Since the empty-table guard runs first, this case won't actually hit the
    // insert path — but we still verify no throw and no duplication.
    await handle.db.insert(inviteCodes).values({ code: 'racey-invite' });
    process.env.INVITE_CODE = 'racey-invite';
    await expect(seedInviteCode(handle.db)).resolves.not.toThrow();
    expect(await countInvites()).toBe(1);
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, cleanDb, type TestDbHandle } from './helpers.js';
import { inviteCodes } from '../src/db/schema.js';
import { hashInviteToken } from '../src/services/invite.js';

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

  it('INVITE_CODE set + table empty → exactly one row inserted hashed', async () => {
    const plaintext = 'fresh-clone-invite-abc123';
    process.env.INVITE_CODE = plaintext;
    await seedInviteCode(handle.db);
    const rows = await handle.db.select().from(inviteCodes);
    expect(rows).toHaveLength(1);
    expect(rows[0].hash).toBe(hashInviteToken(plaintext));
    expect(rows[0].bodySuffix).toBe(plaintext.slice(-3));
  });

  it('INVITE_CODE set + table already has rows → no-op (existing rows preserved, no second insert)', async () => {
    // Operator-created invite already there
    const operatorCode = 'operator-issued-zzz';
    await handle.db.insert(inviteCodes).values({
      hash: hashInviteToken(operatorCode),
      bodySuffix: operatorCode.slice(-3),
      label: 'operator',
      ownerId: null,
    });
    process.env.INVITE_CODE = 'env-supplied-aaa';
    await seedInviteCode(handle.db);
    const rows = await handle.db.select().from(inviteCodes);
    // Should NOT have inserted env-supplied-aaa; only the operator code remains.
    expect(rows).toHaveLength(1);
    expect(rows[0].hash).toBe(hashInviteToken(operatorCode));
  });

  it('INVITE_CODE set + matching row already inserted (race) → does not throw, idempotent', async () => {
    // Simulate the race: another process already inserted this exact code.
    // Since the empty-table guard runs first, this case won't actually hit the
    // insert path — but we still verify no throw and no duplication.
    const plaintext = 'racey-invite';
    await handle.db.insert(inviteCodes).values({
      hash: hashInviteToken(plaintext),
      bodySuffix: plaintext.slice(-3),
      label: 'racey',
      ownerId: null,
    });
    process.env.INVITE_CODE = plaintext;
    await expect(seedInviteCode(handle.db)).resolves.not.toThrow();
    expect(await countInvites()).toBe(1);
  });

  it('two parallel seedInviteCode calls against an empty table converge to exactly one row (WR-05)', async () => {
    const plaintext = 'concurrent-boot-invite-abc123def456';
    process.env.INVITE_CODE = plaintext;
    // Race them: both observe empty table, both attempt insert.
    // UNIQUE(hash) + onConflictDoNothing must converge to 1 row.
    await Promise.all([
      seedInviteCode(handle.db),
      seedInviteCode(handle.db),
    ]);
    expect(await countInvites()).toBe(1);
    const rows = await handle.db.select().from(inviteCodes);
    expect(rows[0].hash).toBe(hashInviteToken(plaintext));
  });
});

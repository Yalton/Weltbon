import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';
import { personalAccessTokens } from '../src/db/schema.js';

describe('PAT service', () => {
  let handle: TestDbHandle;

  beforeAll(async () => {
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    setTestDb(handle.db as any, handle.pool);
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
  });

  // ─── generatePatToken ──────────────────────────────────────────────────────

  it('generatePatToken: plaintext starts with wbn_pat_', async () => {
    const { generatePatToken } = await import('../src/services/pat.js');
    const { plaintext } = generatePatToken();
    expect(plaintext.startsWith('wbn_pat_')).toBe(true);
  });

  it('generatePatToken: total plaintext length is 51 chars (8 prefix + 43 body)', async () => {
    const { generatePatToken } = await import('../src/services/pat.js');
    const { plaintext } = generatePatToken();
    expect(plaintext.length).toBe(51);
  });

  it('generatePatToken: hash is 64 hex chars (SHA-256)', async () => {
    const { generatePatToken } = await import('../src/services/pat.js');
    const { hash } = generatePatToken();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generatePatToken: bodySuffix is exactly 3 chars and equals last 3 chars of body', async () => {
    const { generatePatToken } = await import('../src/services/pat.js');
    const { plaintext, bodySuffix } = generatePatToken();
    const body = plaintext.slice('wbn_pat_'.length);
    expect(bodySuffix.length).toBe(3);
    expect(bodySuffix).toBe(body.slice(-3));
  });

  it('generatePatToken: two consecutive calls produce distinct plaintexts (entropy sanity)', async () => {
    const { generatePatToken } = await import('../src/services/pat.js');
    const first = generatePatToken();
    const second = generatePatToken();
    expect(first.plaintext).not.toBe(second.plaintext);
    expect(first.hash).not.toBe(second.hash);
  });

  // ─── hashPatToken ──────────────────────────────────────────────────────────

  it('hashPatToken: deterministic — same input yields same 64-hex-char output', async () => {
    const { hashPatToken } = await import('../src/services/pat.js');
    const h1 = hashPatToken('wbn_pat_testtoken');
    const h2 = hashPatToken('wbn_pat_testtoken');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashPatToken: different inputs produce different hashes', async () => {
    const { hashPatToken } = await import('../src/services/pat.js');
    const h1 = hashPatToken('wbn_pat_aaa');
    const h2 = hashPatToken('wbn_pat_bbb');
    expect(h1).not.toBe(h2);
  });

  // ─── lookupPat ────────────────────────────────────────────────────────────

  it('lookupPat: returns null when no matching row exists', async () => {
    const { lookupPat, generatePatToken } = await import('../src/services/pat.js');
    const { plaintext } = generatePatToken();
    const result = await lookupPat(plaintext);
    expect(result).toBeNull();
  });

  it('lookupPat: returns null immediately for plaintext without wbn_pat_ prefix (no DB query)', async () => {
    const { lookupPat } = await import('../src/services/pat.js');
    const result = await lookupPat('not_a_pat_token_abcdef12345678');
    expect(result).toBeNull();
  });

  it('lookupPat: returns { id, userId } when a matching row exists', async () => {
    const { lookupPat, generatePatToken, hashPatToken } = await import('../src/services/pat.js');
    const user = await createTestUser(handle, { email: 'lookup@test.com', password: 'password123456' });
    const { plaintext, bodySuffix } = generatePatToken();
    const hash = hashPatToken(plaintext);

    const [row] = await handle.db.insert(personalAccessTokens).values({
      userId: user.id,
      label: 'test token',
      hash,
      bodySuffix,
    }).returning();

    const result = await lookupPat(plaintext);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(row.id);
    expect(result!.userId).toBe(user.id);
  });

  it('lookupPat: last_used_at advances after a successful lookup (fire-and-forget)', async () => {
    const { lookupPat, generatePatToken, hashPatToken } = await import('../src/services/pat.js');
    const user = await createTestUser(handle, { email: 'usage@test.com', password: 'password123456' });
    const { plaintext, bodySuffix } = generatePatToken();
    const hash = hashPatToken(plaintext);

    const [row] = await handle.db.insert(personalAccessTokens).values({
      userId: user.id,
      label: 'usage test',
      hash,
      bodySuffix,
      lastUsedAt: null,
    }).returning();

    expect(row.lastUsedAt).toBeNull();

    await lookupPat(plaintext);
    // Allow fire-and-forget to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    const updated = await handle.db.query.personalAccessTokens.findFirst({
      where: eq(personalAccessTokens.id, row.id),
    });
    expect(updated!.lastUsedAt).not.toBeNull();
  });

  // ─── recordPatUsage ───────────────────────────────────────────────────────

  it('recordPatUsage: updates last_used_at on a valid row', async () => {
    const { recordPatUsage, generatePatToken, hashPatToken } = await import('../src/services/pat.js');
    const user = await createTestUser(handle, { email: 'record@test.com', password: 'password123456' });
    const { plaintext, bodySuffix } = generatePatToken();
    const hash = hashPatToken(plaintext);

    const [row] = await handle.db.insert(personalAccessTokens).values({
      userId: user.id,
      label: 'record test',
      hash,
      bodySuffix,
      lastUsedAt: null,
    }).returning();

    // In tests we AWAIT recordPatUsage so we can assert on the result
    await recordPatUsage(row.id);

    const updated = await handle.db.query.personalAccessTokens.findFirst({
      where: eq(personalAccessTokens.id, row.id),
    });
    expect(updated!.lastUsedAt).not.toBeNull();
  });

  it('recordPatUsage: swallows errors for non-existent id (does not throw)', async () => {
    const { recordPatUsage } = await import('../src/services/pat.js');
    // Should not throw even if the id doesn't exist
    await expect(
      recordPatUsage('00000000-0000-0000-0000-000000000000')
    ).resolves.toBeUndefined();
  });
});

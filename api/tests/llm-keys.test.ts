/**
 * Phase 22-04 — /api/llm-keys/* integration tests.
 *
 * Coverage matrix:
 *   - Every route (POST / GET / PUT / DELETE / POST /:id/revalidate) × happy path
 *   - Every error branch (400 / 401 / 404 / 409 / 422 / 503)
 *   - PAT-rejection matrix (LLMKEY-06 / D-13 mirror) — every route returns 401 for PAT bearer
 *   - UNIQUE(user_id, provider) collision → 409
 *   - LLMKEY-03 masking invariant — no response body contains ciphertext / iv / authTag / plaintext
 *   - Strict-state save flow — rejected provider response → 422 with row-count-0 assertion
 *   - LLMKEY-08 behavioral coverage — calls the exported assertLlmKeyEncryptionKey directly
 *     with a real test DB + stubbed cfg to pin every quadrant of the (rows × env) truth table
 *
 * Mocking strategy:
 *   - vi.mock('../src/services/llm-key.js') stubs validateAtProvider; other exports
 *     (encryptKey, getDecryptedKey, ProviderValidationError) pass through to the real impl.
 *   - The DB is REAL (createTestDb with an isolated schema) — no DB mocking. Every route
 *     exercises a real drizzle SELECT/INSERT/UPDATE/DELETE against PG.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// CRITICAL — must be set BEFORE the *first* env() call in the process. config.ts
// caches `_env` on first call, and api/src/db/client.ts calls env() at module
// scope (line 8). Because import declarations are hoisted above top-level code,
// a plain `process.env.X = ...` at the top of this file runs AFTER all imports
// (including the transitive client.ts→env() chain) have evaluated. vi.hoisted
// runs BEFORE imports so the env var is in place when env() first executes.
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});
import { eq, and } from 'drizzle-orm';
import {
  createTestDb,
  cleanDb,
  createTestUser,
  type TestDbHandle,
} from './helpers.js';
import { llmApiKeys, users } from '../src/db/schema.js';

// Mock the llm-key service so the routes never actually hit Anthropic / OpenAI.
// Default behavior is "happy path"; individual tests override via mockRejectedValueOnce.
vi.mock('../src/services/llm-key.js', async (orig) => {
  const actual = (await orig()) as typeof import('../src/services/llm-key.js');
  return {
    ...actual,
    validateAtProvider: vi.fn(async (_plaintext: string, _provider: 'anthropic' | 'openai') => undefined),
  };
});

// Import the mocked module so we can reach the vi.fn to override per-test.
import { validateAtProvider, ProviderValidationError, encryptKey } from '../src/services/llm-key.js';

describe('llm-key routes (Phase 22-04: LLMKEY-01/03/04/05/06)', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let assertLlmKeyEncryptionKey: any;

  beforeAll(async () => {
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    setTestDb(handle.db as any, handle.pool);
    const indexModule = await import('../src/index.js');
    app = indexModule.createApp();
    assertLlmKeyEncryptionKey = indexModule.assertLlmKeyEncryptionKey;
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
    // Reset the mock to the happy-path default before every test.
    vi.mocked(validateAtProvider).mockReset();
    vi.mocked(validateAtProvider).mockResolvedValue(undefined);
  });

  // ─── Helpers ─────────────────────────────────────────────────────────────

  async function appRequest(
    method: string,
    path: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options: { body?: any; headers?: Record<string, string> } = {}
  ) {
    const headers: Record<string, string> = { ...options.headers };
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const req = new Request(`http://localhost${path}`, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const res = await app.fetch(req);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: any = null;
    if (res.status !== 204) {
      try {
        json = await res.json();
      } catch {
        // no body
      }
    }
    return { status: res.status, body: json };
  }

  async function createUserAndJwt(email = 'user@test.com') {
    const { issueAccessToken } = await import('../src/services/auth.js');
    const user = await createTestUser(handle, { email, password: 'longenoughpw12' });
    const jwt = await issueAccessToken(user.id);
    return { userId: user.id, jwt };
  }

  /** Mint a real PAT via the existing /api/auth/tokens flow — used to test LLMKEY-06. */
  async function mintPatForUser(jwt: string): Promise<string> {
    const res = await appRequest('POST', '/api/auth/tokens', {
      body: { label: 'pat-for-llm-test' },
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (res.status !== 200) {
      throw new Error(`PAT mint failed in test setup: status ${res.status}`);
    }
    return res.body.plaintext as string;
  }

  /** Masking-invariant guard. Forbidden keys must never appear in a JSON response body. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function assertMasked(body: any): void {
    const forbidden = ['ciphertext', 'iv', 'auth_tag', 'authTag', 'key', 'encrypted_key_version', 'encryptedKeyVersion'];
    const visit = (val: unknown): void => {
      if (val === null || typeof val !== 'object') return;
      if (Array.isArray(val)) {
        val.forEach(visit);
        return;
      }
      for (const k of Object.keys(val as Record<string, unknown>)) {
        if (forbidden.includes(k)) {
          throw new Error(`Masking violation: forbidden key '${k}' in response body`);
        }
        visit((val as Record<string, unknown>)[k]);
      }
    };
    visit(body);
  }

  // ─── POST /api/llm-keys ─────────────────────────────────────────────────

  describe('POST /api/llm-keys', () => {
    it('returns 200 + masked row when validateAtProvider succeeds', async () => {
      const { userId, jwt } = await createUserAndJwt('post-happy@test.com');
      const res = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-test-key-abcd', label: 'work' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(200);
      expect(res.body.provider).toBe('anthropic');
      expect(res.body.bodySuffix).toBe('abcd');
      expect(res.body.label).toBe('work');
      expect(res.body.id).toBeTypeOf('string');
      expect(res.body.createdAt).toBeTypeOf('string');
      expect(res.body.lastValidatedAt).toBeTypeOf('string');
      assertMasked(res.body);
      // DB row exists for this user
      const rows = await handle.db
        .select()
        .from(llmApiKeys)
        .where(eq(llmApiKeys.userId, userId));
      expect(rows).toHaveLength(1);
    });

    it('persists ciphertext, iv, authTag, bodySuffix, encryptedKeyVersion=1, label, lastValidatedAt to the DB row', async () => {
      const { userId, jwt } = await createUserAndJwt('post-persist@test.com');
      const res = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'openai', key: 'sk-openai-test-wxyz', label: 'persist' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(200);
      const row = await handle.db.query.llmApiKeys.findFirst({
        where: and(eq(llmApiKeys.userId, userId), eq(llmApiKeys.provider, 'openai')),
      });
      expect(row).toBeTruthy();
      expect(row!.ciphertext).toBeTypeOf('string');
      expect(row!.ciphertext.length).toBeGreaterThan(0);
      expect(row!.iv).toHaveLength(24);
      expect(row!.authTag).toHaveLength(32);
      expect(row!.bodySuffix).toBe('wxyz');
      expect(row!.encryptedKeyVersion).toBe(1);
      expect(row!.label).toBe('persist');
      expect(row!.lastValidatedAt).toBeTruthy();
    });

    it('returns 422 when validateAtProvider throws kind=rejected; DB row count for (userId, anthropic) is 0 (strict-state)', async () => {
      const { userId, jwt } = await createUserAndJwt('post-rejected@test.com');
      vi.mocked(validateAtProvider).mockRejectedValueOnce(
        new ProviderValidationError('Anthropic rejected this key as invalid — check the key and try again.', 'rejected')
      );
      const res = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-bad', label: '' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(422);
      expect(res.body.error).toContain('rejected');
      // Strict-state model: no row was inserted.
      const rows = await handle.db
        .select()
        .from(llmApiKeys)
        .where(and(eq(llmApiKeys.userId, userId), eq(llmApiKeys.provider, 'anthropic')));
      expect(rows).toHaveLength(0);
    });

    it('returns 503 when validateAtProvider throws kind=transient; DB row count is 0', async () => {
      const { userId, jwt } = await createUserAndJwt('post-transient@test.com');
      vi.mocked(validateAtProvider).mockRejectedValueOnce(
        new ProviderValidationError('Anthropic returned 503 — try again in a moment.', 'transient')
      );
      const res = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-transient', label: '' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(503);
      const rows = await handle.db
        .select()
        .from(llmApiKeys)
        .where(eq(llmApiKeys.userId, userId));
      expect(rows).toHaveLength(0);
    });

    it('returns 503 when validateAtProvider throws kind=timeout; DB row count is 0', async () => {
      const { userId, jwt } = await createUserAndJwt('post-timeout@test.com');
      vi.mocked(validateAtProvider).mockRejectedValueOnce(
        new ProviderValidationError('Anthropic did not respond within 5 seconds — try again.', 'timeout')
      );
      const res = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-timeout', label: '' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(503);
      const rows = await handle.db
        .select()
        .from(llmApiKeys)
        .where(eq(llmApiKeys.userId, userId));
      expect(rows).toHaveLength(0);
    });

    it('returns 400 when provider field is missing', async () => {
      const { jwt } = await createUserAndJwt('post-noprovider@test.com');
      const res = await appRequest('POST', '/api/llm-keys', {
        body: { key: 'sk-something' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when key field is missing', async () => {
      const { jwt } = await createUserAndJwt('post-nokey@test.com');
      const res = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when provider is not anthropic or openai', async () => {
      const { jwt } = await createUserAndJwt('post-badprovider@test.com');
      const res = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'cohere', key: 'sk-test' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(400);
    });

    it('returns 401 when no Authorization header', async () => {
      const res = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-test' },
      });
      expect(res.status).toBe(401);
    });

    it('returns 401 when Authorization is a PAT bearer (LLMKEY-06 / D-13 mirror)', async () => {
      const { jwt } = await createUserAndJwt('post-pat-401@test.com');
      const pat = await mintPatForUser(jwt);
      const res = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-test' },
        headers: { Authorization: `Bearer ${pat}` },
      });
      expect(res.status).toBe(401);
    });

    it('returns 409 when a row already exists for the (userId, provider) pair', async () => {
      const { jwt } = await createUserAndJwt('post-409@test.com');
      const r1 = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-first-aaaa', label: 'first' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(r1.status).toBe(200);
      const r2 = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-second-bbbb', label: 'second' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(r2.status).toBe(409);
      expect(r2.body.error).toContain('Use PUT');
    });

    it('response body never includes plaintext, ciphertext, iv, or authTag keys', async () => {
      const { jwt } = await createUserAndJwt('post-mask@test.com');
      const plaintext = 'sk-ant-canary-secret-leak-marker-ZZZZ';
      const res = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: plaintext, label: 'mask' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(200);
      assertMasked(res.body);
      // Verify no ciphertext substring leak — serialize and search.
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(plaintext);
      expect(serialized).not.toContain('canary-secret-leak-marker');
    });
  });

  // ─── GET /api/llm-keys ──────────────────────────────────────────────────

  describe('GET /api/llm-keys', () => {
    it('returns empty array when user has no keys', async () => {
      const { jwt } = await createUserAndJwt('get-empty@test.com');
      const res = await appRequest('GET', '/api/llm-keys', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(0);
    });

    it('returns the list of masked rows, newest first', async () => {
      const { jwt } = await createUserAndJwt('get-list@test.com');
      await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-aaaa', label: 'a' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      // Small pause to ensure createdAt ordering is deterministic.
      await new Promise((r) => setTimeout(r, 5));
      await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'openai', key: 'sk-openai-bbbb', label: 'b' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const res = await appRequest('GET', '/api/llm-keys', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].provider).toBe('openai'); // newest first
      expect(res.body[1].provider).toBe('anthropic');
    });

    it('response array elements never include ciphertext, iv, authTag, or plaintext', async () => {
      const { jwt } = await createUserAndJwt('get-mask@test.com');
      await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-mask-CANARY-1234', label: 'm' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const res = await appRequest('GET', '/api/llm-keys', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(200);
      assertMasked(res.body);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('sk-ant-mask-CANARY-1234');
      expect(serialized).not.toContain('CANARY');
    });

    it('returns 401 when Authorization is a PAT bearer (PAT cannot enumerate LLM keys)', async () => {
      const { jwt } = await createUserAndJwt('get-pat-401@test.com');
      const pat = await mintPatForUser(jwt);
      const res = await appRequest('GET', '/api/llm-keys', {
        headers: { Authorization: `Bearer ${pat}` },
      });
      expect(res.status).toBe(401);
    });

    it('does not leak other users\' keys — user A GET only sees user A rows', async () => {
      const { jwt: jwtA } = await createUserAndJwt('get-isoA@test.com');
      const { jwt: jwtB } = await createUserAndJwt('get-isoB@test.com');
      await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-userA', label: 'A' },
        headers: { Authorization: `Bearer ${jwtA}` },
      });
      await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-userB', label: 'B' },
        headers: { Authorization: `Bearer ${jwtB}` },
      });
      const resA = await appRequest('GET', '/api/llm-keys', {
        headers: { Authorization: `Bearer ${jwtA}` },
      });
      expect(resA.status).toBe(200);
      expect(resA.body).toHaveLength(1);
      expect(resA.body[0].label).toBe('A');
    });
  });

  // ─── PUT /api/llm-keys/:id ──────────────────────────────────────────────

  describe('PUT /api/llm-keys/:id', () => {
    it('replaces the key and returns the updated masked row with new bodySuffix + new lastValidatedAt', async () => {
      const { jwt } = await createUserAndJwt('put-happy@test.com');
      const created = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-original-AAAA', label: 'orig' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(created.status).toBe(200);
      const originalValidatedAt = created.body.lastValidatedAt;
      // Brief pause so lastValidatedAt is observably newer.
      await new Promise((r) => setTimeout(r, 10));
      const res = await appRequest('PUT', `/api/llm-keys/${created.body.id}`, {
        body: { key: 'sk-ant-replaced-BBBB', label: 'replaced' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(200);
      expect(res.body.bodySuffix).toBe('BBBB');
      expect(res.body.label).toBe('replaced');
      expect(res.body.provider).toBe('anthropic'); // from existing row
      expect(new Date(res.body.lastValidatedAt).getTime()).toBeGreaterThan(
        new Date(originalValidatedAt).getTime()
      );
      assertMasked(res.body);
    });

    it('UPDATEs the DB row (same id, new ciphertext/iv/authTag)', async () => {
      const { jwt } = await createUserAndJwt('put-update@test.com');
      const created = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'openai', key: 'sk-openai-old-VVVV', label: '' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const id = created.body.id;
      const before = await handle.db.query.llmApiKeys.findFirst({
        where: eq(llmApiKeys.id, id),
      });
      const res = await appRequest('PUT', `/api/llm-keys/${id}`, {
        body: { key: 'sk-openai-new-NNNN' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(200);
      const after = await handle.db.query.llmApiKeys.findFirst({
        where: eq(llmApiKeys.id, id),
      });
      expect(after!.id).toBe(before!.id);
      expect(after!.ciphertext).not.toBe(before!.ciphertext);
      expect(after!.iv).not.toBe(before!.iv);
      expect(after!.authTag).not.toBe(before!.authTag);
      expect(after!.bodySuffix).toBe('NNNN');
    });

    it('returns 422 when validateAtProvider throws rejected; DB row is unchanged from before PUT', async () => {
      const { jwt } = await createUserAndJwt('put-rejected@test.com');
      const created = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-good-YYYY', label: 'g' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const before = await handle.db.query.llmApiKeys.findFirst({
        where: eq(llmApiKeys.id, created.body.id),
      });
      vi.mocked(validateAtProvider).mockRejectedValueOnce(
        new ProviderValidationError('Anthropic rejected this key as invalid — check the key and try again.', 'rejected')
      );
      const res = await appRequest('PUT', `/api/llm-keys/${created.body.id}`, {
        body: { key: 'sk-ant-revoked-ZZZZ' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(422);
      const after = await handle.db.query.llmApiKeys.findFirst({
        where: eq(llmApiKeys.id, created.body.id),
      });
      expect(after!.ciphertext).toBe(before!.ciphertext);
      expect(after!.iv).toBe(before!.iv);
      expect(after!.bodySuffix).toBe(before!.bodySuffix);
    });

    it('returns 404 when the id does not exist', async () => {
      const { jwt } = await createUserAndJwt('put-404@test.com');
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await appRequest('PUT', `/api/llm-keys/${fakeId}`, {
        body: { key: 'sk-ant-test' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(404);
    });

    it('returns 404 when the id belongs to another user', async () => {
      const { jwt: jwtA } = await createUserAndJwt('put-isoA@test.com');
      const { jwt: jwtB } = await createUserAndJwt('put-isoB@test.com');
      const a = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-userA-key', label: 'A' },
        headers: { Authorization: `Bearer ${jwtA}` },
      });
      const res = await appRequest('PUT', `/api/llm-keys/${a.body.id}`, {
        body: { key: 'sk-ant-userB-key' },
        headers: { Authorization: `Bearer ${jwtB}` },
      });
      expect(res.status).toBe(404);
    });

    it('returns 401 with PAT bearer', async () => {
      const { jwt } = await createUserAndJwt('put-pat-401@test.com');
      const pat = await mintPatForUser(jwt);
      const created = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-test-XXXX' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const res = await appRequest('PUT', `/api/llm-keys/${created.body.id}`, {
        body: { key: 'sk-ant-new' },
        headers: { Authorization: `Bearer ${pat}` },
      });
      expect(res.status).toBe(401);
    });
  });

  // ─── DELETE /api/llm-keys/:id ───────────────────────────────────────────

  describe('DELETE /api/llm-keys/:id', () => {
    it('returns 204 and removes the row', async () => {
      const { jwt } = await createUserAndJwt('del-happy@test.com');
      const created = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-del-XXXX' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const id = created.body.id;
      const res = await appRequest('DELETE', `/api/llm-keys/${id}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(204);
      const row = await handle.db.query.llmApiKeys.findFirst({
        where: eq(llmApiKeys.id, id),
      });
      expect(row).toBeUndefined();
    });

    it('returns 404 when row is not found', async () => {
      const { jwt } = await createUserAndJwt('del-404@test.com');
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const res = await appRequest('DELETE', `/api/llm-keys/${fakeId}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(404);
    });

    it('returns 404 when row belongs to another user; the other user still has the row', async () => {
      const { jwt: jwtA } = await createUserAndJwt('del-isoA@test.com');
      const { jwt: jwtB } = await createUserAndJwt('del-isoB@test.com');
      const a = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-userA-iso' },
        headers: { Authorization: `Bearer ${jwtA}` },
      });
      const res = await appRequest('DELETE', `/api/llm-keys/${a.body.id}`, {
        headers: { Authorization: `Bearer ${jwtB}` },
      });
      expect(res.status).toBe(404);
      // Row should still exist for user A
      const row = await handle.db.query.llmApiKeys.findFirst({
        where: eq(llmApiKeys.id, a.body.id),
      });
      expect(row).toBeTruthy();
    });

    it('returns 401 with PAT bearer', async () => {
      const { jwt } = await createUserAndJwt('del-pat-401@test.com');
      const pat = await mintPatForUser(jwt);
      const created = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-test-pat' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const res = await appRequest('DELETE', `/api/llm-keys/${created.body.id}`, {
        headers: { Authorization: `Bearer ${pat}` },
      });
      expect(res.status).toBe(401);
    });
  });

  // ─── POST /api/llm-keys/:id/revalidate ──────────────────────────────────

  describe('POST /api/llm-keys/:id/revalidate', () => {
    it('returns 200 + new lastValidatedAt when validateAtProvider succeeds; row.lastValidatedAt advanced', async () => {
      const { jwt } = await createUserAndJwt('reval-happy@test.com');
      const created = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-reval-AAAA' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const originalValidatedAt = created.body.lastValidatedAt;
      await new Promise((r) => setTimeout(r, 10));
      const res = await appRequest('POST', `/api/llm-keys/${created.body.id}/revalidate`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(created.body.id);
      expect(res.body.lastValidatedAt).toBeTypeOf('string');
      expect(new Date(res.body.lastValidatedAt).getTime()).toBeGreaterThan(
        new Date(originalValidatedAt).getTime()
      );
      assertMasked(res.body);
    });

    it('returns 422 when validateAtProvider throws rejected; row.lastValidatedAt is UNCHANGED', async () => {
      const { jwt } = await createUserAndJwt('reval-rejected@test.com');
      const created = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-reval-rej' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const before = await handle.db.query.llmApiKeys.findFirst({
        where: eq(llmApiKeys.id, created.body.id),
      });
      vi.mocked(validateAtProvider).mockRejectedValueOnce(
        new ProviderValidationError('Anthropic rejected this key as invalid — check the key and try again.', 'rejected')
      );
      const res = await appRequest('POST', `/api/llm-keys/${created.body.id}/revalidate`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(422);
      const after = await handle.db.query.llmApiKeys.findFirst({
        where: eq(llmApiKeys.id, created.body.id),
      });
      expect(after!.lastValidatedAt!.toISOString()).toBe(before!.lastValidatedAt!.toISOString());
      // Row is NOT deleted on rejection
      expect(after).toBeTruthy();
    });

    it('returns 503 when validateAtProvider throws transient', async () => {
      const { jwt } = await createUserAndJwt('reval-503@test.com');
      const created = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-reval-tr' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      vi.mocked(validateAtProvider).mockRejectedValueOnce(
        new ProviderValidationError('Anthropic returned 503 — try again in a moment.', 'transient')
      );
      const res = await appRequest('POST', `/api/llm-keys/${created.body.id}/revalidate`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(503);
    });

    it('returns 503 when getDecryptedKey returns null (sabotaged authTag)', async () => {
      const { jwt } = await createUserAndJwt('reval-decrypt-fail@test.com');
      const created = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-reval-dec' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      // Sabotage the authTag — flip one hex char so AES-GCM verification fails;
      // getDecryptedKey returns null → revalidate returns 503.
      const row = await handle.db.query.llmApiKeys.findFirst({
        where: eq(llmApiKeys.id, created.body.id),
      });
      const sabotaged = row!.authTag.split('');
      sabotaged[0] = sabotaged[0] === 'a' ? 'b' : 'a';
      await handle.db
        .update(llmApiKeys)
        .set({ authTag: sabotaged.join('') })
        .where(eq(llmApiKeys.id, created.body.id));
      const res = await appRequest('POST', `/api/llm-keys/${created.body.id}/revalidate`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(503);
    });

    it('returns 404 when id belongs to another user', async () => {
      const { jwt: jwtA } = await createUserAndJwt('reval-isoA@test.com');
      const { jwt: jwtB } = await createUserAndJwt('reval-isoB@test.com');
      const a = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-userA-reval' },
        headers: { Authorization: `Bearer ${jwtA}` },
      });
      const res = await appRequest('POST', `/api/llm-keys/${a.body.id}/revalidate`, {
        headers: { Authorization: `Bearer ${jwtB}` },
      });
      expect(res.status).toBe(404);
    });

    it('returns 401 with PAT bearer', async () => {
      const { jwt } = await createUserAndJwt('reval-pat-401@test.com');
      const pat = await mintPatForUser(jwt);
      const created = await appRequest('POST', '/api/llm-keys', {
        body: { provider: 'anthropic', key: 'sk-ant-reval-pat' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const res = await appRequest('POST', `/api/llm-keys/${created.body.id}/revalidate`, {
        headers: { Authorization: `Bearer ${pat}` },
      });
      expect(res.status).toBe(401);
    });
  });

  // ─── OpenAPI surface ────────────────────────────────────────────────────

  describe('OpenAPI surface', () => {
    it('GET /api/openapi.json includes paths starting with /llm-keys', async () => {
      const res = await appRequest('GET', '/api/openapi.json');
      expect(res.status).toBe(200);
      expect(res.body).toBeTruthy();
      const paths = Object.keys(res.body.paths ?? {});
      const llmPaths = paths.filter((p) => p.startsWith('/llm-keys'));
      // Expect at least the POST/GET, the /{id} mutations, and /{id}/revalidate.
      expect(llmPaths.length).toBeGreaterThanOrEqual(3);
      // Base path (POST + GET) appears once — hono normalizes '/' under the mount
      // to the bare '/llm-keys'. The /{id} and /{id}/revalidate paths are separate.
      expect(llmPaths).toContain('/llm-keys');
      expect(llmPaths).toContain('/llm-keys/{id}');
      const revalidatePath = llmPaths.find((p) => p.endsWith('/revalidate'));
      expect(revalidatePath).toBeTruthy();
    });
  });

  // ─── assertLlmKeyEncryptionKey (LLMKEY-08 boot fail-fast behavioral coverage) ─

  describe('assertLlmKeyEncryptionKey (LLMKEY-08 boot fail-fast — Plan 03 behavioral coverage)', () => {
    it('returns without throwing when llm_api_keys is empty and cfg.llmKeyEncryptionKey is undefined', async () => {
      // DB is fresh (beforeEach cleanDb) and llm_api_keys is empty.
      const { env: loadEnvFn } = await import('../src/config.js');
      const baseCfg = loadEnvFn();
      const cfg = { ...baseCfg, llmKeyEncryptionKey: undefined };
      await expect(
        assertLlmKeyEncryptionKey({ db: handle.db, cfg })
      ).resolves.toBeUndefined();
    });

    it('returns without throwing when llm_api_keys is empty and cfg.llmKeyEncryptionKey is set', async () => {
      const { env: loadEnvFn } = await import('../src/config.js');
      const cfg = { ...loadEnvFn(), llmKeyEncryptionKey: '0'.repeat(64) };
      await expect(
        assertLlmKeyEncryptionKey({ db: handle.db, cfg })
      ).resolves.toBeUndefined();
    });

    it('returns without throwing when llm_api_keys has rows and cfg.llmKeyEncryptionKey is set', async () => {
      // Seed one row by going through encryptKey (real encryption — keep the row schema-valid).
      const user = await createTestUser(handle, { email: 'reval-rows-set@test.com', password: 'longenoughpw12' });
      const enc = encryptKey('sk-ant-seed-test-AAAA', '0'.repeat(64));
      await handle.db.insert(llmApiKeys).values({
        userId: user.id,
        provider: 'anthropic',
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        encryptedKeyVersion: enc.version,
        bodySuffix: enc.bodySuffix,
        label: 'seed',
        lastValidatedAt: new Date(),
      });
      const { env: loadEnvFn } = await import('../src/config.js');
      const cfg = { ...loadEnvFn(), llmKeyEncryptionKey: '0'.repeat(64) };
      await expect(
        assertLlmKeyEncryptionKey({ db: handle.db, cfg })
      ).resolves.toBeUndefined();
    });

    it('throws when llm_api_keys has rows and cfg.llmKeyEncryptionKey is undefined; message references LLM_KEY_ENCRYPTION_KEY and "See README ## Self-Host"', async () => {
      // Seed one row.
      const user = await createTestUser(handle, { email: 'reval-rows-unset@test.com', password: 'longenoughpw12' });
      const enc = encryptKey('sk-ant-seed-test-BBBB', '0'.repeat(64));
      await handle.db.insert(llmApiKeys).values({
        userId: user.id,
        provider: 'anthropic',
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        encryptedKeyVersion: enc.version,
        bodySuffix: enc.bodySuffix,
        label: 'seed-unset',
        lastValidatedAt: new Date(),
      });
      const { env: loadEnvFn } = await import('../src/config.js');
      const cfg = { ...loadEnvFn(), llmKeyEncryptionKey: undefined };
      await expect(
        assertLlmKeyEncryptionKey({ db: handle.db, cfg })
      ).rejects.toThrow(/LLM_KEY_ENCRYPTION_KEY must be set/);
      // Verify the thrown message also references the README anchor.
      try {
        await assertLlmKeyEncryptionKey({ db: handle.db, cfg });
      } catch (err) {
        expect((err as Error).message).toMatch(/See README ## Self-Host/);
      }
    });
  });

  // ─── /api/llm-keys/consent (GET + POST) — Phase 22-05 ───────────────────
  describe('consent endpoints', () => {
    it('GET /api/llm-keys/consent returns { consentedAt: null } for a freshly created user', async () => {
      const { jwt } = await createUserAndJwt('consent-fresh@test.com');
      const res = await appRequest('GET', '/api/llm-keys/consent', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ consentedAt: null });
    });

    it('POST /api/llm-keys/consent sets users.llm_consented_at and returns the timestamp', async () => {
      const { userId, jwt } = await createUserAndJwt('consent-post@test.com');
      const before = await handle.db
        .select({ llmConsentedAt: users.llmConsentedAt })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      expect(before[0].llmConsentedAt).toBeNull();

      const res = await appRequest('POST', '/api/llm-keys/consent', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(200);
      expect(res.body.consentedAt).toBeTypeOf('string');
      // Should parse as a valid ISO timestamp.
      expect(Number.isNaN(Date.parse(res.body.consentedAt))).toBe(false);

      const after = await handle.db
        .select({ llmConsentedAt: users.llmConsentedAt })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      expect(after[0].llmConsentedAt).toBeTruthy();
      expect(after[0].llmConsentedAt!.toISOString()).toBe(res.body.consentedAt);
    });

    it('POST /api/llm-keys/consent is idempotent — second call returns the same timestamp as the first (D-07)', async () => {
      const { jwt } = await createUserAndJwt('consent-idempotent@test.com');
      const r1 = await appRequest('POST', '/api/llm-keys/consent', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(r1.status).toBe(200);
      const firstTs = r1.body.consentedAt;

      // Tiny delay so a non-idempotent implementation would produce a different timestamp.
      await new Promise((resolve) => setTimeout(resolve, 10));

      const r2 = await appRequest('POST', '/api/llm-keys/consent', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(r2.status).toBe(200);
      expect(r2.body.consentedAt).toBe(firstTs);
    });

    it('GET /api/llm-keys/consent returns the persisted timestamp after POST', async () => {
      const { jwt } = await createUserAndJwt('consent-get-after-post@test.com');
      const post = await appRequest('POST', '/api/llm-keys/consent', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(post.status).toBe(200);
      const ts = post.body.consentedAt;

      const get = await appRequest('GET', '/api/llm-keys/consent', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(get.status).toBe(200);
      expect(get.body).toEqual({ consentedAt: ts });
    });

    it('GET /api/llm-keys/consent returns 401 for PAT bearer (LLMKEY-06 / D-13)', async () => {
      const { jwt } = await createUserAndJwt('consent-get-pat@test.com');
      const pat = await mintPatForUser(jwt);
      const res = await appRequest('GET', '/api/llm-keys/consent', {
        headers: { Authorization: `Bearer ${pat}` },
      });
      expect(res.status).toBe(401);
    });

    it('POST /api/llm-keys/consent returns 401 for PAT bearer (LLMKEY-06 / D-13)', async () => {
      const { jwt } = await createUserAndJwt('consent-post-pat@test.com');
      const pat = await mintPatForUser(jwt);
      const res = await appRequest('POST', '/api/llm-keys/consent', {
        headers: { Authorization: `Bearer ${pat}` },
      });
      expect(res.status).toBe(401);
    });
  });
});

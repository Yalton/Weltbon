// api/tests/llm-credential.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';

const KEY = 'a'.repeat(64);

describe('resolveCredential', () => {
  let handle: TestDbHandle;
  let userId: string;

  beforeAll(async () => { handle = await createTestDb(); });
  afterAll(async () => { await cleanDb(handle); await handle.cleanup(); });
  beforeEach(async () => {
    await cleanDb(handle);
    const { setTestDb } = await import('../src/db/client.js');
    setTestDb(handle.db as any, handle.pool);
    userId = (await createTestUser(handle, { email: 'r@test.dev', password: 'password12345' })).id;
  });

  it('returns a baseUrl credential for ollama', async () => {
    const { upsertConnection } = await import('../src/services/llm-connection.js');
    const { resolveCredential } = await import('../src/services/llm-credential.js');
    await upsertConnection(userId, 'ollama', 'http://box:11434', '');
    expect(await resolveCredential(userId, 'ollama', KEY)).toEqual({ baseUrl: 'http://box:11434' });
  });

  it('returns null when ollama has no connection at all', async () => {
    const { resolveCredential } = await import('../src/services/llm-credential.js');
    expect(await resolveCredential(userId, 'ollama', KEY)).toBeNull();
  });

  it('returns null for a key-based provider with no key — the engine PROVIDER_ERROR contract', async () => {
    const { resolveCredential } = await import('../src/services/llm-credential.js');
    expect(await resolveCredential(userId, 'anthropic', KEY)).toBeNull();
  });
});

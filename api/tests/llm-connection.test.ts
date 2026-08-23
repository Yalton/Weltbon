import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';

const KEY = 'a'.repeat(64);

describe('llm_connections', () => {
  let handle: TestDbHandle;
  let userId: string;

  beforeAll(async () => { handle = await createTestDb(); });
  afterAll(async () => { await cleanDb(handle); await handle.cleanup(); });
  beforeEach(async () => {
    await cleanDb(handle);
    const { setTestDb } = await import('../src/db/client.js');
    setTestDb(handle.db as any, handle.pool);
    userId = (await createTestUser(handle, { email: 'c@test.dev', password: 'password12345' })).id;
  });

  it('stores an endpoint with no secret at all', async () => {
    const { upsertConnection, getConnection } = await import('../src/services/llm-connection.js');
    await upsertConnection(userId, 'ollama', 'http://192.168.0.9:11434', 'Home box');
    const row = await getConnection(userId, 'ollama');
    expect(row?.baseUrl).toBe('http://192.168.0.9:11434');
    expect(row?.secret).toBeNull();
  });

  it('round-trips an optional secret through encryption', async () => {
    const { upsertConnection, getConnection } = await import('../src/services/llm-connection.js');
    await upsertConnection(userId, 'ollama', 'http://x:11434', '', 'proxy-token', KEY);
    const row = await getConnection(userId, 'ollama', KEY);
    expect(row?.secret).toBe('proxy-token');
  });

  it('is one row per (user, provider) — a second upsert replaces', async () => {
    const { upsertConnection, getConnection } = await import('../src/services/llm-connection.js');
    await upsertConnection(userId, 'ollama', 'http://first:11434', '');
    await upsertConnection(userId, 'ollama', 'http://second:11434', '');
    const row = await getConnection(userId, 'ollama');
    expect(row?.baseUrl).toBe('http://second:11434');
    expect(await handle.db.$count((await import('../src/db/schema.js')).llmConnections)).toBe(1);
  });

  it('returns null secret rather than throwing when the key cannot decrypt', async () => {
    // A rotated LLM_KEY_ENCRYPTION_KEY must not make the row unreadable —
    // the base URL is not a secret and stays usable.
    const { upsertConnection, getConnection } = await import('../src/services/llm-connection.js');
    await upsertConnection(userId, 'ollama', 'http://x:11434', '', 'proxy-token', KEY);
    const row = await getConnection(userId, 'ollama', 'b'.repeat(64));
    expect(row?.baseUrl).toBe('http://x:11434');
    expect(row?.secret).toBeNull();
  });
});

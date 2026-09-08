import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { setTestDb } from '../src/db/client.js';
import { issueAccessToken } from '../src/services/auth.js';
import { authHeader, cleanDb, createTestDb, createTestUser, type TestDbHandle } from './helpers.js';

describe('CI entry-route smoke sentinel', () => {
  let handle: TestDbHandle;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    handle = await createTestDb();
    setTestDb(handle.db as never, handle.pool);
    app = createApp();
  });

  afterAll(async () => {
    await handle?.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
  });

  async function request(method: string, path: string, headers: Record<string, string>, body?: unknown) {
    return app.request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it('allows an owner to create and update an entry but rejects another user', async () => {
    const owner = await createTestUser(handle, { email: 'ci-entry-owner@test.local', password: 'longenoughpw12' });
    const stranger = await createTestUser(handle, { email: 'ci-entry-stranger@test.local', password: 'longenoughpw12' });
    const ownerHeaders = authHeader(await issueAccessToken(owner.id));
    const strangerHeaders = authHeader(await issueAccessToken(stranger.id));

    const universeResponse = await request('POST', '/api/universes', ownerHeaders, { name: 'CI smoke' });
    expect(universeResponse.status).toBe(201);
    const universe = await universeResponse.json() as { id: string };

    const createResponse = await request('POST', `/api/universes/${universe.id}/entries`, ownerHeaders, {
      title: 'Before',
      entryType: 'concept',
      summary: 'Initial value',
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { id: string; title: string; summary: string };
    expect(created).toMatchObject({ title: 'Before', summary: 'Initial value' });

    const updateResponse = await request('PATCH', `/api/universes/${universe.id}/entries/${created.id}`, ownerHeaders, {
      title: 'After',
    });
    expect(updateResponse.status).toBe(200);
    await expect(updateResponse.json()).resolves.toMatchObject({ title: 'After', summary: 'Initial value' });

    const forbiddenResponse = await request('PATCH', `/api/universes/${universe.id}/entries/${created.id}`, strangerHeaders, {
      title: 'Hijacked',
    });
    expect(forbiddenResponse.status).toBe(403);

    const readBackResponse = await request('GET', `/api/universes/${universe.id}/entries/${created.id}`, ownerHeaders);
    expect(readBackResponse.status).toBe(200);
    await expect(readBackResponse.json()).resolves.toMatchObject({ title: 'After', summary: 'Initial value' });
  });
});

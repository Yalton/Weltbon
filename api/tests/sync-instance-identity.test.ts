import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanDb, createTestDb, type TestDbHandle } from './helpers.js';
import { setTestDb } from '../src/db/client.js';
import { instanceIdentity } from '../src/db/schema.js';
import {
  InstanceIdentityUnavailableError,
  localIdentity,
} from '../src/services/sync/handshake.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('database-owned sync instance identity', () => {
  let handle: TestDbHandle;

  beforeAll(async () => {
    handle = await createTestDb();
    setTestDb(handle.db as any, handle.pool);
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  it('seeds exactly one stable database-owned identity', async () => {
    // Mutation caught: replacing the database read with randomUUID() changes
    // the value after cleanDb(), even though unrelated application rows reset.
    const rows = await handle.db.select().from(instanceIdentity);
    expect(rows).toHaveLength(1);
    expect(rows[0].singleton).toBe(true);
    expect(rows[0].instanceId).toMatch(UUID_RE);

    const first = await localIdentity();
    await cleanDb(handle);
    const second = await localIdentity();
    expect(second.instanceId).toBe(first.instanceId);
  });

  it('fails loudly instead of minting a replacement when the row is missing', async () => {
    // Mutation caught: an implicit runtime insert would repopulate this table.
    await handle.db.delete(instanceIdentity);
    await expect(localIdentity()).rejects.toBeInstanceOf(InstanceIdentityUnavailableError);
    expect(await handle.db.select().from(instanceIdentity)).toHaveLength(0);
  });
});

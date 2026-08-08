import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, createTestUser, type TestDbHandle } from './helpers.js';
import { universes } from '../src/db/schema.js';

describe('PDF export in local mode (DV-14)', () => {
  let handle: TestDbHandle;
  const OLD = process.env.WELTBON_LOCAL_MODE;

  beforeAll(async () => {
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setTestDb(handle.db as any, handle.pool);
  });

  afterAll(async () => {
    if (OLD === undefined) delete process.env.WELTBON_LOCAL_MODE;
    else process.env.WELTBON_LOCAL_MODE = OLD;
    await handle.cleanup();
  });

  it('returns a named, explained refusal instead of a 500', async () => {
    process.env.WELTBON_LOCAL_MODE = '1';
    const { _resetEnvForTests } = await import('../src/config.js');
    _resetEnvForTests();
    const indexModule = await import('../src/index.js');
    const app = indexModule.createApp();

    // createTestUser(handle, input) returns { id, email, displayName } — it does
    // NOT mint a token or a universe, so both are built explicitly here.
    const user = await createTestUser(handle, {
      email: 'pdf@example.com',
      password: 'pdfpassword123',
      displayName: 'Pdf',
    });
    const { issueAccessToken } = await import('../src/services/auth.js');
    const token = await issueAccessToken(user.id);
    const [universe] = await handle.db
      .insert(universes)
      .values({ userId: user.id, name: 'Pdf Universe' })
      .returning({ id: universes.id });

    const res = await app.fetch(
      new Request(`http://127.0.0.1/api/universes/${universe.id}/export?format=pdf`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    );

    // 501 Not Implemented: the feature is absent from this build, not broken
    // and not forbidden. The message must name the reason — an unexplained
    // failure here is the thing this task exists to prevent.
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/desktop app/i);
  });
});

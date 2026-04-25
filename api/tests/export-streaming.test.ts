import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import {
  createTestDb,
  cleanDb,
  createTestUser,
  authHeader,
  type TestDbHandle,
} from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';

// Plan 04-02: streaming-only assertions for the markdown ZIP branch.
// PDF / DOCX / "all formats" suites stay describe.skip until plans 04-03..05 land.

describe('EXP-05: markdown ZIP response is streamed (Transfer-Encoding chunked OR no Content-Length)', () => {
  let handle: TestDbHandle;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    handle = await createTestDb();
    setTestDb(handle.db as never, handle.pool);
    app = createApp();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
  });

  it('streams markdown ZIP with chunked transfer (or no Content-Length) and a dated filename', async () => {
    const user = await createTestUser(handle, {
      email: 'md-stream@test.com',
      password: 'longenoughpw12',
    });
    const token = await issueAccessToken(user.id);
    const hdrs = authHeader(token);

    const createRes = await app.request('http://localhost/universes', {
      method: 'POST',
      headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Stream Test World' }),
    });
    const universe = await createRes.json();

    const res = await app.request(
      `http://localhost/universes/${universe.id}/export?format=markdown`,
      { headers: hdrs },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');

    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(/attachment;\s*filename=".+-\d{4}-\d{2}-\d{2}\.zip"/);

    // Hono's c.body(ReadableStream) under @hono/node-server emits either
    // Transfer-Encoding: chunked OR no Content-Length header — both indicate
    // streaming (the alternative would be a known full-body length, which
    // proves the ZIP was buffered in memory). We accept either signal.
    const transferEncoding = res.headers.get('transfer-encoding');
    const contentLength = res.headers.get('content-length');
    const isStreaming = transferEncoding === 'chunked' || contentLength === null;
    expect(isStreaming).toBe(true);
  });
});

import fs from 'node:fs';
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

const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const HAS_CHROMIUM = Boolean(CHROMIUM_PATH && fs.existsSync(CHROMIUM_PATH));
const dPdf = HAS_CHROMIUM ? describe : describe.skip;


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

    const createRes = await app.request('http://localhost/api/universes', {
      method: 'POST',
      headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Stream Test World' }),
    });
    const universe = await createRes.json();

    const res = await app.request(
      `http://localhost/api/universes/${universe.id}/export?format=markdown`,
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

describe('EXP-05: DOCX response carries the wordprocessingml mime type and a dated filename', () => {
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

  // DOCX intentionally does NOT stream chunked — Packer.toBuffer is buffered
  // by design (docx package has no streaming option). CONTEXT.md acknowledges
  // this exemption since DOCX size is bounded. We still assert the response
  // is well-formed (correct mime, correct filename, non-zero body).
  it('returns a wordprocessingml response with the correct dated filename', async () => {
    const user = await createTestUser(handle, {
      email: 'docx-stream@test.com',
      password: 'longenoughpw12',
    });
    const token = await issueAccessToken(user.id);
    const hdrs = authHeader(token);

    const createRes = await app.request('http://localhost/api/universes', {
      method: 'POST',
      headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Docx Stream World' }),
    });
    const universe = (await createRes.json()) as { id: string };

    const res = await app.request(
      `http://localhost/api/universes/${universe.id}/export?format=docx`,
      { headers: hdrs },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(/attachment;\s*filename=".+-\d{4}-\d{2}-\d{2}\.docx"/);

    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(1000);
    // ZIP magic — docx is a ZIP container
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
  });
});

dPdf('EXP-05: PDF response is streamed (Transfer-Encoding chunked OR no Content-Length)', () => {
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

  it('streams PDF with chunked transfer (or no Content-Length) and a dated filename', async () => {
    const user = await createTestUser(handle, {
      email: 'pdf-stream@test.com',
      password: 'longenoughpw12',
    });
    const token = await issueAccessToken(user.id);
    const hdrs = authHeader(token);

    const createRes = await app.request('http://localhost/api/universes', {
      method: 'POST',
      headers: { ...hdrs, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Pdf Stream World' }),
    });
    const universe = (await createRes.json()) as { id: string };

    const res = await app.request(
      `http://localhost/api/universes/${universe.id}/export?format=pdf`,
      { headers: hdrs },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(/attachment;\s*filename=".+-\d{4}-\d{2}-\d{2}\.pdf"/);

    const transferEncoding = res.headers.get('transfer-encoding');
    const contentLength = res.headers.get('content-length');
    const isStreaming = transferEncoding === 'chunked' || contentLength === null;
    expect(isStreaming).toBe(true);

    // Drain so the wrapper's finally block closes Chromium.
    await res.arrayBuffer();
  }, 60_000);
});

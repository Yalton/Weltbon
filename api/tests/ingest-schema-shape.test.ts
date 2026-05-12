/**
 * Phase 17-01 regression guard for the multipart ingest schema.
 *
 * Locks `api/src/routes/ingest.ts` multipartBodySchema to accept File-typed
 * parts. If a future change reverts the schema to z.array(z.string()) /
 * z.string(), the @hono/zod-openapi validator will reject File bodies with
 * a 400 ZodError BEFORE the auth gate runs, and these tests turn red.
 *
 * Runs in the `unit` lane: no DB-helper imports, no live Postgres
 * connection required. Pattern mirrors openapi-schema.test.ts.
 *
 * Soft-status assertion strategy: the test's job is to prove the request
 * passed schema validation, not to verify the specific downstream status
 * code. Any of 401/403/404/500 proves the schema accepted the multipart
 * body; what MUST NOT happen is a 400 ZodError envelope.
 *
 * Requirements covered: INGEST-01, INGEST-02, INGEST-03.
 */
import { describe, it, expect } from 'vitest';
import { createApp } from '../src/index.js';

function makeFile(name: string, content: string, type = 'text/markdown'): File {
  return new File([content], name, { type });
}

// Minimal valid ZIP magic bytes (PK\x03\x04) followed by a few padding bytes.
function makeZipFile(name: string): File {
  const magic = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
  return new File([magic], name, { type: 'application/zip' });
}

// The set of non-2xx, non-Zod statuses that prove the request passed schema
// validation and reached SOME downstream handler. A 400 status would indicate
// the multipart validator rejected the body (the regression we are guarding).
const POST_SCHEMA_STATUSES = [401, 403, 404, 500] as const;

describe('Phase 17 — multipart ingest schema shape (no DB)', () => {
  const app = createApp();
  const FAKE_UID = '00000000-0000-0000-0000-000000000000';

  it('accepts a multipart files[] body without raising a ZodError', async () => {
    const fd = new FormData();
    fd.append('files', makeFile('alpha.md', '# Alpha'));
    fd.append('files', makeFile('beta.md', '# Beta'));
    const res = await app.fetch(
      new Request(`http://localhost/api/universes/${FAKE_UID}/ingest`, {
        method: 'POST',
        body: fd,
      }),
    );
    const bodyText = await res.text();
    let body: unknown = null;
    try { body = bodyText ? JSON.parse(bodyText) : null; } catch { /* non-JSON ok */ }
    // Hard contract: response MUST NOT be a ZodError citing `files`.
    const isZodErrorForFiles =
      !!body &&
      typeof body === 'object' &&
      (body as { success?: unknown }).success === false &&
      Array.isArray((body as { error?: { issues?: unknown } }).error?.issues) &&
      ((body as { error: { issues: Array<{ path?: unknown }> } }).error.issues).some((i) =>
        Array.isArray(i?.path) && (i.path as unknown[]).includes('files'),
      );
    expect(isZodErrorForFiles).toBe(false);
    // Soft contract: status is a non-Zod downstream status — proves the
    // request passed schema validation. The test's job is to prove the
    // request passed schema validation, not to verify the specific
    // downstream status code.
    expect(POST_SCHEMA_STATUSES).toContain(res.status);
    expect(res.status).not.toBe(400); // ZodError would surface here
  });

  it('accepts a multipart zip body without raising a ZodError', async () => {
    const fd = new FormData();
    fd.append('zip', makeZipFile('vault.zip'));
    const res = await app.fetch(
      new Request(`http://localhost/api/universes/${FAKE_UID}/ingest`, {
        method: 'POST',
        body: fd,
      }),
    );
    const bodyText = await res.text();
    let body: unknown = null;
    try { body = bodyText ? JSON.parse(bodyText) : null; } catch { /* non-JSON ok */ }
    const isZodErrorForZip =
      !!body &&
      typeof body === 'object' &&
      (body as { success?: unknown }).success === false &&
      Array.isArray((body as { error?: { issues?: unknown } }).error?.issues) &&
      ((body as { error: { issues: Array<{ path?: unknown }> } }).error.issues).some((i) =>
        Array.isArray(i?.path) && (i.path as unknown[]).includes('zip'),
      );
    expect(isZodErrorForZip).toBe(false);
    // Soft contract: any of 401/403/404/500 proves the schema accepted
    // the multipart body. The test's job is to prove the request passed
    // schema validation, not to verify the specific downstream status code.
    expect(POST_SCHEMA_STATUSES).toContain(res.status);
    expect(res.status).not.toBe(400); // ZodError would surface here
  });

  it('OpenAPI document publishes binary format for files[] items and zip', async () => {
    const res = await app.fetch(new Request('http://localhost/api/openapi.json'));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      paths: Record<string, {
        post?: {
          requestBody?: {
            content?: {
              'multipart/form-data'?: {
                schema?: {
                  properties?: {
                    files?: { type?: string; items?: { format?: string } };
                    zip?: { format?: string };
                  };
                };
              };
            };
          };
        };
      }>;
    };
    const ingestPath = doc.paths['/universes/{uid}/ingest'];
    expect(ingestPath, 'doc.paths["/universes/{uid}/ingest"] must exist').toBeTruthy();
    const mp =
      ingestPath?.post?.requestBody?.content?.['multipart/form-data']?.schema?.properties;
    expect(mp, 'multipart/form-data schema.properties must exist').toBeTruthy();
    // files: array of binary
    expect(mp?.files?.type).toBe('array');
    expect(mp?.files?.items?.format).toBe('binary');
    // zip: single binary
    expect(mp?.zip?.format).toBe('binary');
  });
});

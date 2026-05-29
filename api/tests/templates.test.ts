/**
 * Phase 28 Plan 03 Task 1 — /api/templates integration tests.
 *
 * Coverage matrix (12 behavior cases from PLAN.md):
 *   - GET /templates with no auth returns 401
 *   - GET /templates with valid JWT returns 200 + array, scoped to calling user only
 *   - GET /templates with valid PAT returns 200 (D-13: PAT-or-JWT acceptance)
 *   - POST /templates with valid body returns 201 + inserted row
 *   - POST /templates with duplicate (entryType, name) for same user returns 409 exact error (D-04)
 *   - POST /templates with same name but different entryType succeeds (D-04 per-type uniqueness)
 *   - PUT /templates/:id with valid owner returns 200 + updated row
 *   - PUT /templates/:id renaming to colliding (entryType, name) returns 409
 *   - PUT /templates/:id against another user's id returns 404 (NOT 403)
 *   - DELETE /templates/:id by owner returns 204; row absent from subsequent GET
 *   - DELETE /templates/:id against another user's id returns 404
 *   - POST /templates with clonedFrom field returns 201 + clonedFrom round-trips (D-02)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestDb, cleanDb, createTestUser, type TestDbHandle } from './helpers.js';
import { personalAccessTokens } from '../src/db/schema.js';

describe('routes/templates', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;

  beforeAll(async () => {
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    setTestDb(handle.db as any, handle.pool);
    const indexModule = await import('../src/index.js');
    app = indexModule.createApp();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
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

  /** Create a user and return a JWT for it. */
  async function createUserAndJwt(email = 'user@test.com') {
    const { issueAccessToken } = await import('../src/services/auth.js');
    const user = await createTestUser(handle, { email, password: 'longenoughpw12' });
    const jwt = await issueAccessToken(user.id);
    return { userId: user.id, jwt };
  }

  /** Insert a PAT row directly for a user and return the plaintext token. */
  async function seedPatForUser(userId: string, label = 'test-pat') {
    const { generatePatToken, hashPatToken } = await import('../src/services/pat.js');
    const { plaintext, bodySuffix } = generatePatToken();
    const hash = hashPatToken(plaintext);
    await handle.db
      .insert(personalAccessTokens)
      .values({ userId, label, hash, bodySuffix })
      .returning();
    return plaintext;
  }

  // ─── GET /templates ───────────────────────────────────────────────────────

  describe('GET /templates', () => {
    it('returns 401 with no Authorization header', async () => {
      const res = await appRequest('GET', '/api/templates');
      expect(res.status).toBe(401);
    });

    it('returns 200 + empty array for a user with no templates', async () => {
      const { jwt } = await createUserAndJwt('list-empty@test.com');
      const res = await appRequest('GET', '/api/templates', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(0);
    });

    it('lists only the requesting user\'s templates', async () => {
      const { userId: userAId, jwt: jwtA } = await createUserAndJwt('list-a@test.com');
      const { jwt: jwtB } = await createUserAndJwt('list-b@test.com');

      // Create a template for user A
      await appRequest('POST', '/api/templates', {
        body: { name: 'Hero', entryType: 'entity', summary: '', body: '', meta: [] },
        headers: { Authorization: `Bearer ${jwtA}` },
      });

      // Create a template for user B
      await appRequest('POST', '/api/templates', {
        body: { name: 'Villain', entryType: 'entity', summary: '', body: '', meta: [] },
        headers: { Authorization: `Bearer ${jwtB}` },
      });

      // User A's list should only show their own template
      const res = await appRequest('GET', '/api/templates', {
        headers: { Authorization: `Bearer ${jwtA}` },
      });
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].name).toBe('Hero');
    });

    it('returns 200 with a valid PAT bearer (D-13: PAT-or-JWT acceptance)', async () => {
      const { userId, jwt } = await createUserAndJwt('pat-auth@test.com');

      // Mint a real PAT via the API using JWT, then call /templates with the PAT
      const mintRes = await appRequest('POST', '/api/auth/tokens', {
        body: { label: 'templates-test-pat' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(mintRes.status).toBe(200);
      const pat = mintRes.body.plaintext as string;

      // PAT-authenticated GET /api/templates must return 200 (D-13)
      const res = await appRequest('GET', '/api/templates', {
        headers: { Authorization: `Bearer ${pat}` },
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  // ─── POST /templates ──────────────────────────────────────────────────────

  describe('POST /templates', () => {
    it('creates a template and returns 201 with the inserted row', async () => {
      const { jwt } = await createUserAndJwt('post-create@test.com');
      const res = await appRequest('POST', '/api/templates', {
        body: { name: 'Hero', entryType: 'entity', summary: '', body: '', meta: [] },
        headers: { Authorization: `Bearer ${jwt}` },
      });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        name: 'Hero',
        entryType: 'entity',
        summary: '',
        body: '',
        meta: [],
      });
      expect(res.body.id).toBeTypeOf('string');
      expect(res.body.createdAt).toBeTypeOf('string');
      expect(res.body.updatedAt).toBeTypeOf('string');
      expect(res.body.clonedFrom).toBeNull();
    });

    it('returns 409 with the exact collision message when name collides for same entry type', async () => {
      const { jwt } = await createUserAndJwt('post-409@test.com');

      // First create succeeds
      const first = await appRequest('POST', '/api/templates', {
        body: { name: 'Hero', entryType: 'entity', summary: '', body: '', meta: [] },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(first.status).toBe(201);

      // Second create with same (entryType, name) must return 409 with exact message
      const second = await appRequest('POST', '/api/templates', {
        body: { name: 'Hero', entryType: 'entity', summary: 'Duplicate', body: '', meta: [] },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(second.status).toBe(409);
      // D-04 + UI-SPEC §C exact string — SaveAsTemplateDialog detects by err.status === 409
      // and surfaces err.message (which holds the server's `error` string) under the input.
      expect(second.body.error).toBe('A template named "Hero" already exists for the entity entry type. Pick a different name.');
    });

    it('succeeds when same name is used with a DIFFERENT entryType (D-04 per-type uniqueness)', async () => {
      const { jwt } = await createUserAndJwt('post-diff-type@test.com');

      const first = await appRequest('POST', '/api/templates', {
        body: { name: 'Hero', entryType: 'entity', summary: '', body: '', meta: [] },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(first.status).toBe(201);

      // Same name but different entryType — must succeed
      const second = await appRequest('POST', '/api/templates', {
        body: { name: 'Hero', entryType: 'location', summary: '', body: '', meta: [] },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(second.status).toBe(201);
    });

    it('returns 201 with clonedFrom set and round-trips lineage as plain text (D-02)', async () => {
      const { jwt } = await createUserAndJwt('post-cloned@test.com');
      const res = await appRequest('POST', '/api/templates', {
        body: {
          name: 'My Magic',
          entryType: 'magic-system',
          meta: [{ name: 'source', default_value: '' }],
          clonedFrom: 'magic-system',
        },
        headers: { Authorization: `Bearer ${jwt}` },
      });

      expect(res.status).toBe(201);
      // D-02: clonedFrom round-trips as the plain text string sent in the request
      expect(res.body.clonedFrom).toBe('magic-system');
      expect(res.body.entryType).toBe('magic-system');
      expect(res.body.meta).toEqual([{ name: 'source', default_value: '' }]);
    });
  });

  // ─── PUT /templates/:id ───────────────────────────────────────────────────

  describe('PUT /templates/:id', () => {
    it('renames a template and returns 200 with the updated row', async () => {
      const { jwt } = await createUserAndJwt('put-rename@test.com');

      // Create first
      const created = await appRequest('POST', '/api/templates', {
        body: { name: 'Hero', entryType: 'entity', summary: '', body: '', meta: [] },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(created.status).toBe(201);
      const id = created.body.id as string;

      // Rename
      const res = await appRequest('PUT', `/api/templates/${id}`, {
        body: { name: 'Renamed' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Renamed');
      expect(res.body.id).toBe(id);
    });

    it('returns 409 when rename collides with an existing (entryType, name) for the same user', async () => {
      const { jwt } = await createUserAndJwt('put-409@test.com');

      // Create two templates
      const a = await appRequest('POST', '/api/templates', {
        body: { name: 'Template A', entryType: 'entity', summary: '', body: '', meta: [] },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const b = await appRequest('POST', '/api/templates', {
        body: { name: 'Template B', entryType: 'entity', summary: '', body: '', meta: [] },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);

      // Try to rename B to A's name — must 409
      const res = await appRequest('PUT', `/api/templates/${b.body.id}`, {
        body: { name: 'Template A' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('A template named "Template A" already exists for the entity entry type. Pick a different name.');
    });

    it('returns 404 when targeting another user\'s templateId (NOT 403 — established convention)', async () => {
      const { jwt: jwtA } = await createUserAndJwt('put-cross-a@test.com');
      const { jwt: jwtB } = await createUserAndJwt('put-cross-b@test.com');

      // User B creates a template
      const created = await appRequest('POST', '/api/templates', {
        body: { name: 'B Template', entryType: 'entity', summary: '', body: '', meta: [] },
        headers: { Authorization: `Bearer ${jwtB}` },
      });
      expect(created.status).toBe(201);

      // User A tries to rename user B's template — must 404 (not 403)
      const res = await appRequest('PUT', `/api/templates/${created.body.id}`, {
        body: { name: 'Stolen Name' },
        headers: { Authorization: `Bearer ${jwtA}` },
      });
      expect(res.status).toBe(404);
    });

    // CR-02 regression — pre-fix this case returned 200 (success) or 500 (crash) intermittently;
    // post-fix returns 404 unconditionally. The TOCTOU race itself (DELETE between pre-check and UPDATE)
    // cannot be reproduced without invasive test hooks; the `if (!row)` guard at templates.ts
    // is the post-fix safety net for that race — verified by the grep gate in 28-08-PLAN.md Task 2 <verify>.
    it('returns 404 when the row is deleted between pre-check and update (TOCTOU race)', async () => {
      const { jwt } = await createUserAndJwt('put-toctou@test.com');

      // Create a template
      const created = await appRequest('POST', '/api/templates', {
        body: { name: 'Original', entryType: 'entity', summary: '', body: '', meta: [] },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(created.status).toBe(201);
      const id = created.body.id as string;

      // Out-of-band delete simulates the post-pre-check, pre-update DELETE in the TOCTOU race
      const del = await appRequest('DELETE', `/api/templates/${id}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(del.status).toBe(204);

      // PUT against the now-deleted id must return 404 (not 500)
      const res = await appRequest('PUT', `/api/templates/${id}`, {
        body: { name: 'Renamed' },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Template not found');
    });
  });

  // ─── DELETE /templates/:id ────────────────────────────────────────────────

  describe('DELETE /templates/:id', () => {
    it('deletes the owner\'s template and returns 204; row is absent from subsequent GET', async () => {
      const { jwt } = await createUserAndJwt('delete-own@test.com');

      const created = await appRequest('POST', '/api/templates', {
        body: { name: 'ToDelete', entryType: 'entity', summary: '', body: '', meta: [] },
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(created.status).toBe(201);
      const id = created.body.id as string;

      // Delete
      const del = await appRequest('DELETE', `/api/templates/${id}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(del.status).toBe(204);

      // Subsequent GET must not include the deleted row
      const list = await appRequest('GET', '/api/templates', {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(list.status).toBe(200);
      const ids = (list.body as { id: string }[]).map((t) => t.id);
      expect(ids).not.toContain(id);
    });

    it('returns 404 when targeting another user\'s templateId (NOT 403 — established convention)', async () => {
      const { jwt: jwtA } = await createUserAndJwt('del-cross-a@test.com');
      const { jwt: jwtB } = await createUserAndJwt('del-cross-b@test.com');

      // User B creates a template
      const created = await appRequest('POST', '/api/templates', {
        body: { name: 'B Private', entryType: 'entity', summary: '', body: '', meta: [] },
        headers: { Authorization: `Bearer ${jwtB}` },
      });
      expect(created.status).toBe(201);

      // User A tries to delete user B's template — must 404 (not 403)
      const res = await appRequest('DELETE', `/api/templates/${created.body.id}`, {
        headers: { Authorization: `Bearer ${jwtA}` },
      });
      expect(res.status).toBe(404);
    });
  });
});

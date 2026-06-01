/**
 * Phase 31 DIAGRAM-01 + DIAGRAM-02 route-level integration tests.
 *
 * Covers:
 *   - Create / list / delete diagram (universe-scoped)
 *   - Add / list nodes to a diagram; uniqueness constraint (diagramId, entryId)
 *   - Delete node leaves the underlying entries row intact (DIAGRAM-01 invariant)
 *   - Upsert node position (PATCH-like idempotent POST)
 *   - Edge write-through: POST creates/updates a links row with diagramId, lineStyle, color
 *   - Duplicate (source, target, label) edge POST returns 2xx — no 500 on unique-index collision
 *   - GET diagram detail returns nodes + edges associated with this diagram
 *   - Auth-gated: 401 without token; 403 for cross-tenant access
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';

describe('diagram routes (DIAGRAM-01 + DIAGRAM-02)', () => {
  let handle: TestDbHandle;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    handle = await createTestDb();
    setTestDb(handle.db as any, handle.pool);
    app = createApp();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
  });

  // ─── helpers ───────────────────────────────────────────────────────────────

  async function userWithToken(email: string) {
    const user = await createTestUser(handle, { email, password: 'longenoughpw12' });
    const token = await issueAccessToken(user.id);
    return { user, token, hdrs: authHeader(token) };
  }

  async function req(
    method: string,
    path: string,
    opts?: { headers?: Record<string, string>; body?: unknown }
  ) {
    const url = `http://localhost${path}`;
    const init: RequestInit = { method, headers: { ...opts?.headers } };
    if (opts?.body !== undefined) {
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return app.request(url, init);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function json(res: Response): Promise<any> {
    return res.json();
  }

  async function createUniverse(hdrs: Record<string, string>, name = 'TestWorld') {
    const res = await req('POST', '/universes', { headers: hdrs, body: { name } });
    return json(res);
  }

  async function createEntry(
    uid: string,
    hdrs: Record<string, string>,
    overrides: Record<string, unknown> = {}
  ) {
    const defaults = { title: 'Test Entry', entryType: 'concept' };
    const res = await req('POST', `/universes/${uid}/entries`, {
      headers: hdrs,
      body: { ...defaults, ...overrides },
    });
    return json(res);
  }

  async function createDiagram(
    uid: string,
    hdrs: Record<string, string>,
    body: { name: string; description?: string } = { name: 'My Diagram' }
  ) {
    const res = await req('POST', `/universes/${uid}/diagrams`, { headers: hdrs, body });
    return json(res);
  }

  // ─── DIAGRAM-01: diagram CRUD ──────────────────────────────────────────────

  it('POST /universes/:uid/diagrams creates a diagram', async () => {
    const { hdrs } = await userWithToken('a@test.com');
    const universe = await createUniverse(hdrs);

    const res = await req('POST', `/universes/${universe.id}/diagrams`, {
      headers: hdrs,
      body: { name: 'Family Tree', description: 'The royal bloodline' },
    });

    expect(res.status).toBe(201);
    const diagram = await json(res);
    expect(diagram.id).toBeTruthy();
    expect(diagram.universeId).toBe(universe.id);
    expect(diagram.name).toBe('Family Tree');
    expect(diagram.description).toBe('The royal bloodline');
    expect(diagram.createdAt).toBeTruthy();
  });

  it('GET /universes/:uid/diagrams lists diagrams for the universe', async () => {
    const { hdrs } = await userWithToken('b@test.com');
    const universe = await createUniverse(hdrs);
    await createDiagram(universe.id, hdrs, { name: 'Diagram A' });
    await createDiagram(universe.id, hdrs, { name: 'Diagram B' });

    const res = await req('GET', `/universes/${universe.id}/diagrams`, { headers: hdrs });
    expect(res.status).toBe(200);
    const list = await json(res);
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(2);
    const names = list.map((d: any) => d.name);
    expect(names).toContain('Diagram A');
    expect(names).toContain('Diagram B');
  });

  it('DELETE /universes/:uid/diagrams/:did deletes the diagram', async () => {
    const { hdrs } = await userWithToken('c@test.com');
    const universe = await createUniverse(hdrs);
    const diagram = await createDiagram(universe.id, hdrs, { name: 'To Delete' });

    const delRes = await req('DELETE', `/universes/${universe.id}/diagrams/${diagram.id}`, {
      headers: hdrs,
    });
    expect(delRes.status).toBe(204);

    // Verify it's gone
    const listRes = await req('GET', `/universes/${universe.id}/diagrams`, { headers: hdrs });
    const list = await json(listRes);
    expect(list.length).toBe(0);
  });

  it('GET /universes/:uid/diagrams returns 401 without token', async () => {
    const { hdrs } = await userWithToken('d@test.com');
    const universe = await createUniverse(hdrs);

    const res = await req('GET', `/universes/${universe.id}/diagrams`);
    expect(res.status).toBe(401);
  });

  it('GET /universes/:uid/diagrams returns 403 for cross-tenant access', async () => {
    const { hdrs: hdrs1 } = await userWithToken('owner@test.com');
    const { hdrs: hdrs2 } = await userWithToken('attacker@test.com');
    const universe = await createUniverse(hdrs1);

    const res = await req('GET', `/universes/${universe.id}/diagrams`, { headers: hdrs2 });
    expect(res.status).toBe(403);
  });

  // ─── DIAGRAM-01: node CRUD ─────────────────────────────────────────────────

  it('POST /universes/:uid/diagrams/:did/nodes adds a node to the diagram', async () => {
    const { hdrs } = await userWithToken('e@test.com');
    const universe = await createUniverse(hdrs);
    const entry = await createEntry(universe.id, hdrs, { title: 'King Aldric' });
    const diagram = await createDiagram(universe.id, hdrs);

    const res = await req('POST', `/universes/${universe.id}/diagrams/${diagram.id}/nodes`, {
      headers: hdrs,
      body: { entryId: entry.id, x: 100, y: 200 },
    });

    expect(res.status).toBe(201);
    const node = await json(res);
    expect(node.id).toBeTruthy();
    expect(node.diagramId).toBe(diagram.id);
    expect(node.entryId).toBe(entry.id);
    expect(node.x).toBe(100);
    expect(node.y).toBe(200);
  });

  it('POST /universes/:uid/diagrams/:did/nodes enforces (diagramId, entryId) uniqueness', async () => {
    const { hdrs } = await userWithToken('f@test.com');
    const universe = await createUniverse(hdrs);
    const entry = await createEntry(universe.id, hdrs, { title: 'Queen Elena' });
    const diagram = await createDiagram(universe.id, hdrs);

    // First add succeeds
    await req('POST', `/universes/${universe.id}/diagrams/${diagram.id}/nodes`, {
      headers: hdrs,
      body: { entryId: entry.id, x: 0, y: 0 },
    });

    // Second add of the same entry → conflict
    const res = await req('POST', `/universes/${universe.id}/diagrams/${diagram.id}/nodes`, {
      headers: hdrs,
      body: { entryId: entry.id, x: 50, y: 50 },
    });

    expect(res.status).toBe(409);
  });

  it('DELETE node leaves the entries row intact (DIAGRAM-01 invariant)', async () => {
    const { hdrs } = await userWithToken('g@test.com');
    const universe = await createUniverse(hdrs);
    const entry = await createEntry(universe.id, hdrs, { title: 'Prince Dorian' });
    const diagram = await createDiagram(universe.id, hdrs);

    // Add node
    const addRes = await req('POST', `/universes/${universe.id}/diagrams/${diagram.id}/nodes`, {
      headers: hdrs,
      body: { entryId: entry.id, x: 10, y: 20 },
    });
    const node = await json(addRes);

    // Delete node
    const delRes = await req(
      'DELETE',
      `/universes/${universe.id}/diagrams/${diagram.id}/nodes/${node.id}`,
      { headers: hdrs }
    );
    expect(delRes.status).toBe(204);

    // Entry must still exist
    const entryRes = await req('GET', `/universes/${universe.id}/entries/${entry.id}`, {
      headers: hdrs,
    });
    expect(entryRes.status).toBe(200);
    const entryBody = await json(entryRes);
    expect(entryBody.id).toBe(entry.id);
    expect(entryBody.title).toBe('Prince Dorian');
  });

  it('PATCH node (upsert position) updates x/y for an existing node', async () => {
    const { hdrs } = await userWithToken('h@test.com');
    const universe = await createUniverse(hdrs);
    const entry = await createEntry(universe.id, hdrs, { title: 'Lady Yara' });
    const diagram = await createDiagram(universe.id, hdrs);

    // Add node
    await req('POST', `/universes/${universe.id}/diagrams/${diagram.id}/nodes`, {
      headers: hdrs,
      body: { entryId: entry.id, x: 0, y: 0 },
    });

    // Update position via PATCH
    const patchRes = await req(
      'PATCH',
      `/universes/${universe.id}/diagrams/${diagram.id}/nodes`,
      {
        headers: hdrs,
        body: { entryId: entry.id, x: 300, y: 400 },
      }
    );

    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.x).toBe(300);
    expect(updated.y).toBe(400);
    expect(updated.entryId).toBe(entry.id);
  });

  // ─── DIAGRAM-02: edge write-through ───────────────────────────────────────

  it('POST edge creates a links row with diagramId, lineStyle, and color', async () => {
    const { hdrs } = await userWithToken('i@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'Father' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'Son' });
    const diagram = await createDiagram(universe.id, hdrs);

    const res = await req('POST', `/universes/${universe.id}/diagrams/${diagram.id}/edges`, {
      headers: hdrs,
      body: {
        sourceEntryId: entryA.id,
        targetEntryId: entryB.id,
        label: 'parent',
        lineStyle: 'solid',
        color: '#6366f1',
      },
    });

    expect(res.status).toBe(201);
    const edge = await json(res);
    expect(edge.id).toBeTruthy();
    expect(edge.diagramId).toBe(diagram.id);
    expect(edge.lineStyle).toBe('solid');
    expect(edge.color).toBe('#6366f1');
    expect(edge.sourceEntryId).toBe(entryA.id);
    expect(edge.targetEntryId).toBe(entryB.id);
    expect(edge.label).toBe('parent');
  });

  it('POST edge with duplicate (source, target, label) returns 2xx — no 500', async () => {
    const { hdrs } = await userWithToken('j@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'Alice' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'Bob' });
    const diagram = await createDiagram(universe.id, hdrs);

    const body = {
      sourceEntryId: entryA.id,
      targetEntryId: entryB.id,
      label: 'rival',
      lineStyle: 'dashed',
      color: '#f59e0b',
    };

    // First create
    const first = await req('POST', `/universes/${universe.id}/diagrams/${diagram.id}/edges`, {
      headers: hdrs,
      body,
    });
    expect(first.status).toBe(201);

    // Duplicate — must not 500
    const second = await req('POST', `/universes/${universe.id}/diagrams/${diagram.id}/edges`, {
      headers: hdrs,
      body,
    });
    expect(second.status >= 200 && second.status < 300).toBe(true);
  });

  it('DELETE edge removes the link from the diagram', async () => {
    const { hdrs } = await userWithToken('k@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'Alpha' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'Beta' });
    const diagram = await createDiagram(universe.id, hdrs);

    const edgeRes = await req(
      'POST',
      `/universes/${universe.id}/diagrams/${diagram.id}/edges`,
      {
        headers: hdrs,
        body: {
          sourceEntryId: entryA.id,
          targetEntryId: entryB.id,
          label: 'knows',
          lineStyle: 'dotted',
          color: '#10b981',
        },
      }
    );
    const edge = await json(edgeRes);

    const delRes = await req(
      'DELETE',
      `/universes/${universe.id}/diagrams/${diagram.id}/edges/${edge.id}`,
      { headers: hdrs }
    );
    expect(delRes.status).toBe(204);
  });

  // ─── GET diagram detail ────────────────────────────────────────────────────

  it('GET /universes/:uid/diagrams/:did returns nodes + edges for this diagram', async () => {
    const { hdrs } = await userWithToken('l@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'Empress' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'General' });
    const diagram = await createDiagram(universe.id, hdrs, { name: 'Org Chart' });

    // Add nodes
    await req('POST', `/universes/${universe.id}/diagrams/${diagram.id}/nodes`, {
      headers: hdrs,
      body: { entryId: entryA.id, x: 0, y: 0 },
    });
    await req('POST', `/universes/${universe.id}/diagrams/${diagram.id}/nodes`, {
      headers: hdrs,
      body: { entryId: entryB.id, x: 100, y: 100 },
    });

    // Add edge
    await req('POST', `/universes/${universe.id}/diagrams/${diagram.id}/edges`, {
      headers: hdrs,
      body: {
        sourceEntryId: entryA.id,
        targetEntryId: entryB.id,
        label: 'commands',
        lineStyle: 'solid',
        color: '#3b82f6',
      },
    });

    const res = await req('GET', `/universes/${universe.id}/diagrams/${diagram.id}`, {
      headers: hdrs,
    });

    expect(res.status).toBe(200);
    const detail = await json(res);
    expect(detail.id).toBe(diagram.id);
    expect(detail.name).toBe('Org Chart');
    expect(Array.isArray(detail.nodes)).toBe(true);
    expect(Array.isArray(detail.edges)).toBe(true);
    expect(detail.nodes.length).toBe(2);
    expect(detail.edges.length).toBe(1);

    const edge = detail.edges[0];
    expect(edge.diagramId).toBe(diagram.id);
    expect(edge.lineStyle).toBe('solid');
    expect(edge.color).toBe('#3b82f6');
  });

  // ─── Input validation (T-31-03) ───────────────────────────────────────────

  it('POST node rejects non-finite x/y', async () => {
    const { hdrs } = await userWithToken('m@test.com');
    const universe = await createUniverse(hdrs);
    const entry = await createEntry(universe.id, hdrs, { title: 'Infinite One' });
    const diagram = await createDiagram(universe.id, hdrs);

    const res = await req('POST', `/universes/${universe.id}/diagrams/${diagram.id}/nodes`, {
      headers: hdrs,
      body: { entryId: entry.id, x: Infinity, y: 0 },
    });

    expect(res.status).toBe(400);
  });

  it('POST diagram rejects empty name', async () => {
    const { hdrs } = await userWithToken('n@test.com');
    const universe = await createUniverse(hdrs);

    const res = await req('POST', `/universes/${universe.id}/diagrams`, {
      headers: hdrs,
      body: { name: '' },
    });

    expect(res.status).toBe(400);
  });

  // ─── T-31-02: edge input validation ───────────────────────────────────────

  it('POST edge rejects invalid lineStyle', async () => {
    const { hdrs } = await userWithToken('o@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'X' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'Y' });
    const diagram = await createDiagram(universe.id, hdrs);

    const res = await req('POST', `/universes/${universe.id}/diagrams/${diagram.id}/edges`, {
      headers: hdrs,
      body: {
        sourceEntryId: entryA.id,
        targetEntryId: entryB.id,
        label: 'test',
        lineStyle: 'invalid_style',
        color: '#ffffff',
      },
    });

    expect(res.status).toBe(400);
  });

  // ─── PATCH edge (DIAGRAM-02: T-31-17/18) ──────────────────────────────────

  it('PATCH edge updates label, lineStyle, and color; GET detail reflects new values', async () => {
    const { hdrs } = await userWithToken('p@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'Hero' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'Villain' });
    const diagram = await createDiagram(universe.id, hdrs);

    // Create edge
    const edgeRes = await req('POST', `/universes/${universe.id}/diagrams/${diagram.id}/edges`, {
      headers: hdrs,
      body: {
        sourceEntryId: entryA.id,
        targetEntryId: entryB.id,
        label: 'rivals',
        lineStyle: 'solid',
        color: '#6b7280',
      },
    });
    expect(edgeRes.status).toBe(201);
    const edge = await json(edgeRes);

    // PATCH edge
    const patchRes = await req(
      'PATCH',
      `/universes/${universe.id}/diagrams/${diagram.id}/edges/${edge.id}`,
      {
        headers: hdrs,
        body: { label: 'enemies', lineStyle: 'dotted', color: '#f43f5e' },
      }
    );
    expect(patchRes.status).toBe(200);
    const updated = await json(patchRes);
    expect(updated.label).toBe('enemies');
    expect(updated.lineStyle).toBe('dotted');
    expect(updated.color).toBe('#f43f5e');

    // GET detail reflects the new values
    const detailRes = await req('GET', `/universes/${universe.id}/diagrams/${diagram.id}`, {
      headers: hdrs,
    });
    const detail = await json(detailRes);
    const found = detail.edges.find((e: any) => e.id === edge.id);
    expect(found).toBeDefined();
    expect(found.label).toBe('enemies');
    expect(found.lineStyle).toBe('dotted');
    expect(found.color).toBe('#f43f5e');
  });

  it('PATCH edge with invalid lineStyle is rejected 4xx, row unchanged (T-31-18)', async () => {
    const { hdrs } = await userWithToken('q@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'A' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'B' });
    const diagram = await createDiagram(universe.id, hdrs);

    const edgeRes = await req('POST', `/universes/${universe.id}/diagrams/${diagram.id}/edges`, {
      headers: hdrs,
      body: {
        sourceEntryId: entryA.id,
        targetEntryId: entryB.id,
        label: 'original',
        lineStyle: 'solid',
        color: '#6b7280',
      },
    });
    const edge = await json(edgeRes);

    const patchRes = await req(
      'PATCH',
      `/universes/${universe.id}/diagrams/${diagram.id}/edges/${edge.id}`,
      {
        headers: hdrs,
        body: { lineStyle: 'invalid_style' },
      }
    );
    expect(patchRes.status).toBeGreaterThanOrEqual(400);
    expect(patchRes.status).toBeLessThan(500);

    // Row must be unchanged
    const detailRes = await req('GET', `/universes/${universe.id}/diagrams/${diagram.id}`, {
      headers: hdrs,
    });
    const detail = await json(detailRes);
    const found = detail.edges.find((e: any) => e.id === edge.id);
    expect(found?.lineStyle).toBe('solid');
  });

  it('PATCH edge cross-universe write is blocked 404/403 (T-31-17)', async () => {
    const { hdrs: ownerHdrs } = await userWithToken('r@test.com');
    const { hdrs: attackerHdrs } = await userWithToken('s@test.com');

    const ownerUniverse = await createUniverse(ownerHdrs);
    const entryA = await createEntry(ownerUniverse.id, ownerHdrs, { title: 'Alpha' });
    const entryB = await createEntry(ownerUniverse.id, ownerHdrs, { title: 'Beta' });
    const diagram = await createDiagram(ownerUniverse.id, ownerHdrs);
    const edgeRes = await req(
      'POST',
      `/universes/${ownerUniverse.id}/diagrams/${diagram.id}/edges`,
      {
        headers: ownerHdrs,
        body: {
          sourceEntryId: entryA.id,
          targetEntryId: entryB.id,
          label: 'knows',
          lineStyle: 'solid',
          color: '#6b7280',
        },
      }
    );
    const edge = await json(edgeRes);

    // Attacker has their own universe — attacker targets owner's edge via owner's UID/DID
    const attackRes = await req(
      'PATCH',
      `/universes/${ownerUniverse.id}/diagrams/${diagram.id}/edges/${edge.id}`,
      {
        headers: attackerHdrs,
        body: { label: 'hacked' },
      }
    );
    // Must be blocked — 403 from requireUniverse
    expect(attackRes.status === 403 || attackRes.status === 404).toBe(true);

    // Edge label must be unchanged
    const detailRes = await req('GET', `/universes/${ownerUniverse.id}/diagrams/${diagram.id}`, {
      headers: ownerHdrs,
    });
    const detail = await json(detailRes);
    const found = detail.edges.find((e: any) => e.id === edge.id);
    expect(found?.label).toBe('knows');
  });

  it('PATCH edge without auth returns 401 (T-31-17)', async () => {
    const { hdrs } = await userWithToken('t@test.com');
    const universe = await createUniverse(hdrs);
    const entryA = await createEntry(universe.id, hdrs, { title: 'A' });
    const entryB = await createEntry(universe.id, hdrs, { title: 'B' });
    const diagram = await createDiagram(universe.id, hdrs);
    const edgeRes = await req('POST', `/universes/${universe.id}/diagrams/${diagram.id}/edges`, {
      headers: hdrs,
      body: {
        sourceEntryId: entryA.id,
        targetEntryId: entryB.id,
        label: 'test',
        lineStyle: 'solid',
        color: '#6b7280',
      },
    });
    const edge = await json(edgeRes);

    const patchRes = await req(
      'PATCH',
      `/universes/${universe.id}/diagrams/${diagram.id}/edges/${edge.id}`,
      { body: { label: 'no-auth' } }
    );
    expect(patchRes.status).toBe(401);
  });
});

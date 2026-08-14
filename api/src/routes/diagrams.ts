/**
 * Phase 31 DIAGRAM-01 + DIAGRAM-02: Diagram CRUD, node management, and edge write-through.
 *
 * Edge write-through directionality (resolves CONTEXT open question):
 *   GET diagram detail returns only links rows that carry THIS diagram's id
 *   (links.diagramId = did). Existing links between on-canvas entries that
 *   were created outside of this diagram do NOT render here unless they were
 *   explicitly added via POST .../edges. This keeps diagram views independent
 *   of each other and avoids cross-contamination when the same pair of entries
 *   appears in multiple diagrams with different styles.
 *
 * Auth: every route applies requireAuth (via apiR.use('/universes/*', requireAuth)
 *   at the app level) + requireUniverse (inline per-handler, the established pattern).
 *
 * T-31-01: requireUniverse rejects cross-tenant access (403).
 * T-31-02: lineStyle constrained to solid/dashed/dotted; color must be non-empty.
 * T-31-03: x/y coerced via z.number().finite(); name/description length capped.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, eq, isNull } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { diagrams, diagramNodes, links, entries } from '../db/schema.js';
import { requireUniverse } from '../utils/ownership.js';
import type { AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };

// ─── Shared param schemas ─────────────────────────────────────────────────────

const uidParams = z.object({ uid: z.string().uuid() });
const uidAndDidParams = z.object({ uid: z.string().uuid(), did: z.string().uuid() });
const uidDidNodeParams = z.object({ uid: z.string().uuid(), did: z.string().uuid(), nodeId: z.string().uuid() });
const uidDidEdgeParams = z.object({ uid: z.string().uuid(), did: z.string().uuid(), edgeId: z.string().uuid() });

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const LINE_STYLES = ['solid', 'dashed', 'dotted'] as const;

const createDiagramSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
});

const diagramSchema = z.object({
  id: z.string(),
  universeId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.string().or(z.date()),
});

const createNodeSchema = z.object({
  entryId: z.string().uuid(),
  x: z.number().finite(),
  y: z.number().finite(),
});

const upsertNodeSchema = z.object({
  entryId: z.string().uuid(),
  x: z.number().finite(),
  y: z.number().finite(),
});

const nodeSchema = z.object({
  id: z.string(),
  diagramId: z.string(),
  entryId: z.string(),
  x: z.number(),
  y: z.number(),
});

const createEdgeSchema = z.object({
  sourceEntryId: z.string().uuid(),
  targetEntryId: z.string().uuid(),
  // An edge label is optional in the editor — DrawEdgePopover's submit is gated
  // on `pending` alone, not on a non-empty label — and DiagramEditor posts an
  // explicit `null` for the empty case. A bare required string rejected that,
  // so an unlabeled edge could never be drawn. Same defect as #28 on
  // createLinkSchema.label; `edgeSchema` below already returns it nullable.
  label: z.string().max(100).nullable().optional(),
  lineStyle: z.enum(LINE_STYLES).optional().default('solid'),
  color: z.string().max(50).optional(),
  // Phase 35 REL-01: DIAGRAM-02 keeps `bidirectional` on the diagram-edge API
  // surface (the editor toggle is a diagram concept) but maps it to
  // links.direction at the write-through boundary:
  //   bidirectional=true  → direction='undirected'
  //   bidirectional=false → direction='directed'
  bidirectional: z.boolean().optional().default(false),
});

const edgeSchema = z.object({
  id: z.string(),
  universeId: z.string(),
  sourceEntryId: z.string(),
  targetEntryId: z.string(),
  label: z.string().nullable(),
  // Phase 35 REL-01: diagram edges expose `direction` (the links column value)
  // instead of `bidirectional`. The diagram editor (Plan 04) derives the toggle
  // from `direction === 'undirected'`. Callers who previously read
  // `bidirectional` must now read `direction`.
  direction: z.string(),
  linkType: z.string().nullable(),
  diagramId: z.string().nullable(),
  lineStyle: z.string().nullable(),
  color: z.string().nullable(),
  createdAt: z.string().or(z.date()),
});

const diagramDetailSchema = z.object({
  id: z.string(),
  universeId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.string().or(z.date()),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
});

const errorSchema = z.object({ error: z.string() });

// ─── Route definitions ────────────────────────────────────────────────────────

const listDiagramsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Diagrams'],
  summary: 'List diagrams for a universe',
  security: [{ bearerAuth: [] }],
  request: { params: uidParams },
  responses: {
    200: {
      content: { 'application/json': { schema: z.array(diagramSchema) } },
      description: 'List of diagrams',
    },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Universe not found' },
  },
});

const createDiagramRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Diagrams'],
  summary: 'Create a named diagram',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    body: { content: { 'application/json': { schema: createDiagramSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: diagramSchema } },
      description: 'Diagram created',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Universe not found' },
  },
});

const getDiagramRoute = createRoute({
  method: 'get',
  path: '/{did}',
  tags: ['Diagrams'],
  summary: 'Get diagram detail with nodes and edges',
  security: [{ bearerAuth: [] }],
  request: { params: uidAndDidParams },
  responses: {
    200: {
      content: { 'application/json': { schema: diagramDetailSchema } },
      description: 'Diagram detail',
    },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
  },
});

const deleteDiagramRoute = createRoute({
  method: 'delete',
  path: '/{did}',
  tags: ['Diagrams'],
  summary: 'Delete a diagram',
  security: [{ bearerAuth: [] }],
  request: { params: uidAndDidParams },
  responses: {
    204: { description: 'Diagram deleted' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
  },
});

const addNodeRoute = createRoute({
  method: 'post',
  path: '/{did}/nodes',
  tags: ['Diagrams'],
  summary: 'Add an entry as a positioned node in a diagram',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndDidParams,
    body: { content: { 'application/json': { schema: createNodeSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: nodeSchema } },
      description: 'Node added',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
    409: { content: { 'application/json': { schema: errorSchema } }, description: 'Node already in diagram' },
  },
});

const upsertNodeRoute = createRoute({
  method: 'patch',
  path: '/{did}/nodes',
  tags: ['Diagrams'],
  summary: 'Upsert node position (update x/y for an existing node by entryId)',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndDidParams,
    body: { content: { 'application/json': { schema: upsertNodeSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: nodeSchema } },
      description: 'Node position updated',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Node not found' },
  },
});

const deleteNodeRoute = createRoute({
  method: 'delete',
  path: '/{did}/nodes/{nodeId}',
  tags: ['Diagrams'],
  summary: 'Remove a node from a diagram (does NOT delete the entry)',
  security: [{ bearerAuth: [] }],
  request: { params: uidDidNodeParams },
  responses: {
    204: { description: 'Node removed' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
  },
});

const createEdgeRoute = createRoute({
  method: 'post',
  path: '/{did}/edges',
  tags: ['Diagrams'],
  summary: 'Create/upsert a styled edge in a diagram (writes through to links table)',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidAndDidParams,
    body: { content: { 'application/json': { schema: createEdgeSchema } }, required: true },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: edgeSchema } },
      description: 'Edge created or updated',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Not found' },
  },
});

const deleteEdgeRoute = createRoute({
  method: 'delete',
  path: '/{did}/edges/{edgeId}',
  tags: ['Diagrams'],
  summary: 'Delete a diagram edge (deletes the underlying links row)',
  security: [{ bearerAuth: [] }],
  request: { params: uidDidEdgeParams },
  responses: {
    204: { description: 'Edge deleted' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Edge not found' },
  },
});

// ─── PATCH edge schema + route (DIAGRAM-02 / T-31-17/18) ─────────────────────

const updateEdgeSchema = z.object({
  label: z.string().max(100).optional(),
  lineStyle: z.enum(LINE_STYLES).optional(),
  color: z.string().max(50).optional(),
});

const updateEdgeRoute = createRoute({
  method: 'patch',
  path: '/{did}/edges/{edgeId}',
  tags: ['Diagrams'],
  summary: 'Update a diagram edge label, lineStyle, and/or color (universe-scoped)',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidDidEdgeParams,
    body: { content: { 'application/json': { schema: updateEdgeSchema } }, required: true },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: edgeSchema } },
      description: 'Edge updated',
    },
    400: { content: { 'application/json': { schema: errorSchema } }, description: 'Validation error' },
    401: { content: { 'application/json': { schema: errorSchema } }, description: 'Unauthorized' },
    403: { content: { 'application/json': { schema: errorSchema } }, description: 'Forbidden' },
    404: { content: { 'application/json': { schema: errorSchema } }, description: 'Edge not found' },
  },
});

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Fetch diagram, verify it belongs to the universe.
 * Returns 404 if not found.
 */
async function requireDiagram(diagramId: string, universeId: string) {
  const rows = await db()
    .select()
    .from(diagrams)
    .where(and(eq(diagrams.id, diagramId), eq(diagrams.universeId, universeId)));
  if (rows.length === 0) {
    throw new HTTPException(404, { message: 'Diagram not found' });
  }
  return rows[0];
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const diagramsRouter = new OpenAPIHono<AppEnv>()

  // GET /universes/:uid/diagrams — list diagrams
  .openapi(listDiagramsRoute, async (c) => {
    const { uid } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);

    const rows = await db()
      .select()
      .from(diagrams)
      .where(eq(diagrams.universeId, uid));

    return c.json(rows as any, 200);
  })

  // POST /universes/:uid/diagrams — create diagram
  .openapi(createDiagramRoute, async (c) => {
    const { uid } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    const data = c.req.valid('json');

    const [row] = await db()
      .insert(diagrams)
      .values({ universeId: uid, name: data.name, description: data.description ?? null })
      .returning();

    return c.json(row as any, 201);
  })

  // GET /universes/:uid/diagrams/:did — diagram detail with nodes + edges
  .openapi(getDiagramRoute, async (c) => {
    const { uid, did } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    const diagram = await requireDiagram(did, uid);

    const [nodeRows, edgeRows] = await Promise.all([
      db().select().from(diagramNodes).where(eq(diagramNodes.diagramId, did)),
      db().select().from(links).where(
        and(eq(links.universeId, uid), eq(links.diagramId, did))
      ),
    ]);

    return c.json({ ...diagram, nodes: nodeRows, edges: edgeRows } as any, 200);
  })

  // DELETE /universes/:uid/diagrams/:did — delete diagram (cascades to nodes; links get diagramId=null via FK set-null)
  .openapi(deleteDiagramRoute, async (c) => {
    const { uid, did } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireDiagram(did, uid);

    await db().delete(diagrams).where(and(eq(diagrams.id, did), eq(diagrams.universeId, uid)));
    return c.body(null, 204);
  })

  // POST /universes/:uid/diagrams/:did/nodes — add node
  .openapi(addNodeRoute, async (c) => {
    const { uid, did } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireDiagram(did, uid);
    const data = c.req.valid('json');

    // Verify the entry belongs to this universe (T-31-02)
    const entryRows = await db()
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.id, data.entryId), eq(entries.universeId, uid)));
    if (entryRows.length === 0) {
      return c.json({ error: 'Entry not found in this universe' }, 404);
    }

    // Check for duplicate (diagramId, entryId) — return 409
    const existing = await db()
      .select({ id: diagramNodes.id })
      .from(diagramNodes)
      .where(and(eq(diagramNodes.diagramId, did), eq(diagramNodes.entryId, data.entryId)));
    if (existing.length > 0) {
      return c.json({ error: 'Entry is already a node in this diagram' }, 409);
    }

    const [row] = await db()
      .insert(diagramNodes)
      .values({ diagramId: did, entryId: data.entryId, x: data.x, y: data.y })
      .returning();

    return c.json(row as any, 201);
  })

  // PATCH /universes/:uid/diagrams/:did/nodes — upsert node position (update x/y for existing node)
  .openapi(upsertNodeRoute, async (c) => {
    const { uid, did } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireDiagram(did, uid);
    const data = c.req.valid('json');

    const nodeRows = await db()
      .select()
      .from(diagramNodes)
      .where(and(eq(diagramNodes.diagramId, did), eq(diagramNodes.entryId, data.entryId)));

    if (nodeRows.length === 0) {
      return c.json({ error: 'Node not found in this diagram' }, 404);
    }

    const [updated] = await db()
      .update(diagramNodes)
      .set({ x: data.x, y: data.y })
      .where(and(eq(diagramNodes.diagramId, did), eq(diagramNodes.entryId, data.entryId)))
      .returning();

    return c.json(updated as any, 200);
  })

  // DELETE /universes/:uid/diagrams/:did/nodes/:nodeId — remove node (does NOT delete entry)
  .openapi(deleteNodeRoute, async (c) => {
    const { uid, did, nodeId } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireDiagram(did, uid);

    const deleted = await db()
      .delete(diagramNodes)
      .where(and(eq(diagramNodes.id, nodeId), eq(diagramNodes.diagramId, did)))
      .returning();

    if (deleted.length === 0) {
      return c.json({ error: 'Node not found' }, 404);
    }

    return c.body(null, 204);
  })

  // POST /universes/:uid/diagrams/:did/edges — create/upsert edge (write-through to links)
  .openapi(createEdgeRoute, async (c) => {
    const { uid, did } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireDiagram(did, uid);
    const data = c.req.valid('json');

    if (data.sourceEntryId === data.targetEntryId) {
      return c.json({ error: 'Cannot link an entry to itself' }, 400);
    }

    // Verify both entries belong to this universe (T-31-02)
    const [srcRows, tgtRows] = await Promise.all([
      db()
        .select({ id: entries.id })
        .from(entries)
        .where(and(eq(entries.id, data.sourceEntryId), eq(entries.universeId, uid))),
      db()
        .select({ id: entries.id })
        .from(entries)
        .where(and(eq(entries.id, data.targetEntryId), eq(entries.universeId, uid))),
    ]);
    if (srcRows.length === 0 || tgtRows.length === 0) {
      return c.json({ error: 'Source or target entry not found in this universe' }, 400);
    }

    // Normalize once: the schema accepts an omitted label and an explicit null
    // (the editor sends null for an unlabeled edge), and the column is nullable.
    // Collapsing both to null here keeps the lookup and the insert below reading
    // one value instead of each re-deriving it.
    const edgeLabel = data.label ?? null;

    // Upsert: if a link with this (universeId, sourceEntryId, targetEntryId, label) already
    // exists, update its diagramId/lineStyle/color rather than creating a duplicate.
    // This reconciles the links_unique_idx and prevents a 500 on duplicate (T-31-02).
    //
    // Note: the links table does NOT have a unique constraint on (sourceEntryId, targetEntryId, label)
    // in the Drizzle schema — it was removed in an earlier phase. We do a lookup-then-insert/update.
    const existingLinks = await db()
      .select()
      .from(links)
      .where(
        and(
          eq(links.universeId, uid),
          eq(links.sourceEntryId, data.sourceEntryId),
          eq(links.targetEntryId, data.targetEntryId),
          // An absent label is NULL in this column, and SQL `= NULL` is never
          // true — so matching it needs IS NULL, or the dedupe above silently
          // never finds an existing unlabeled edge and inserts a duplicate.
          edgeLabel === null ? isNull(links.label) : eq(links.label, edgeLabel),
        )
      );

    let row;
    if (existingLinks.length > 0) {
      // Update the existing link with diagram metadata
      const [updated] = await db()
        .update(links)
        .set({
          diagramId: did,
          lineStyle: data.lineStyle,
          color: data.color ?? null,
        })
        .where(eq(links.id, existingLinks[0].id))
        .returning();
      row = updated;
    } else {
      // Create new link with diagram metadata.
      // Phase 35 REL-01 DIAGRAM-02: map the diagram-edge bidirectional toggle
      // to links.direction at the write-through boundary. Diagram edges are
      // untyped (linkType: null). Plan 04 derives the editor toggle from
      // `direction === 'undirected'` on read.
      const [created] = await db()
        .insert(links)
        .values({
          universeId: uid,
          sourceEntryId: data.sourceEntryId,
          targetEntryId: data.targetEntryId,
          label: edgeLabel,
          linkType: null,
          direction: data.bidirectional ? 'undirected' : 'directed',
          diagramId: did,
          lineStyle: data.lineStyle,
          color: data.color ?? null,
        })
        .returning();
      row = created;
    }

    return c.json(row as any, 201);
  })

  // DELETE /universes/:uid/diagrams/:did/edges/:edgeId — delete edge (deletes the links row)
  .openapi(deleteEdgeRoute, async (c) => {
    const { uid, did, edgeId } = c.req.valid('param');
    await requireUniverse(uid, c.var.userId);
    await requireDiagram(did, uid);

    const deleted = await db()
      .delete(links)
      .where(and(eq(links.id, edgeId), eq(links.universeId, uid), eq(links.diagramId, did)))
      .returning();

    if (deleted.length === 0) {
      return c.json({ error: 'Edge not found' }, 404);
    }

    return c.body(null, 204);
  })

  // PATCH /universes/:uid/diagrams/:did/edges/:edgeId — update edge label/lineStyle/color
  // T-31-17: requireUniverse blocks cross-tenant access. Then we assert the edge belongs to
  //          this diagram+universe before updating (cross-universe write guard).
  // T-31-18: lineStyle validated by zod enum (solid|dashed|dotted); color by z.string().max(50).
  .openapi(updateEdgeRoute, async (c) => {
    const { uid, did, edgeId } = c.req.valid('param');
    // Step 1: requireAuth (applied by apiR.use) + requireUniverse (T-31-17)
    await requireUniverse(uid, c.var.userId);
    // Step 2: verify the diagram belongs to this universe
    await requireDiagram(did, uid);

    const data = c.req.valid('json');

    // Step 3: assert the edge (links row) belongs to this diagramId AND universe
    // — prevents cross-universe writes if an attacker supplies a valid uid/did pair
    // that doesn't contain the target edgeId (T-31-17).
    const existing = await db()
      .select()
      .from(links)
      .where(and(eq(links.id, edgeId), eq(links.universeId, uid), eq(links.diagramId, did)));

    if (existing.length === 0) {
      return c.json({ error: 'Edge not found' }, 404);
    }

    // Step 4: Build the update set — only mutate label/lineStyle/color. Never touch
    // sourceEntryId/targetEntryId/universeId/diagramId (those are immutable on update).
    const updateSet: Record<string, unknown> = {};
    if (data.label !== undefined) updateSet.label = data.label;
    if (data.lineStyle !== undefined) updateSet.lineStyle = data.lineStyle;
    if (data.color !== undefined) updateSet.color = data.color;

    const [updated] = await db()
      .update(links)
      .set(updateSet)
      .where(eq(links.id, edgeId))
      .returning();

    return c.json(updated as any, 200);
  });

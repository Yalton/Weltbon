/**
 * api/src/services/ingest-commit.ts
 *
 * Phase 12-01 — atomic commit service for the markdown ingestion review flow.
 *
 * Takes a reviewed `IngestPreview` body (with per-entry decisions and edits) and
 * inserts the entire accepted batch (new categories + entries + resolved links)
 * inside ONE Postgres transaction. All-or-nothing per ING-05 / D-24.
 *
 * Decisions implemented:
 *   D-23   Per-entry conflict semantics: skip / rename (no overwrite)
 *   D-24   Chunked INSERTs inside ONE db().transaction(); insert order
 *          new categories → entries → links
 *   D-25   Endpoint shape POST /universes/:uid/ingest/commit returns
 *          { entryIds, linksCreated, categoriesCreated }
 *   D-26   Server-side validation that entry.entryType ∈ universe.entryTypes
 *   D-29   Server rejects empty-accepted-batch with 400 (commit_empty)
 *
 * Threat-model anchors:
 *   T-12-01  Tampering            → Zod commitBodySchema validates every field
 *   T-12-02  DoS (huge body)      → CommitSizeError on totalRows > cap (413)
 *   T-12-03  Authorization        → requireUniverse upstream of this service
 *   T-12-04  Info disclosure      → all errors are neutral strings
 *   T-12-05  Spoofing collision   → in-batch + cross-batch case-insensitive check
 *   T-12-06  Path traversal       → path.posix.normalize re-check (T-11-05 inherited)
 *   T-12-08  entryType ∉ universe → server-side D-26 enforcement
 */

import path from 'node:path';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  universes,
  entries as entriesTable,
  links as linksTable,
  categories as categoriesTable,
} from '../db/schema.js';

// ─── Constants (D-24) ────────────────────────────────────────────────────────

/**
 * Rows per chunked INSERT statement. With ~9 columns per entry insert, 1000 rows
 * ≈ 9000 parameters per statement, well under Postgres' 65535 cap.
 */
export const CHUNK_SIZE = 1000;

/**
 * Per-table chunk-count cap. Effective per-table row cap is
 * CHUNK_SIZE * MAX_CHUNKS_PER_TABLE = 50_000. Total cap across the three tables
 * is 3x that, used by the size-cap pre-check.
 */
export const MAX_CHUNKS_PER_TABLE = 50;

// ─── Typed errors ───────────────────────────────────────────────────────────

export class TitleCollisionError extends Error {
  constructor(public readonly title: string) {
    super(`Title still collides: ${title}`);
    this.name = 'TitleCollisionError';
  }
}

export class CommitSizeError extends Error {
  constructor(
    public readonly limit: 'commit_size',
    public readonly max: number,
  ) {
    super(`Batch limit exceeded: commit_size (max ${max})`);
    this.name = 'CommitSizeError';
  }
}

// ─── Zod schemas ────────────────────────────────────────────────────────────

const linkOutSchema = z.object({
  target: z.string(),
  target_path: z.string().optional(),
  target_id: z.string().optional(),
  label: z.string(),
  resolved: z.boolean(),
  warning: z.string().optional(),
});

const commitDecisionSchema = z.discriminatedUnion('disposition', [
  z.object({ disposition: z.literal('accept') }),
  z.object({
    disposition: z.literal('rename'),
    newTitle: z.string().min(1).max(200),
  }),
  z.object({ disposition: z.literal('skip') }),
]);

const categoryRefSchema = z.union([
  z.object({ existingId: z.string().uuid() }),
  z.object({ newName: z.string().min(1).max(80) }),
  z.null(),
]);

const commitEntrySchema = z.object({
  filename: z.string(),
  path: z.string(),
  title: z.string().min(1).max(200),
  entryType: z.string().min(1).max(50),
  tags: z.array(z.string().max(50)).max(50),
  category: categoryRefSchema,
  body: z.string(),
  meta: z.record(z.string(), z.unknown()),
  linksOut: z.array(linkOutSchema),
  decision: commitDecisionSchema,
});

export const commitBodySchema = z.object({
  entries: z.array(commitEntrySchema),
});

export type CommitEntry = z.infer<typeof commitEntrySchema>;
export type CommitBody = z.infer<typeof commitBodySchema>;
export type CommitResult = {
  entryIds: string[];
  linksCreated: number;
  categoriesCreated: number;
};

// ─── Service ─────────────────────────────────────────────────────────────────

/**
 * Atomically commits a reviewed batch. The route is responsible for calling
 * `requireUniverse(uid, userId)` BEFORE invoking this service; we re-load the
 * universe row internally only to read `entryTypes` for the D-26 check.
 *
 * @param uid       Universe id (already verified to belong to userId).
 * @param _userId   Owner user id (kept in the signature for future use; unused
 *                  internally because requireUniverse is the auth gate).
 * @param rawBody   Untrusted JSON body — passed through Zod first.
 *
 * Errors:
 *   - ZodError                        → 400 at route boundary
 *   - Error('commit_empty: ...')      → 400 at route boundary
 *   - Error('Invalid path: ...')      → 400
 *   - Error('Invalid entryType: ...') → 400
 *   - Error('Invalid category id')    → 400
 *   - TitleCollisionError             → 409
 *   - CommitSizeError                 → 413
 *   - other                           → 500 (neutral)
 */
export async function commitIngest(
  uid: string,
  _userId: string,
  rawBody: unknown,
): Promise<CommitResult> {
  // 1. Zod validation. Throws ZodError → route maps to 400.
  const body = commitBodySchema.parse(rawBody);

  // 2. Filter to accepted (accept | rename) entries; skip is dropped.
  const accepted = body.entries.filter(
    (e) => e.decision.disposition === 'accept' || e.decision.disposition === 'rename',
  );

  // 3. D-29: empty-accepted-batch guard.
  if (accepted.length === 0) {
    throw new Error('commit_empty: no accepted entries');
  }

  // 4. T-11-05 / T-12-06: path-traversal re-check on every accepted entry.
  for (const e of accepted) {
    const normalized = path.posix.normalize(e.path);
    if (
      normalized.startsWith('..') ||
      normalized === '..' ||
      path.posix.isAbsolute(normalized)
    ) {
      throw new Error(`Invalid path: ${e.path}`);
    }
  }

  // 5. Load the universe row so we can validate entryType ∈ universe.entryTypes
  //    (D-26 server-side enforcement).
  const universeRow = await db().query.universes.findFirst({
    where: eq(universes.id, uid),
  });
  if (!universeRow) {
    // Defensive — should never happen because the route already called
    // requireUniverse, but if it did the universe was deleted between checks.
    throw new Error('Invalid path: universe missing');
  }
  const validTypes = new Set(universeRow.entryTypes);

  for (const e of accepted) {
    if (!validTypes.has(e.entryType)) {
      throw new Error(`Invalid entryType: ${e.entryType}`);
    }
  }

  // 6. Compute effective titles (rename overrides original title).
  const effectiveTitles = accepted.map((e) =>
    e.decision.disposition === 'rename' ? e.decision.newTitle : e.title,
  );

  // 7. Title-collision pre-checks.
  //    7a. In-batch: two accepted entries cannot share a final title (case-insensitive).
  const lowerSet = new Set<string>();
  for (const t of effectiveTitles) {
    const k = t.toLowerCase();
    if (lowerSet.has(k)) {
      throw new TitleCollisionError(t);
    }
    lowerSet.add(k);
  }
  //    7b. Cross-batch: against existing universe entries.
  const existingTitleRows = await db()
    .select({ title: entriesTable.title })
    .from(entriesTable)
    .where(eq(entriesTable.universeId, uid));
  const existingLower = new Set(existingTitleRows.map((r) => r.title.toLowerCase()));
  for (const t of effectiveTitles) {
    if (existingLower.has(t.toLowerCase())) {
      throw new TitleCollisionError(t);
    }
  }

  // 8. Compute the LOGICAL row cap. This is defense-in-depth, NOT an OOM guard:
  //    it runs after the whole body is already parsed into memory. The pre-parse
  //    raw-body OOM guard is the commit route's bodyLimit (INGEST_MAX_BODY_BYTES).
  const acceptedLinkCount = accepted.reduce(
    (sum, e) => sum + e.linksOut.filter((l) => l.resolved).length,
    0,
  );
  // newCategories count is bounded by `accepted.length`; use accepted.length as
  // a conservative upper bound for the cap pre-check.
  const totalRowsBound = accepted.length + accepted.length + acceptedLinkCount;
  const cap = CHUNK_SIZE * MAX_CHUNKS_PER_TABLE * 3;
  if (totalRowsBound > cap) {
    throw new CommitSizeError('commit_size', cap);
  }

  // 9. Begin the atomic transaction (D-24).
  return await db().transaction(async (tx) => {
    // ── Step A: load existing categories ───────────────────────────────────
    const existingCatRows = await tx
      .select({ id: categoriesTable.id, label: categoriesTable.label })
      .from(categoriesTable)
      .where(eq(categoriesTable.universeId, uid));
    const existingCategoryByLower = new Map<string, string>();
    for (const r of existingCatRows) {
      existingCategoryByLower.set(r.label.toLowerCase(), r.id);
    }

    // ── Step B: collect new categories to create (silent-merge keyed lower) ──
    type NewCatPlan = { lower: string; label: string };
    const newCatPlans: NewCatPlan[] = [];
    const newCatByLower = new Map<string, true>();
    for (const e of accepted) {
      const cat = e.category;
      if (cat === null) continue;
      if ('existingId' in cat) {
        // Defensive: ensure the existingId actually exists.
        const found = existingCatRows.find((r) => r.id === cat.existingId);
        if (!found) {
          throw new Error('Invalid category id');
        }
      } else {
        // newName branch
        const lower = cat.newName.toLowerCase();
        if (existingCategoryByLower.has(lower)) continue; // silent merge
        if (newCatByLower.has(lower)) continue;
        newCatByLower.set(lower, true);
        newCatPlans.push({ lower, label: cat.newName });
      }
    }

    // Insert new categories (single chunk; categories are low-cardinality).
    let categoriesCreated = 0;
    if (newCatPlans.length > 0) {
      const insertedCats = await tx
        .insert(categoriesTable)
        .values(
          newCatPlans.map((p) => ({
            universeId: uid,
            label: p.label,
          })),
        )
        .returning({ id: categoriesTable.id, label: categoriesTable.label });
      categoriesCreated = insertedCats.length;
      // Update the lookup map so the entry-resolution pass can find them.
      for (const ic of insertedCats) {
        existingCategoryByLower.set(ic.label.toLowerCase(), ic.id);
      }
    }

    // ── Step C: build entries to insert (with resolved categoryId) ─────────
    type EntryInsert = typeof entriesTable.$inferInsert;
    const entriesToInsert: EntryInsert[] = accepted.map((e, idx) => {
      let categoryId: string | null = null;
      const cat = e.category;
      if (cat !== null) {
        if ('existingId' in cat) {
          categoryId = cat.existingId;
        } else {
          // newName — must be in the lookup map after Step B.
          const found = existingCategoryByLower.get(cat.newName.toLowerCase());
          if (!found) {
            // Should never happen after Step B, but throw defensively.
            throw new Error('Invalid category id');
          }
          categoryId = found;
        }
      }
      return {
        universeId: uid,
        title: effectiveTitles[idx],
        entryType: e.entryType,
        body: e.body,
        tags: e.tags,
        meta: e.meta,
        categoryId,
      };
    });

    // ── Step D: chunked entry INSERT, building path → newId map ────────────
    const entryIdByPath = new Map<string, string>();
    const entryIds: string[] = [];
    for (let i = 0; i < entriesToInsert.length; i += CHUNK_SIZE) {
      const slice = entriesToInsert.slice(i, i + CHUNK_SIZE);
      const inserted = await tx
        .insert(entriesTable)
        .values(slice)
        .returning({ id: entriesTable.id });
      // Drizzle returns rows in input order; zip with the source slice to
      // rebuild the path → id map.
      for (let j = 0; j < slice.length; j++) {
        const sourceEntry = accepted[i + j];
        entryIdByPath.set(sourceEntry.path, inserted[j].id);
        entryIds.push(inserted[j].id);
      }
    }

    // ── Step E: build link rows from each accepted entry's linksOut ───────
    type LinkInsert = typeof linksTable.$inferInsert;
    const linksToInsert: LinkInsert[] = [];
    for (const e of accepted) {
      const sourceId = entryIdByPath.get(e.path);
      if (!sourceId) continue; // defensive — should always be present
      for (const l of e.linksOut) {
        if (!l.resolved) continue;
        let targetId: string | undefined;
        if (l.target_path) {
          targetId = entryIdByPath.get(l.target_path);
        } else if (l.target_id) {
          targetId = l.target_id;
        }
        if (!targetId) continue; // skipped/unresolved → silently drop
        linksToInsert.push({
          universeId: uid,
          sourceEntryId: sourceId,
          targetEntryId: targetId,
          label: l.label,
          // Phase 35 REL-01: direction is NOT NULL; ingested links are always
          // directed by default (no bidirectional concept in wikilink ingest).
          direction: 'directed' as const,
        });
      }
    }

    // ── Step F: chunked link INSERT ────────────────────────────────────────
    let linksCreated = 0;
    for (let i = 0; i < linksToInsert.length; i += CHUNK_SIZE) {
      const slice = linksToInsert.slice(i, i + CHUNK_SIZE);
      await tx.insert(linksTable).values(slice);
      linksCreated += slice.length;
    }

    return { entryIds, linksCreated, categoriesCreated };
  });
}

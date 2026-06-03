/**
 * Phase 32 CONLANG-02 — CSV import service for dictionary words.
 *
 * Exports `importDictionaryCsv(buf, { universeId, languageEntryId })`.
 *
 * Design decisions:
 * - D-09: Upsert on (universe, language, word) collision — OVERWRITES ipa/gloss/pos/etymology/tags.
 *   KEY DIVERGENCE from ingest-commit.ts: ingest-commit skips/renames on collision (D-23);
 *   dictionary import OVERWRITES (D-09).
 * - D-10: Required columns: word + gloss. Extra/reordered/missing-optional columns tolerated.
 *   tags cell is semicolon-split ("noun;archaic" → ['noun','archaic']); comma is the CSV delimiter.
 * - T-32-04: Row count cap via CHUNK_SIZE × MAX_CHUNKS_PER_TABLE (inherited from ingest-commit).
 * - Row-level errors are surfaced WITHOUT aborting valid rows (D-10).
 */

import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { db } from '../db/client.js';
import { dictionaryWords } from '../db/schema.js';
import { sql } from 'drizzle-orm';

// ─── Constants (mirrors ingest-commit.ts) ────────────────────────────────────

const CHUNK_SIZE = 1000;
const MAX_CHUNKS_PER_TABLE = 50;

// NULL sentinel UUID used by the scope-unique index:
// COALESCE(language_entry_id, '00000000-0000-0000-0000-000000000000')
const NULL_SENTINEL = '00000000-0000-0000-0000-000000000000';

// ─── Typed errors ─────────────────────────────────────────────────────────────

export class DictionaryImportSizeError extends Error {
  constructor(public readonly max: number) {
    super(`CSV import limit exceeded: max ${max} rows`);
    this.name = 'DictionaryImportSizeError';
  }
}

export interface DictionaryRowError {
  row: number;
  message: string;
}

// ─── Row schema ──────────────────────────────────────────────────────────────

const rowSchema = z.object({
  word: z.string().min(1, 'word is required'),
  gloss: z.string().min(1, 'gloss is required'),
  ipa: z.string().optional().default(''),
  partOfSpeech: z.string().optional().default(''),
  etymology: z.string().optional().default(''),
  tags: z.array(z.string()).optional().default([]),
});

type ParsedRow = z.output<typeof rowSchema>;

// ─── Import result ─────────────────────────────────────────────────────────────

export interface ImportResult {
  inserted: number;
  updated: number;
  rowErrors: DictionaryRowError[];
}

// ─── Main function ────────────────────────────────────────────────────────────

/**
 * Parse and upsert dictionary words from a CSV buffer.
 *
 * @param buf         Raw CSV bytes (UTF-8 or BOM-prefixed)
 * @param options     universeId (required), languageEntryId (null = universe-level fallback)
 * @returns           { inserted, updated, rowErrors }
 */
export async function importDictionaryCsv(
  buf: Buffer,
  { universeId, languageEntryId }: { universeId: string; languageEntryId: string | null },
): Promise<ImportResult> {
  // ── Step 1: Parse CSV ──────────────────────────────────────────────────────
  let records: Record<string, string>[];
  try {
    records = parse(buf, {
      columns: true,            // header row → object keys
      relax_column_count: true, // D-10: extra/reordered columns tolerated
      skip_empty_lines: true,
      bom: true,                // BOM-stripped (Windows Excel exports)
      trim: true,
    }) as Record<string, string>[];
  } catch (err: any) {
    throw new Error(`CSV parse error: ${err?.message ?? String(err)}`);
  }

  // ── Step 2: Validate required headers ─────────────────────────────────────
  if (records.length === 0) {
    // Empty file or header-only — nothing to import
    return { inserted: 0, updated: 0, rowErrors: [] };
  }

  const firstRow = records[0];
  const headers = Object.keys(firstRow);
  const missingHeaders: string[] = [];
  if (!headers.includes('word')) missingHeaders.push('word');
  if (!headers.includes('gloss')) missingHeaders.push('gloss');
  if (missingHeaders.length > 0) {
    throw new Error(`Missing required columns: ${missingHeaders.join(', ')}`);
  }

  // ── Step 3: Row-level validation + error collection ────────────────────────
  const validRows: ParsedRow[] = [];
  const rowErrors: DictionaryRowError[] = [];

  for (let i = 0; i < records.length; i++) {
    const raw = records[i];

    // Semicolon-split tags (D-10: comma is the field delimiter)
    const tagsCell = raw['tags'] ?? raw['tag'] ?? '';
    const tags = tagsCell
      .split(';')
      .map((t) => t.trim())
      .filter(Boolean);

    // Normalize POS aliases
    const pos = raw['partOfSpeech'] ?? raw['part_of_speech'] ?? raw['pos'] ?? '';

    const result = rowSchema.safeParse({
      word: raw['word'] ?? '',
      gloss: raw['gloss'] ?? '',
      ipa: raw['ipa'] ?? '',
      partOfSpeech: pos,
      etymology: raw['etymology'] ?? '',
      tags,
    });

    if (!result.success) {
      rowErrors.push({
        row: i + 1,
        message: result.error.issues[0]?.message ?? 'Invalid row',
      });
    } else {
      validRows.push(result.data);
    }
  }

  // ── Step 4: Row-count cap (D-09 + T-32-04) ────────────────────────────────
  const maxRows = CHUNK_SIZE * MAX_CHUNKS_PER_TABLE;
  if (validRows.length > maxRows) {
    throw new DictionaryImportSizeError(maxRows);
  }

  if (validRows.length === 0) {
    return { inserted: 0, updated: 0, rowErrors };
  }

  // ── Step 5: Chunked transaction upsert (D-09 OVERWRITE on collision) ──────
  // The scope-unique index is: dictionary_words_scope_word_unique
  //   ON (universe_id, COALESCE(language_entry_id, '00000000-...'), lower(word))
  //
  // This is a unique INDEX (not a UNIQUE CONSTRAINT), so ON CONFLICT ON CONSTRAINT
  // is not valid. We must use ON CONFLICT (expression) matching the index exactly.
  //
  // We use Drizzle's tx.execute(sql`...`) with parameterized values to run the upsert.
  // xmax = 0 distinguishes INSERT (new row) from UPDATE (existing row) in PostgreSQL.
  //
  // We process rows individually within the chunked loop to keep parameter counts low
  // and to get per-row xmax feedback.

  let inserted = 0;
  let updated = 0;

  await db().transaction(async (tx) => {
    for (let i = 0; i < validRows.length; i += CHUNK_SIZE) {
      const chunk = validRows.slice(i, i + CHUNK_SIZE);

      for (const row of chunk) {
        // Use raw SQL to target the expression-based unique index.
        // The tags array must be cast to text[] for Postgres to accept it.
        // Drizzle's sql tag parameterizes arrays correctly as Postgres arrays
        // when the value is passed directly (not nested in sql expressions).
        // We build a valid PostgreSQL ARRAY literal from the tags array.
        const tags = row.tags ?? [];
        // Build the tags array literal as a SQL expression: ARRAY[$1, $2, ...]::text[]
        // If empty, use ARRAY[]::text[].
        const tagsExpr =
          tags.length === 0
            ? sql`ARRAY[]::text[]`
            : sql`ARRAY[${sql.join(
                tags.map((t) => sql`${t}`),
                sql`, `,
              )}]::text[]`;

        // Handle nullable languageEntryId — null must be passed as SQL NULL, not '${null}::uuid'
        const langIdExpr = languageEntryId
          ? sql`${languageEntryId}::uuid`
          : sql`NULL::uuid`;

        const result = await tx.execute(
          sql`
            INSERT INTO dictionary_words (
              universe_id, language_entry_id, word, ipa, part_of_speech, gloss, etymology, tags
            ) VALUES (
              ${universeId}::uuid,
              ${langIdExpr},
              ${row.word},
              ${row.ipa ?? ''},
              ${row.partOfSpeech ?? ''},
              ${row.gloss},
              ${row.etymology ?? ''},
              ${tagsExpr}
            )
            ON CONFLICT (universe_id, COALESCE(language_entry_id, ${NULL_SENTINEL}::uuid), lower(word))
            DO UPDATE SET
              ipa         = EXCLUDED.ipa,
              gloss       = EXCLUDED.gloss,
              part_of_speech = EXCLUDED.part_of_speech,
              etymology   = EXCLUDED.etymology,
              tags        = EXCLUDED.tags,
              updated_at  = now()
            RETURNING (xmax = 0) AS is_insert
          `,
        );

        const rows = result.rows as Array<{ is_insert: boolean }>;
        for (const r of rows) {
          if (r.is_insert) {
            inserted++;
          } else {
            updated++;
          }
        }
      }
    }
  });

  return { inserted, updated, rowErrors };
}

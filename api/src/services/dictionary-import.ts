
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


// CR-03: max() guards mirror the CRUD route Zod schemas in dictionary.ts so that
// oversized values in a CSV row surface as per-row errors instead of writing
// arbitrarily-long strings to the DB. etymology uses 10000 (markdown field, no
const rowSchema = z.object({
  word:         z.string().min(1, 'word is required').max(200),
  gloss:        z.string().min(1, 'gloss is required').max(1000),
  ipa:          z.string().max(200).optional().default(''),
  partOfSpeech: z.string().max(100).optional().default(''),
  etymology:    z.string().max(10000).optional().default(''),
  tags:         z.array(z.string().max(50)).max(20).optional().default([]),
});

type ParsedRow = z.output<typeof rowSchema>;


export interface ImportResult {
  inserted: number;
  updated: number;
  rowErrors: DictionaryRowError[];
}


export async function importDictionaryCsv(
  buf: Buffer,
  { universeId, languageEntryId }: { universeId: string; languageEntryId: string | null },
): Promise<ImportResult> {
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
  // and to get per-row xmax feedback.

  let inserted = 0;
  let updated = 0;

  await db().transaction(async (tx) => {
    for (let i = 0; i < validRows.length; i += CHUNK_SIZE) {
      const chunk = validRows.slice(i, i + CHUNK_SIZE);

      for (const row of chunk) {
        // Use raw SQL to target the expression-based unique index.
        const tags = row.tags ?? [];
        const tagsExpr =
          tags.length === 0
            ? sql`ARRAY[]::text[]`
            : sql`ARRAY[${sql.join(
                tags.map((t) => sql`${t}`),
                sql`, `,
              )}]::text[]`;

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

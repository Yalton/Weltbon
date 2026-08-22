/**
 * api/src/services/ingest-markdown.ts
 *
 * Phase 11 inference helpers for Obsidian-flavored markdown ingestion.
 * NO IO — callers are responsible for reading file bytes and decoding UTF-8.
 * NO database writes — this service is purely functional (parse → preview).
 *
 * Decisions implemented:
 *   D-07 / D-07a  folder → category
 *   D-08 / D-08a  non-md skip + hidden-dir filter
 *   D-09 / D-09a  pass-through + inline #tag extraction
 *   D-10 / D-10a  title resolution + filename normalisation
 *   D-11 / D-11a  type heuristic + universe entryTypes validation
 *   D-12 / D-12a  tag merging (frontmatter UNION body), body preserved
 *   D-13 / D-13a  gray-matter; YAML dates → ISO 8601 strings
 *   D-17b          code-block exclusion via remark AST tokenizer
 *
 * Security:
 *   T-11-03  gray-matter is called with NO custom YAML schemas or engines overrides.
 *            gray-matter wraps js-yaml safeLoad which prevents !!js/function deserialization.
 *   T-11-04  Error messages from helpers use neutral language; no filesystem paths echoed.
 */

import matter from 'gray-matter';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import type { Root } from 'mdast';
import { splitMarkdownFile, type SplitLevel } from './ingest-split.js';
import { normalizeFilename } from './ingest-filename.js';

// ---------------------------------------------------------------------------
// Exported Types
// ---------------------------------------------------------------------------

/**
 * One file from the upload, post-decode. The endpoint (11-03) is responsible
 * for unpacking ZIPs, hidden-dir filtering, and decoding bytes to UTF-8 BEFORE
 * handing the array to parseBatch(). This service performs NO IO.
 */
export type FileInput = {
  /** Path RELATIVE to the upload root, forward-slash separated. e.g. "characters/heroes/aragorn.md". */
  path: string;
  /** Raw markdown text including frontmatter. UTF-8 already decoded. */
  content: string;
};

/**
 * Per-file Pass-1 output (everything except linksOut, which is filled in Pass 2 by 11-02).
 */
export type ParsedFile = {
  filename: string;       // basename of path
  path: string;           // full relative path
  title: string;
  type: string;           // always one of validTypes (post-validation), or 'concept'
  tags: string[];         // lowercased, deduped, sorted
  category: string | null;
  body: string;           // markdown minus frontmatter, body otherwise unchanged
  meta: Record<string, unknown>; // dates as ISO strings; arbitrary jsonb-safe values
};

/**
 * The preview JSON the endpoint returns. linksOut + warnings are filled by 11-02.
 * Defined here as a forward declaration so 11-02 can extend it.
 */
export type IngestPreview = {
  summary: {
    markdown_files_parsed: number;
    non_markdown_files_skipped: number;
    hidden_paths_filtered: number;
    duplicate_titles_in_batch: number;
    unresolved_wikilinks: number;
  };
  entries: Array<ParsedFile & {
    linksOut: Array<{
      target: string;
      target_path?: string;          // batch-relative path of the resolved file (D-05 first-match)
      target_id?: string;            // existing-universe entry id, if resolved that way
      label: string;                 // display text after `|`, else target
      resolved: boolean;
      warning?: string;
    }>;
    categoryIsNew?: boolean;         // true if category not already in universe (D-07a)
    titleCollision?: boolean;        // true on D-05 duplicate-title warning
  }>;
  warnings: Array<{ file: string; message: string }>;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Irregular plural-to-singular table used by D-11 step 2 folder singularization.
 * Exported for testability.
 */
export const IRREGULAR_PLURALS: Record<string, string> = {
  heroes: 'hero',
  characters: 'character',
  locations: 'location',
  events: 'event',
  items: 'item',
  factions: 'faction',
  organizations: 'organization',
  concepts: 'concept',
  // simple s-strip for common regular plurals (applied as fallback)
};

/**
 * Filename prefix → entry type table for D-11 step 3.
 * Exported for testability.
 */
export const FILENAME_PREFIX_TYPES: Record<string, string> = {
  'loc_': 'location',
  'char_': 'character',
  'evt_': 'event',
  'org_': 'organization',
  'fac_': 'faction',
  'item_': 'item',
  'con_': 'concept',
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a value that might be a Date to an ISO 8601 string.
 * Recursively walks plain objects and arrays.
 * T-11-04b: Date→ISO conversion preserves the user's date as-is.
 */
function deepConvertDates(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(deepConvertDates);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = deepConvertDates(v);
    }
    return result;
  }
  return value;
}

// ---------------------------------------------------------------------------
// parseFrontmatter — D-13 / D-13a
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from raw markdown content using gray-matter.
 *
 * Security (T-11-03): NO custom YAML schemas or `engines` options are passed to
 * gray-matter — it uses js-yaml safeLoad defaults, preventing !!js/function
 * or !!js/regexp deserialization.
 *
 * D-13a: YAML date scalars (returned as JS Date objects by gray-matter) are
 * converted to ISO 8601 strings so they are safe to store in the jsonb `meta`
 * column.
 *
 * @param content  Raw markdown text including optional frontmatter block.
 * @returns        `{ data, body }` where `data` is the frontmatter key-value
 *                 map (dates as ISO strings) and `body` is the content after
 *                 the closing `---` delimiter.
 */
export function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  // Strip BOM if present (gray-matter handles this internally but we be explicit)
  const cleaned = content.startsWith('﻿') ? content.slice(1) : content;

  try {
    // IMPORTANT: no options object passed — T-11-03 mitigation.
    const parsed = matter(cleaned);
    const data = deepConvertDates(parsed.data) as Record<string, unknown>;
    return { data, body: parsed.content };
  } catch {
    // Malformed frontmatter — return raw content with empty data (T-11-04: no path echo)
    return { data: {}, body: content };
  }
}

// ---------------------------------------------------------------------------
// normalizeFilename — D-10a
// ---------------------------------------------------------------------------

// Lives in its own dependency-free module (#37 fix-round-2) so that
// ingest-split.ts can use it without creating a cycle back into this file.
// Re-exported here because callers (including tests) import it from
// ingest-markdown.js.
export { normalizeFilename };

// ---------------------------------------------------------------------------
// inferTitle — D-10 / D-10a
// ---------------------------------------------------------------------------

/**
 * Determine the entry title from frontmatter, H1, or normalized filename.
 *
 * Resolution order (D-10):
 *   1. `data.title` — if present and non-empty after trimming.
 *   2. First `# Heading` in body — if present.
 *   3. `normalizeFilename(filename)` — D-10a fallback.
 *
 * @param data      Frontmatter data map (output of parseFrontmatter).
 * @param body      Markdown body (without frontmatter block).
 * @param filename  Basename of the file, e.g. "aragorn.md".
 */
export function inferTitle(
  data: Record<string, unknown>,
  body: string,
  filename: string,
): string {
  // Step 1: frontmatter title
  if (typeof data.title === 'string' && data.title.trim().length > 0) {
    return data.title.trim();
  }

  // Step 2: first H1 in body
  const h1Match = /^#\s+(.+?)\s*$/m.exec(body);
  if (h1Match) {
    return h1Match[1].trim();
  }

  // Step 3: normalized filename (D-10a)
  return normalizeFilename(filename);
}

// ---------------------------------------------------------------------------
// walkBodyExcludingCode — D-17b
// ---------------------------------------------------------------------------

/**
 * Walk the markdown body using the remark AST and collect text content from
 * nodes that are NOT inside `code` (fenced block) or `inlineCode` nodes.
 *
 * This is the canonical code-block-exclusion helper used by:
 *   - inferTags (this plan, D-12/D-17b)
 *   - wikilink scanner (11-02, D-17b)
 *
 * @param body     Markdown body string (without frontmatter).
 * @param visitor  Callback called with each text value from non-code nodes.
 */
export function walkBodyExcludingCode(body: string, visitor: (value: string) => void): void {
  const tree = unified().use(remarkParse).parse(body) as Root;

  // Track whether we are inside a code node to skip its children.
  // unist-util-visit does not provide a "skip subtree" on its own unless we
  // return SKIP explicitly — we use the three-argument signature.
  visit(tree, (node, _index, parent) => {
    // Skip code block nodes and their children entirely
    if (node.type === 'code') {
      return 'skip';  // unist-util-visit constant string to skip subtree
    }

    // Skip inline code nodes and their children entirely
    if (node.type === 'inlineCode') {
      return 'skip';
    }

    // Collect text content from leaf text nodes
    if (node.type === 'text' && 'value' in node && typeof (node as { value: unknown }).value === 'string') {
      visitor((node as { value: string }).value);
    }
  });
}

// ---------------------------------------------------------------------------
// inferTags — D-12 / D-12a / D-17b
// ---------------------------------------------------------------------------

/** Regex for inline #tag detection. Anchored to whitespace or start-of-string. */
const TAG_REGEX = /(?:^|\s)#([a-z0-9_-]+)/gi;

/**
 * Build the merged, deduped, lowercased, sorted tag list from frontmatter and
 * inline body tags (D-12).
 *
 * D-12a: inline `#tag` markers are extracted but LEFT IN the body text
 * (body string is NOT modified — callers can observe this via side-effect checks).
 *
 * D-17b: tag scanning uses walkBodyExcludingCode (remark AST) to skip
 * fenced code blocks and inline code spans. Do NOT apply raw regex to the
 * full body string — that would extract false positives from code.
 *
 * @param data  Frontmatter data map.
 * @param body  Markdown body (without frontmatter block).
 * @returns     Array of unique lowercase tag strings, sorted alphabetically.
 */
export function inferTags(data: Record<string, unknown>, body: string): string[] {
  const raw: string[] = [];

  // 1. Frontmatter tags — accept array or comma-separated string (Obsidian convention)
  if (Array.isArray(data.tags)) {
    for (const t of data.tags) {
      if (typeof t === 'string' && t.trim().length > 0) {
        raw.push(t.trim().toLowerCase());
      }
    }
  } else if (typeof data.tags === 'string' && data.tags.trim().length > 0) {
    for (const t of data.tags.split(',')) {
      if (t.trim().length > 0) {
        raw.push(t.trim().toLowerCase());
      }
    }
  }

  // 2. Inline #tag from body — skip code blocks/inline code (D-17b)
  walkBodyExcludingCode(body, (textValue) => {
    let match: RegExpExecArray | null;
    TAG_REGEX.lastIndex = 0;
    while ((match = TAG_REGEX.exec(textValue)) !== null) {
      raw.push(match[1].toLowerCase());
    }
  });

  // 3. Dedup (case-insensitive already lowercased), sort
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of raw) {
    if (!seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }
  result.sort();
  return result;
}

// ---------------------------------------------------------------------------
// inferType — D-11 / D-11a
// ---------------------------------------------------------------------------

/**
 * Singularize a folder-name segment using the irregular-plurals table first,
 * then attempt a simple "strip trailing s" heuristic for regular plurals.
 *
 * Returns the singularized form, or the original segment if no rule matched.
 */
function singularizeSegment(segment: string): string {
  const lower = segment.toLowerCase();
  if (IRREGULAR_PLURALS[lower]) {
    return IRREGULAR_PLURALS[lower];
  }
  // Simple regular plural: strip trailing "s" if remaining string is ≥3 chars
  if (lower.endsWith('s') && lower.length > 3) {
    return lower.slice(0, -1);
  }
  return lower;
}

/**
 * Determine the entry type from frontmatter, folder heuristic, filename prefix,
 * or fallback (D-11).
 *
 * Resolution order (D-11):
 *   1. Frontmatter `type:` — case-insensitively matched against validTypes.
 *   2. Deepest-to-shallowest folder segment singularized — first match in validTypes wins.
 *      NOTE: "heroes" singularizes to "hero" which may NOT be in validTypes. The walk
 *      continues up the path (e.g. "characters" → "character") until a match is found.
 *      This parent-folder fallback is intentional to handle irregular plurals that map
 *      to a type not in the universe's list.
 *   3. Filename prefix from FILENAME_PREFIX_TYPES — only when prefix maps to a valid type.
 *   4. 'concept' if in validTypes, else validTypes[0] (defensive).
 *
 * @param data        Frontmatter data map.
 * @param path        File path relative to upload root, e.g. "characters/heroes/aragorn.md".
 * @param validTypes  Universe's entry type list (case-sensitive strings, typically lowercase).
 */
export function inferType(
  data: Record<string, unknown>,
  path: string,
  validTypes: string[],
): string {
  const fallback = validTypes.includes('concept') ? 'concept' : (validTypes[0] ?? 'concept');

  if (validTypes.length === 0) return 'concept';

  // Step 1: frontmatter type
  if (typeof data.type === 'string' && data.type.trim().length > 0) {
    const lower = data.type.trim().toLowerCase();
    const match = validTypes.find(t => t.toLowerCase() === lower);
    if (match) return match;
    // Falls through to steps 2-4 when not in validTypes
  }

  // Step 2: folder segments — deepest to shallowest, excluding the filename
  const segments = path.split('/');
  const folders = segments.slice(0, -1); // drop the filename

  for (let i = folders.length - 1; i >= 0; i--) {
    const singular = singularizeSegment(folders[i]);
    const match = validTypes.find(t => t.toLowerCase() === singular.toLowerCase());
    if (match) return match;
  }

  // Step 3: filename prefix table
  const basename = segments[segments.length - 1].toLowerCase();
  for (const [prefix, type] of Object.entries(FILENAME_PREFIX_TYPES)) {
    if (basename.startsWith(prefix)) {
      const match = validTypes.find(t => t.toLowerCase() === type.toLowerCase());
      if (match) return match;
    }
  }

  // Step 4: fallback
  return fallback;
}

// ---------------------------------------------------------------------------
// inferCategory — D-07
// ---------------------------------------------------------------------------

/**
 * Determine the category from the file path (D-07).
 *
 * Returns the deepest folder name relative to the upload root, or null if the
 * file is at the root level (no parent folder). Case is preserved — Weltbon's
 * category model stores user-entered case.
 *
 * @param path  File path relative to upload root, e.g. "characters/heroes/aragorn.md".
 */
export function inferCategory(path: string): string | null {
  if (!path) return null;
  const segments = path.split('/');
  const folders = segments.slice(0, -1); // drop the filename
  if (folders.length === 0) return null;
  const deepest = folders[folders.length - 1].trim();
  if (deepest.length === 0) return null;
  return deepest;
}

// ---------------------------------------------------------------------------
// isMarkdownFile / isHiddenPath — D-08 / D-08a
// ---------------------------------------------------------------------------

/**
 * Returns true if the filename has a `.md` extension (case-insensitive) (D-08).
 *
 * @param filename  Any filename or path string.
 */
export function isMarkdownFile(filename: string): boolean {
  return filename.toLowerCase().endsWith('.md');
}

/**
 * Returns true if any path segment starts with `.` (D-08a).
 *
 * This covers .obsidian/, .trash/, .git/ and any other hidden directories
 * in the Obsidian vault structure.
 *
 * @param path  File path (relative or absolute), forward-slash separated.
 */
export function isHiddenPath(path: string): boolean {
  return path.split('/').some(seg => seg.startsWith('.'));
}

// ---------------------------------------------------------------------------
// Wikilink types + scanWikilinks — D-17 / D-17b
// ---------------------------------------------------------------------------

/**
 * A single wikilink occurrence extracted during Pass 2.
 *
 * `target`  — Resolution target after stripping `|alias`, `#heading`, `.md`.
 * `label`   — Display text (right side of `|`, else `target`).
 * `raw`     — Original `[[...]]` text as found in the body.
 */
export type Wikilink = {
  target: string;
  label: string;
  raw: string;
};

/**
 * Extract every wikilink from a markdown body, skipping fenced code blocks
 * and inline code spans (D-17b).
 *
 * Implementation:
 *   1. Walk body via `walkBodyExcludingCode` — only text nodes outside code
 *      are visited. This is the SAME helper used by inferTags, so code-block
 *      exclusion is guaranteed consistent.
 *   2. Per text chunk, apply regex `/\[\[([^\]\n]+?)\]\]/g`.
 *      The negated char class `[^\]\n]+?` is bounded by both `\]` (closing
 *      bracket) and `\n` (newline), so no multi-line greedy match is possible
 *      and the pattern cannot backtrack catastrophically (T-11-02b).
 *   3. For each match, parse the inner text:
 *      a. Split on first `|`  → left = ref, right = explicit label.
 *      b. On ref, split on first `#` → keep left side (strip heading anchor).
 *      c. Strip case-insensitive trailing `.md` from ref (D-04).
 *      d. Trim ref. If empty after trimming, skip (malformed `[[]]`).
 *      e. label = explicit right side if present, else ref (post-strip).
 *
 * Security:
 *   T-11-02a / T-11-02b: regex pattern is non-backtracking; body size is
 *   bounded upstream by the 1 MB per-file cap from D-15 (endpoint's job).
 *
 * @param body  Markdown body string (without frontmatter block).
 */
export function scanWikilinks(body: string): Wikilink[] {
  // Regex: non-greedy, no-newline, bounded by ] — safe from backtracking (T-11-02b)
  const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;
  const results: Wikilink[] = [];

  walkBodyExcludingCode(body, (textValue) => {
    let match: RegExpExecArray | null;
    WIKILINK_RE.lastIndex = 0;
    while ((match = WIKILINK_RE.exec(textValue)) !== null) {
      const raw = match[0];
      const inner = match[1];

      // a. Split on first `|` for alias
      const pipeIdx = inner.indexOf('|');
      let ref: string;
      let label: string | undefined;
      if (pipeIdx !== -1) {
        ref = inner.slice(0, pipeIdx);
        label = inner.slice(pipeIdx + 1);
      } else {
        ref = inner;
        label = undefined;
      }

      // b. Strip heading anchor: split on first `#`
      const hashIdx = ref.indexOf('#');
      if (hashIdx !== -1) {
        ref = ref.slice(0, hashIdx);
      }

      // c. Strip trailing `.md` (case-insensitive) (D-04)
      ref = ref.replace(/\.md$/i, '');

      // d. Trim ref; skip empty/malformed
      ref = ref.trim();
      if (ref.length === 0) continue;

      // e. Default label = ref (post-strip) if no explicit alias
      const finalLabel = label !== undefined ? label : ref;

      results.push({ target: ref, label: finalLabel, raw });
    }
  });

  return results;
}

// ---------------------------------------------------------------------------
// ParseBatchContext + parseBatch — D-17a two-pass orchestrator
// ---------------------------------------------------------------------------

/**
 * Caller-supplied context. The endpoint (11-03) is responsible for the DB reads
 * before calling parseBatch — this service performs NO IO.
 */
export type ParseBatchContext = {
  /** Universe id; echoed into preview metadata only. */
  universeId: string;
  /** The universe's valid entry types (case-preserved). */
  validTypes: string[];
  /**
   * Existing entries in the target universe. Used for cross-batch wikilink
   * resolution: a `[[Target]]` that doesn't match a same-batch title falls
   * through to this list (case-insensitive title match). (D-06)
   */
  existingEntries: Array<{ id: string; title: string }>;
  /**
   * Existing category names in the target universe. Used to flag new
   * categories on parsed entries (D-07a). Case-sensitive comparison.
   */
  existingCategories: string[];
  /**
   * Issue #37. When set, and when exactly one markdown file survives
   * pre-filtering, that file is replaced by one virtual file per section
   * before Pass 1. Everything downstream — titles, collisions, wikilinks,
   * categories — then treats the sections as ordinary batch files, which is
   * why splitting needs no changes below this point.
   */
  splitLevel?: SplitLevel | null;
};

/**
 * Omit keys from an object by returning a shallow copy without them.
 * Used to strip recognized frontmatter fields from `meta`.
 */
function omitKeys(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const keySet = new Set(keys);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!keySet.has(k)) result[k] = v;
  }
  return result;
}

/**
 * Two-pass batch orchestrator (D-17a). Pure function; no side effects; no IO.
 *
 * Pass 1 — Per-file inference:
 *   For each .md file (hidden paths and non-md silently partitioned out), run all
 *   inference helpers and build `titleMap: Map<lowercased_title, ParsedRecord>`.
 *   Duplicate titles (D-05): first-encountered wins; collisions are tracked in a Set.
 *
 * Pass 2 — Wikilink resolution:
 *   For each parsed file, call `scanWikilinks(body)` then resolve each link:
 *     1. Batch-level lookup (titleMap) — case-insensitive → target_path.
 *     2. Existing-universe lookup (ctx.existingEntries) — case-insensitive → target_id.
 *     3. Unresolved → resolved=false + warning text (D-06).
 *
 * Output is sorted by `path` for determinism (T-11-02d).
 *
 * Security (T-11-04): warning messages use file path as provided by the caller
 * (relative, never an absolute server path); no FS operations occur here.
 *
 * @param files  Array of decoded file inputs.
 * @param ctx    Caller-supplied context (universe id, valid types, existing entries/categories).
 */
export function parseBatch(files: FileInput[], ctx: ParseBatchContext): IngestPreview {
  // -------------------------------------------------------------------------
  // Step A — Pre-filter
  // -------------------------------------------------------------------------
  let hiddenCount = 0;
  let nonMdCount = 0;
  const mdFiles: FileInput[] = [];

  for (const file of files) {
    if (isHiddenPath(file.path)) {
      hiddenCount++;
      continue;
    }
    if (!isMarkdownFile(file.path)) {
      nonMdCount++;
      continue;
    }
    mdFiles.push(file);
  }

  // -------------------------------------------------------------------------
  // Step A2 — Split pre-pass (#37 SP-01/SP-02)
  //
  // Only a single-document batch is eligible: the upload's shape decides, so a
  // fifty-file vault import is never shredded. `splitMarkdownFile` returns the
  // file unchanged when the level yields nothing to split, so no guard beyond
  // the count is needed.
  // -------------------------------------------------------------------------
  let effectiveFiles = mdFiles;
  if (ctx.splitLevel != null && mdFiles.length === 1) {
    effectiveFiles = splitMarkdownFile(mdFiles[0], ctx.splitLevel);
  }

  // -------------------------------------------------------------------------
  // Step B — Pass 1 (per-file inference + title map)
  // -------------------------------------------------------------------------
  type ParsedRecord = {
    file: FileInput;
    filename: string;
    title: string;
    type: string;
    tags: string[];
    category: string | null;
    body: string;
    meta: Record<string, unknown>;
  };

  const parsedRecords: ParsedRecord[] = [];
  // titleMap: lowercased_title → first-encountered ParsedRecord (D-05)
  const titleMap = new Map<string, ParsedRecord>();
  // collision titles: titles that appeared more than once
  const collisionTitles = new Set<string>();

  for (const file of effectiveFiles) {
    const content = typeof file.content === 'string' ? file.content : String(file.content);
    const { data, body } = parseFrontmatter(content);
    const filename = file.path.split('/').pop()!;
    const title = inferTitle(data, body, filename);
    const type = inferType(data, file.path, ctx.validTypes);
    const tags = inferTags(data, body);
    const category = inferCategory(file.path);
    const meta = omitKeys(data, ['title', 'type', 'tags']);

    const record: ParsedRecord = { file, filename, title, type, tags, category, body, meta };
    parsedRecords.push(record);

    const key = title.toLowerCase();
    if (titleMap.has(key)) {
      // D-05: collision — mark the title; first-encountered stays in map
      collisionTitles.add(key);
    } else {
      titleMap.set(key, record);
    }
  }

  // -------------------------------------------------------------------------
  // Step C — Pass 2 (wikilink resolution per file)
  // -------------------------------------------------------------------------
  // Build existing-universe lookup (case-insensitive)
  const existingByTitle = new Map<string, { id: string; title: string }>();
  for (const entry of ctx.existingEntries) {
    existingByTitle.set(entry.title.toLowerCase(), entry);
  }

  type EntryWithLinks = ParsedFile & {
    linksOut: Array<{
      target: string;
      target_path?: string;
      target_id?: string;
      label: string;
      resolved: boolean;
      warning?: string;
    }>;
    categoryIsNew?: boolean;
    titleCollision?: boolean;
  };

  let unresolvedCount = 0;
  const entries: EntryWithLinks[] = [];

  for (const rec of parsedRecords) {
    const links = scanWikilinks(rec.body);

    const linksOut = links.map(link => {
      const key = link.target.toLowerCase();

      // 1. Same-batch resolution (D-01)
      const batchHit = titleMap.get(key);
      if (batchHit) {
        return {
          target: link.target,
          target_path: batchHit.file.path,
          label: link.label,
          resolved: true as const,
        };
      }

      // 2. Existing-universe resolution (D-06)
      const existingHit = existingByTitle.get(key);
      if (existingHit) {
        return {
          target: link.target,
          target_id: existingHit.id,
          label: link.label,
          resolved: true as const,
        };
      }

      // 3. Unresolved (D-06)
      unresolvedCount++;
      return {
        target: link.target,
        label: link.label,
        resolved: false as const,
        warning: `Target '${link.target}' not found in batch or existing universe`,
      };
    });

    // D-07a: category-is-new flag
    const categoryIsNew =
      rec.category != null && !ctx.existingCategories.includes(rec.category);

    // D-05: title collision flag
    const titleCollision = collisionTitles.has(rec.title.toLowerCase());

    entries.push({
      filename: rec.filename,
      path: rec.file.path,
      title: rec.title,
      type: rec.type,
      tags: rec.tags,
      category: rec.category,
      body: rec.body,
      meta: rec.meta,
      linksOut,
      categoryIsNew,
      titleCollision,
    });
  }

  // -------------------------------------------------------------------------
  // Step D — Warnings + summary
  // -------------------------------------------------------------------------
  const warnings: Array<{ file: string; message: string }> = [];

  // D-05: one warning per file in each collision class
  for (const collisionKey of collisionTitles) {
    // Gather all records with this (lowercased) title
    const collided = parsedRecords.filter(
      r => r.title.toLowerCase() === collisionKey
    );
    // The canonical title from the first-encountered (titleMap winner)
    const canonicalTitle = titleMap.get(collisionKey)?.title ?? collisionKey;
    for (const rec of collided) {
      warnings.push({
        file: rec.filename,
        message: `Duplicate title '${canonicalTitle}' — multiple files share this title; first match used.`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step E — Sort entries by path for determinism (T-11-02d)
  // -------------------------------------------------------------------------
  entries.sort((a, b) => a.path.localeCompare(b.path));

  // -------------------------------------------------------------------------
  // Step F — Return
  // -------------------------------------------------------------------------
  return {
    summary: {
      markdown_files_parsed: effectiveFiles.length,
      non_markdown_files_skipped: nonMdCount,
      hidden_paths_filtered: hiddenCount,
      duplicate_titles_in_batch: collisionTitles.size,
      unresolved_wikilinks: unresolvedCount,
    },
    entries,
    warnings,
  };
}

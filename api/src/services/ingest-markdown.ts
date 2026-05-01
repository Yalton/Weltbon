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

/**
 * Normalize a filename for use as a title fallback (D-10 step 3).
 *
 * Rules (D-10a):
 *   1. Strip `.md` extension (case-insensitive).
 *   2. Replace runs of `_` and `-` with a single space.
 *   3. Trim leading/trailing whitespace.
 *   4. Capitalize the first character only; middle words preserve their
 *      original case to avoid mangling acronyms.
 *
 * @param filename  Bare filename (basename), e.g. "my-cool-entry.md".
 * @returns         Human-readable title, e.g. "My cool entry".
 */
export function normalizeFilename(filename: string): string {
  const base = filename.replace(/\.md$/i, '');
  const s = base.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

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

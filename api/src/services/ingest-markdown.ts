
import matter from 'gray-matter';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import type { Root } from 'mdast';
import { splitMarkdownFile, type SplitLevel } from './ingest-split.js';
import { normalizeFilename } from './ingest-filename.js';


export type FileInput = {
  path: string;
  content: string;
};

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


export const IRREGULAR_PLURALS: Record<string, string> = {
  heroes: 'hero',
  characters: 'character',
  locations: 'location',
  events: 'event',
  items: 'item',
  factions: 'faction',
  organizations: 'organization',
  concepts: 'concept',
};

export const FILENAME_PREFIX_TYPES: Record<string, string> = {
  'loc_': 'location',
  'char_': 'character',
  'evt_': 'event',
  'org_': 'organization',
  'fac_': 'faction',
  'item_': 'item',
  'con_': 'concept',
};


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


export function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  const cleaned = content.startsWith('﻿') ? content.slice(1) : content;

  try {
    const parsed = matter(cleaned);
    const data = deepConvertDates(parsed.data) as Record<string, unknown>;
    return { data, body: parsed.content };
  } catch {
    return { data: {}, body: content };
  }
}


export { normalizeFilename };


export function inferTitle(
  data: Record<string, unknown>,
  body: string,
  filename: string,
): string {
  if (typeof data.title === 'string' && data.title.trim().length > 0) {
    return data.title.trim();
  }

  const h1Match = /^#\s+(.+?)\s*$/m.exec(body);
  if (h1Match) {
    return h1Match[1].trim();
  }

  return normalizeFilename(filename);
}


export function walkBodyExcludingCode(body: string, visitor: (value: string) => void): void {
  const tree = unified().use(remarkParse).parse(body) as Root;

  visit(tree, (node, _index, parent) => {
    if (node.type === 'code') {
      return 'skip';  // unist-util-visit constant string to skip subtree
    }

    if (node.type === 'inlineCode') {
      return 'skip';
    }

    if (node.type === 'text' && 'value' in node && typeof (node as { value: unknown }).value === 'string') {
      visitor((node as { value: string }).value);
    }
  });
}


const TAG_REGEX = /(?:^|\s)#([a-z0-9_-]+)/gi;

export function inferTags(data: Record<string, unknown>, body: string): string[] {
  const raw: string[] = [];

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

  walkBodyExcludingCode(body, (textValue) => {
    let match: RegExpExecArray | null;
    TAG_REGEX.lastIndex = 0;
    while ((match = TAG_REGEX.exec(textValue)) !== null) {
      raw.push(match[1].toLowerCase());
    }
  });

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


function singularizeSegment(segment: string): string {
  const lower = segment.toLowerCase();
  if (IRREGULAR_PLURALS[lower]) {
    return IRREGULAR_PLURALS[lower];
  }
  if (lower.endsWith('s') && lower.length > 3) {
    return lower.slice(0, -1);
  }
  return lower;
}

export function inferType(
  data: Record<string, unknown>,
  path: string,
  validTypes: string[],
): string {
  const fallback = validTypes.includes('concept') ? 'concept' : (validTypes[0] ?? 'concept');

  if (validTypes.length === 0) return 'concept';

  if (typeof data.type === 'string' && data.type.trim().length > 0) {
    const lower = data.type.trim().toLowerCase();
    const match = validTypes.find(t => t.toLowerCase() === lower);
    if (match) return match;
  }

  const segments = path.split('/');
  const folders = segments.slice(0, -1); // drop the filename

  for (let i = folders.length - 1; i >= 0; i--) {
    const singular = singularizeSegment(folders[i]);
    const match = validTypes.find(t => t.toLowerCase() === singular.toLowerCase());
    if (match) return match;
  }

  const basename = segments[segments.length - 1].toLowerCase();
  for (const [prefix, type] of Object.entries(FILENAME_PREFIX_TYPES)) {
    if (basename.startsWith(prefix)) {
      const match = validTypes.find(t => t.toLowerCase() === type.toLowerCase());
      if (match) return match;
    }
  }

  return fallback;
}


export function inferCategory(path: string): string | null {
  if (!path) return null;
  const segments = path.split('/');
  const folders = segments.slice(0, -1); // drop the filename
  if (folders.length === 0) return null;
  const deepest = folders[folders.length - 1].trim();
  if (deepest.length === 0) return null;
  return deepest;
}


export function isMarkdownFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

export function isHiddenPath(path: string): boolean {
  return path.split('/').some(seg => seg.startsWith('.'));
}


export type Wikilink = {
  target: string;
  label: string;
  raw: string;
};

export function scanWikilinks(body: string): Wikilink[] {
  const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;
  const results: Wikilink[] = [];

  walkBodyExcludingCode(body, (textValue) => {
    let match: RegExpExecArray | null;
    WIKILINK_RE.lastIndex = 0;
    while ((match = WIKILINK_RE.exec(textValue)) !== null) {
      const raw = match[0];
      const inner = match[1];

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

      const hashIdx = ref.indexOf('#');
      if (hashIdx !== -1) {
        ref = ref.slice(0, hashIdx);
      }

      ref = ref.replace(/\.md$/i, '');

      ref = ref.trim();
      if (ref.length === 0) continue;

      const finalLabel = label !== undefined ? label : ref;

      results.push({ target: ref, label: finalLabel, raw });
    }
  });

  return results;
}


export type ParseBatchContext = {
  universeId: string;
  validTypes: string[];
  existingEntries: Array<{ id: string; title: string }>;
  existingCategories: string[];
  splitLevel?: SplitLevel | null;
};

function omitKeys(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const keySet = new Set(keys);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!keySet.has(k)) result[k] = v;
  }
  return result;
}

export function parseBatch(files: FileInput[], ctx: ParseBatchContext): IngestPreview {
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

  let effectiveFiles = mdFiles;
  if (ctx.splitLevel != null && mdFiles.length === 1) {
    effectiveFiles = splitMarkdownFile(mdFiles[0], ctx.splitLevel);
  }

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
  const titleMap = new Map<string, ParsedRecord>();
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
      collisionTitles.add(key);
    } else {
      titleMap.set(key, record);
    }
  }

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

      const batchHit = titleMap.get(key);
      if (batchHit) {
        return {
          target: link.target,
          target_path: batchHit.file.path,
          label: link.label,
          resolved: true as const,
        };
      }

      const existingHit = existingByTitle.get(key);
      if (existingHit) {
        return {
          target: link.target,
          target_id: existingHit.id,
          label: link.label,
          resolved: true as const,
        };
      }

      unresolvedCount++;
      return {
        target: link.target,
        label: link.label,
        resolved: false as const,
        warning: `Target '${link.target}' not found in batch or existing universe`,
      };
    });

    const categoryIsNew =
      rec.category != null && !ctx.existingCategories.includes(rec.category);

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

  const warnings: Array<{ file: string; message: string }> = [];

  for (const collisionKey of collisionTitles) {
    const collided = parsedRecords.filter(
      r => r.title.toLowerCase() === collisionKey
    );
    const canonicalTitle = titleMap.get(collisionKey)?.title ?? collisionKey;
    for (const rec of collided) {
      warnings.push({
        file: rec.filename,
        message: `Duplicate title '${canonicalTitle}' — multiple files share this title; first match used.`,
      });
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));

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

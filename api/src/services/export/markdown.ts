import archiver from 'archiver';
import { Readable } from 'node:stream';
import yaml from 'yaml';
import { asciiSlug } from './slug.js';
import type {
  ExportPayload,
  ExportPayloadEntry,
  ExportPayloadIssue,
} from './payload.js';

/**
 * Markdown ZIP exporter (EXP-02 + EXP-05 ZIP streaming).
 *
 * Produces a ZIP whose root is `{universe-slug}/`, containing:
 *   - `_index.md` — TOC with H1, counts paragraph, per-category sections
 *     (in user sortOrder), and Uncategorized last.
 *   - `{Category Folder}/{entry-slug}.md` per entry — YAML frontmatter,
 *     H1 title, summary blockquote (if any), body, then ## Links,
 *     ## Backlinks, ## Open Issues sections (each omitted when empty).
 *
 * Streaming: archiver is a Node Readable; we bridge to a web
 * ReadableStream<Uint8Array> via Readable.toWeb() so Hono's `c.body()`
 * can flush bytes to the client without ever buffering the whole ZIP.
 *
 * Slug source-of-truth: `payload.entrySlugMap` is the ONLY place the
 * exporter looks up filenames — that's how the link writer and the file
 * writer agree (RESEARCH Pitfall 7). Outbound link rendering AND backlink
 * rendering both use the same map.
 *
 * Bidirectional link convention: a single bidirectional link record
 * shows up as an outbound link on BOTH endpoints. Backlinks NEVER
 * duplicate a bidirectional link — readers see "the link goes both ways"
 * by virtue of seeing the same target listed under outbound on each side,
 * not by seeing it as a backlink to itself.
 *
 * Resolved issues are absent: we read from `payload.openIssues`, which
 * the loader has already filtered to `resolved=false`.
 */
export function buildMarkdownZip(payload: ExportPayload): ReadableStream<Uint8Array> {
  const archive = archiver('zip', { zlib: { level: 6 } });

  // Critical: attach error listener BEFORE finalize so an internal archiver
  // failure surfaces as a stream error rather than an unhandled emit (see
  // RESEARCH Pitfall 2). Readable.toWeb() propagates this to the web stream.
  archive.on('error', (err) => {
    archive.destroy(err);
  });

  const universeFolder = sanitizeFolderName(asciiSlug(payload.universe.name) || 'universe');
  const slugMap = payload.entrySlugMap;
  const categoryById = new Map(payload.categories.map((c) => [c.id, c] as const));
  const entryById = new Map(payload.entries.map((e) => [e.id, e] as const));

  const folderForCategoryId = (catId: string | null): string => {
    if (!catId) return 'Uncategorized';
    const cat = categoryById.get(catId);
    return cat ? sanitizeFolderName(cat.label) : 'Uncategorized';
  };

  // Outbound index: source -> [{ relation, otherEntryId }]
  // Bidirectional links contribute to BOTH endpoints' outbound lists.
  const outboundBySource = new Map<
    string,
    Array<{ relation: string; otherEntryId: string }>
  >();
  for (const l of payload.links) {
    push(outboundBySource, l.sourceEntryId, {
      relation: l.label,
      otherEntryId: l.targetEntryId,
    });
    if (l.bidirectional) {
      push(outboundBySource, l.targetEntryId, {
        relation: l.label,
        otherEntryId: l.sourceEntryId,
      });
    }
  }

  // Backlinks index: target -> [sourceId]. Bidirectional links are NOT
  // mirrored here — they already show up on both sides as outbound, and
  // doubling them as backlinks would clutter the file with redundant info.
  const backlinksByTarget = new Map<string, string[]>();
  for (const l of payload.links) {
    if (l.bidirectional) continue;
    push(backlinksByTarget, l.targetEntryId, l.sourceEntryId);
  }

  // Open issues index: entry -> [issue]. We iterate over openIssues only,
  // so resolved ones can never leak in.
  const openIssuesByEntry = new Map<string, ExportPayloadIssue[]>();
  for (const issue of payload.openIssues) {
    for (const eid of issue.entryIds) {
      push(openIssuesByEntry, eid, issue);
    }
  }

  // 1. _index.md
  archive.append(
    buildIndexMd(payload, slugMap, folderForCategoryId),
    { name: `${universeFolder}/_index.md` },
  );

  // 2. one .md per entry
  for (const entry of payload.entries) {
    const folder = folderForCategoryId(entry.categoryId);
    const slug = slugMap.get(entry.id) ?? asciiSlug(entry.title);
    const md = buildEntryMd(entry, {
      slugMap,
      folderForCategoryId,
      entryById,
      outboundBySource,
      backlinksByTarget,
      openIssuesByEntry,
      thisFolder: folder,
    });
    archive.append(md, { name: `${universeFolder}/${folder}/${slug}.md` });
  }

  archive.finalize();

  return Readable.toWeb(archive) as unknown as ReadableStream<Uint8Array>;
}

// ---------- helpers ----------

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/**
 * Filesystem-safe folder name: replace path separators with `-`, trim,
 * fall back to "Uncategorized" if empty after sanitization. Used for
 * BOTH the on-disk folder name AND the relative-link path so links
 * always resolve back to the right file.
 */
function sanitizeFolderName(label: string): string {
  const cleaned = label.replace(/[\/\\]/g, '-').trim();
  return cleaned || 'Uncategorized';
}

function todayYYYYMMDD(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Build the relative link from one entry's .md file to another's.
 * Same folder → `./other-slug.md`; different folder → `../OtherFolder/other-slug.md`.
 * (The ZIP root is `{universe-slug}/`; entries live two levels deep at
 * `{universe-slug}/{folder}/{slug}.md`, so cross-folder hops are always
 * one `..` then into the target folder.)
 */
function relPathToEntry(thisFolder: string, otherFolder: string, otherSlug: string): string {
  if (thisFolder === otherFolder) return `./${otherSlug}.md`;
  return `../${otherFolder}/${otherSlug}.md`;
}

function buildIndexMd(
  payload: ExportPayload,
  slugMap: Map<string, string>,
  folderForCategoryId: (catId: string | null) => string,
): string {
  const parts: string[] = [];
  parts.push(`# ${payload.universe.name}`);
  parts.push('');

  const desc = payload.universe.description?.trim() ?? '';
  if (desc) {
    parts.push(desc.split('\n').map((line) => `> ${line}`).join('\n'));
    parts.push('');
  }

  parts.push(
    `${payload.entries.length} entries · ${payload.categories.length} categories · ${payload.links.length} links · exported ${todayYYYYMMDD()}`,
  );
  parts.push('');

  const entriesByCategory = new Map<string | null, ExportPayloadEntry[]>();
  for (const e of payload.entries) {
    push(entriesByCategory, e.categoryId, e);
  }

  // Each category section in user-sortOrder, then Uncategorized last.
  for (const cat of payload.categories) {
    const list = entriesByCategory.get(cat.id);
    if (!list || list.length === 0) continue;
    const folder = folderForCategoryId(cat.id);
    parts.push(`## ${cat.label}`);
    parts.push('');
    const sorted = [...list].sort((a, b) => a.title.localeCompare(b.title));
    for (const e of sorted) {
      const slug = slugMap.get(e.id) ?? asciiSlug(e.title);
      parts.push(`- [${e.title}](${folder}/${slug}.md)`);
    }
    parts.push('');
  }

  const uncategorized = entriesByCategory.get(null);
  if (uncategorized && uncategorized.length > 0) {
    parts.push('## Uncategorized');
    parts.push('');
    const sorted = [...uncategorized].sort((a, b) => a.title.localeCompare(b.title));
    for (const e of sorted) {
      const slug = slugMap.get(e.id) ?? asciiSlug(e.title);
      parts.push(`- [${e.title}](Uncategorized/${slug}.md)`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

interface EntryRenderIndex {
  slugMap: Map<string, string>;
  folderForCategoryId: (catId: string | null) => string;
  entryById: Map<string, ExportPayloadEntry>;
  outboundBySource: Map<string, Array<{ relation: string; otherEntryId: string }>>;
  backlinksByTarget: Map<string, string[]>;
  openIssuesByEntry: Map<string, ExportPayloadIssue[]>;
  thisFolder: string;
}

function buildEntryMd(entry: ExportPayloadEntry, idx: EntryRenderIndex): string {
  const parts: string[] = [];

  // Frontmatter — body is NOT in here (lives below the H1).
  // yaml.stringify with lineWidth: 0 disables auto-wrapping; multi-line
  // strings get block scalars and colons-in-strings get quoted (RESEARCH
  // Pitfall 6).
  const frontmatter = yaml.stringify(
    {
      type: entry.entryType,
      tags: entry.tags,
      category: idx.folderForCategoryId(entry.categoryId),
      meta: entry.meta,
    },
    { lineWidth: 0 },
  );
  parts.push(`---\n${frontmatter}---`);
  parts.push('');

  parts.push(`# ${entry.title}`);
  parts.push('');

  const summary = entry.summary?.trim() ?? '';
  if (summary) {
    parts.push(summary.split('\n').map((line) => `> ${line}`).join('\n'));
    parts.push('');
  }

  const body = entry.body?.trimEnd() ?? '';
  if (body) {
    parts.push(body);
    parts.push('');
  }

  // ## Links — outbound, grouped by relation label.
  const outbound = idx.outboundBySource.get(entry.id);
  if (outbound && outbound.length > 0) {
    const byRelation = new Map<string, Set<string>>();
    for (const o of outbound) {
      let set = byRelation.get(o.relation);
      if (!set) {
        set = new Set();
        byRelation.set(o.relation, set);
      }
      set.add(o.otherEntryId);
    }
    parts.push('## Links');
    parts.push('');
    const sortedRelations = [...byRelation.keys()].sort((a, b) => a.localeCompare(b));
    for (const relation of sortedRelations) {
      parts.push(`### ${relation}`);
      parts.push('');
      const otherIds = [...byRelation.get(relation)!];
      const renderable = otherIds
        .map((id) => idx.entryById.get(id))
        .filter((e): e is ExportPayloadEntry => Boolean(e))
        .sort((a, b) => a.title.localeCompare(b.title));
      for (const other of renderable) {
        const otherFolder = idx.folderForCategoryId(other.categoryId);
        const otherSlug = idx.slugMap.get(other.id) ?? asciiSlug(other.title);
        const path = relPathToEntry(idx.thisFolder, otherFolder, otherSlug);
        parts.push(`- [${other.title}](${path})`);
      }
      parts.push('');
    }
  }

  // ## Backlinks — entries that link TO this one (deduplicated).
  const backlinkSourceIds = idx.backlinksByTarget.get(entry.id);
  if (backlinkSourceIds && backlinkSourceIds.length > 0) {
    const seen = new Set<string>();
    const renderable: ExportPayloadEntry[] = [];
    for (const sid of backlinkSourceIds) {
      if (seen.has(sid)) continue;
      seen.add(sid);
      const src = idx.entryById.get(sid);
      if (src) renderable.push(src);
    }
    if (renderable.length > 0) {
      renderable.sort((a, b) => a.title.localeCompare(b.title));
      parts.push('## Backlinks');
      parts.push('');
      for (const src of renderable) {
        const srcFolder = idx.folderForCategoryId(src.categoryId);
        const srcSlug = idx.slugMap.get(src.id) ?? asciiSlug(src.title);
        const path = relPathToEntry(idx.thisFolder, srcFolder, srcSlug);
        parts.push(`- [${src.title}](${path})`);
      }
      parts.push('');
    }
  }

  // ## Open Issues — only entries with at least one open (resolved=false) issue.
  const issues = idx.openIssuesByEntry.get(entry.id);
  if (issues && issues.length > 0) {
    parts.push('## Open Issues');
    parts.push('');
    for (const issue of issues) {
      parts.push(`- **[${issue.severity.toUpperCase()}]** ${issue.title}`);
      const desc = issue.description?.trim() ?? '';
      if (desc) {
        // Two-space indent so markdown treats the description as a
        // continuation of the bullet rather than a new list item.
        parts.push(`  ${desc}`);
      }
    }
    parts.push('');
  }

  return parts.join('\n');
}

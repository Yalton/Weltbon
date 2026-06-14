import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { buildFontFaceBlock } from './fonts.js';
import type {
  ExportPayload,
  ExportPayloadEntry,
  ExportPayloadIssue,
} from '../payload.js';

/**
 * HTML template assembly for the PDF exporter (Plan 04-03 Task 1).
 *
 * Produces a single complete HTML5 document fed into puppeteer's
 * `page.setContent()`. The document is laid out as:
 *
 *   1. Title page    — universe name (large), description blockquote,
 *                      counts paragraph, then `page-break-after: always`.
 *   2. Contents (TOC)— H1 + nested ordered list with `#cat-{id}` and
 *                      `#entry-{id}` anchors that match the body section
 *                      ids. Followed by another `page-break-after`.
 *   3. Body          — per category in user sortOrder (Uncategorized last):
 *                      H1 with `page-break-before: always`, then per entry
 *                      alphabetized by title: H2 + meta line + summary
 *                      callout + body (markdown→HTML via remark) + Links
 *                      section + Open Issues section.
 *
 * Page-1-no-footer trick: `@page :first { margin: 0 0 0 0; }` collapses the
 * title page's footer band to zero height so the puppeteer-substituted
 * footer renders off-canvas. The CSS rule is documented inside cssRules
 * below — confirmed visually with the manual verification step in 04-03.
 *
 * Bidirectional link convention (matches Plan 04-02): a single bidirectional
 * link record renders as outbound on BOTH endpoints. There's no separate
 * "backlinks" section in the PDF — the symmetry is obvious from each entry
 * showing the other under its own Links section.
 *
 * Resolved-issue exclusion: we read from `payload.openIssues`, which the
 * loader has already filtered to `resolved=false`. The PDF can never leak
 * resolved issues by construction.
 */

const mdToHtml = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeStringify);

/**
 * Render a markdown string into HTML via remark + remark-gfm.
 *
 * Returns the empty string for empty/whitespace-only input so the body
 * sections cleanly omit when an entry has no body. Asynchronous because
 * unified's `process` returns a Promise — kept separate so the caller can
 * await each entry's body in parallel if needed (current code awaits
 * sequentially since per-entry markdown is small).
 */
async function renderBodyHtml(md: string): Promise<string> {
  const trimmed = md?.trim() ?? '';
  if (!trimmed) return '';
  const file = await mdToHtml.process(trimmed);
  return String(file);
}

/**
 * Escape the five characters that can break out of an HTML attribute or
 * text node context. Used for every user-supplied string emitted into the
 * template (titles, summaries, tags, footer's universe name).
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Footer template per RESEARCH Code Example 1.
 *
 * Three columns: empty left, centered `<span class="pageNumber"></span>`
 * (substituted by puppeteer with the current page number), right-aligned
 * universe name. Inline styles only — the footer template runs in an
 * isolated context and `body` styles do not apply (RESEARCH Pitfall:
 * puppeteer-issue/1853).
 *
 * The page-1-no-footer concern is handled by the `@page :first` rule in
 * the main template's CSS, which collapses the bottom margin to zero on
 * the title page so this footer renders off-canvas there.
 */
export function footerTemplate(universeName: string): string {
  return `<div style="font-size: 9px; color: #666; width: 100%; padding: 0 20mm; display: flex; justify-content: space-between; font-family: Inter, sans-serif;"><span></span><span><span class="pageNumber"></span></span><span style="text-align: right;">${escapeHtml(
    universeName,
  )}</span></div>`;
}

/**
 * Build the complete HTML5 document string fed into puppeteer's setContent().
 *
 * Async because `buildFontFaceBlock()` reads font files from disk and
 * because each entry's markdown body is rendered through unified.
 */
export async function renderUniverseHtml(payload: ExportPayload): Promise<string> {
  const fontBlock = await buildFontFaceBlock();
  const cssRules = buildCssRules();

  const titlePage = renderTitlePage(payload);
  const toc = renderToc(payload);
  const body = await renderBody(payload);

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${fontBlock}\n${cssRules}</style></head><body>${titlePage}${toc}${body}</body></html>`;
}

// ---------- private helpers ----------

function buildCssRules(): string {
  // `@page :first { margin: 0 ... }` collapses the title page's bottom
  // margin so puppeteer's substituted footer renders into zero-height
  // space — effectively invisible on page 1, visible on every page after.
  return `
    @page { size: A4; margin: 20mm 20mm 25mm 20mm; }
    @page :first { margin: 0; }
    body { font-family: 'Inter', 'Noto Sans', 'Noto Sans Symbols 2', 'Noto Color Emoji', sans-serif; color: #111; line-height: 1.55; font-size: 11pt; margin: 0; }
    .title-page { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 240mm; text-align: center; padding: 25mm; box-sizing: border-box; }
    .title-page-h1 { font-size: 32pt; font-weight: 700; margin: 0 0 1.5em; }
    .subtitle { font-style: italic; font-size: 14pt; color: #444; max-width: 80%; margin: 0 0 2em; }
    .counts { color: #666; margin-top: 3em; }
    .toc h1 { font-size: 22pt; margin: 0 0 1em; }
    .toc-categories { font-size: 11pt; }
    .toc-categories a { color: #111; text-decoration: none; }
    .cat-heading { page-break-before: always; font-size: 22pt; margin-top: 0; padding-top: 1em; }
    h2 { font-size: 16pt; margin-top: 1.5em; }
    h3 { font-size: 12pt; margin-top: 1em; color: #333; }
    .meta { color: #666; font-size: 10pt; margin: 0.25em 0 1em; }
    .summary { background: #f4f4f5; padding: 0.75em 1em; border-left: 3px solid #888; margin: 1em 0; font-style: italic; }
    .severity-pill { font-weight: 700; }
    .severity-CRITICAL { color: #b00020; }
    .severity-MAJOR { color: #c25500; }
    .severity-MODERATE { color: #8a7400; }
    .severity-MINOR { color: #555; }
    .links-section ul { margin: 0.25em 0 0.75em; padding-left: 1.5em; }
    .open-issues p { margin: 0.25em 0; }
    .entry-body p, .entry-body ul, .entry-body ol { margin: 0.5em 0; }
    .entry-body h1, .entry-body h2, .entry-body h3, .entry-body h4 { margin-top: 1em; }
  `.trim();
}

function renderTitlePage(payload: ExportPayload): string {
  const name = escapeHtml(payload.universe.name);
  const desc = payload.universe.description?.trim() ?? '';
  const subtitle = desc
    ? `<blockquote class="subtitle">${escapeHtml(desc)}</blockquote>`
    : '';
  const date = new Date().toISOString().slice(0, 10);
  const counts = `${payload.categories.length} categories · ${payload.entries.length} entries · ${payload.links.length} links · exported ${date}`;
  return `<section class="title-page"><h1 class="title-page-h1">${name}</h1>${subtitle}<p class="counts">${counts}</p></section><div style="page-break-after: always;"></div>`;
}

function renderToc(payload: ExportPayload): string {
  const entriesByCategory = groupEntriesByCategory(payload.entries);
  const parts: string[] = [];
  parts.push('<section class="toc"><h1>Contents</h1><ol class="toc-categories">');

  for (const cat of payload.categories) {
    const list = entriesByCategory.get(cat.id) ?? [];
    if (list.length === 0) continue;
    parts.push(`<li><a href="#cat-${escapeHtml(cat.id)}">${escapeHtml(cat.label)}</a>`);
    parts.push('<ol>');
    for (const e of [...list].sort((a, b) => a.title.localeCompare(b.title))) {
      parts.push(
        `<li><a href="#entry-${escapeHtml(e.id)}">${escapeHtml(e.title)}</a></li>`,
      );
    }
    parts.push('</ol></li>');
  }

  const uncategorized = entriesByCategory.get(null) ?? [];
  if (uncategorized.length > 0) {
    parts.push(`<li><a href="#cat-uncategorized">Uncategorized</a><ol>`);
    for (const e of [...uncategorized].sort((a, b) => a.title.localeCompare(b.title))) {
      parts.push(
        `<li><a href="#entry-${escapeHtml(e.id)}">${escapeHtml(e.title)}</a></li>`,
      );
    }
    parts.push('</ol></li>');
  }

  parts.push('</ol></section><div style="page-break-after: always;"></div>');
  return parts.join('');
}

async function renderBody(payload: ExportPayload): Promise<string> {
  const entriesByCategory = groupEntriesByCategory(payload.entries);
  const outboundBySource = buildOutboundIndex(payload);
  const openIssuesByEntry = buildOpenIssuesIndex(payload);
  const entryById = new Map(payload.entries.map((e) => [e.id, e] as const));

  const parts: string[] = [];

  for (const cat of payload.categories) {
    const list = entriesByCategory.get(cat.id) ?? [];
    if (list.length === 0) continue;
    parts.push(
      `<h1 id="cat-${escapeHtml(cat.id)}" class="cat-heading">${escapeHtml(cat.label)}</h1>`,
    );
    for (const entry of [...list].sort((a, b) => a.title.localeCompare(b.title))) {
      parts.push(
        await renderEntry(entry, { entryById, outboundBySource, openIssuesByEntry }),
      );
    }
  }

  const uncategorized = entriesByCategory.get(null) ?? [];
  if (uncategorized.length > 0) {
    parts.push(
      `<h1 id="cat-uncategorized" class="cat-heading">Uncategorized</h1>`,
    );
    for (const entry of [...uncategorized].sort((a, b) =>
      a.title.localeCompare(b.title),
    )) {
      parts.push(
        await renderEntry(entry, { entryById, outboundBySource, openIssuesByEntry }),
      );
    }
  }

  return parts.join('');
}

interface EntryRenderIndex {
  entryById: Map<string, ExportPayloadEntry>;
  outboundBySource: Map<
    string,
    Array<{ relation: string; otherEntryId: string }>
  >;
  openIssuesByEntry: Map<string, ExportPayloadIssue[]>;
}

async function renderEntry(
  entry: ExportPayloadEntry,
  idx: EntryRenderIndex,
): Promise<string> {
  const parts: string[] = [];
  parts.push(`<section class="entry">`);
  parts.push(
    `<h2 id="entry-${escapeHtml(entry.id)}">${escapeHtml(entry.title)}</h2>`,
  );

  const tags = entry.tags && entry.tags.length > 0 ? entry.tags.join(', ') : '—';
  parts.push(
    `<p class="meta">Type: ${escapeHtml(entry.entryType)} · Tags: ${escapeHtml(tags)}</p>`,
  );

  const summary = entry.summary?.trim() ?? '';
  if (summary) {
    parts.push(`<blockquote class="summary">${escapeHtml(summary)}</blockquote>`);
  }

  const bodyHtml = await renderBodyHtml(entry.body ?? '');
  if (bodyHtml) {
    parts.push(`<div class="entry-body">${bodyHtml}</div>`);
  }

  // Links section — outbound, grouped by relation label, sorted alphabetically.
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
    parts.push('<div class="links-section"><h3>Links</h3>');
    const sortedRelations = [...byRelation.keys()].sort((a, b) => a.localeCompare(b));
    for (const relation of sortedRelations) {
      parts.push(`<h4>${escapeHtml(relation)}</h4><ul>`);
      const others = [...byRelation.get(relation)!]
        .map((id) => idx.entryById.get(id))
        .filter((e): e is ExportPayloadEntry => Boolean(e))
        .sort((a, b) => a.title.localeCompare(b.title));
      for (const other of others) {
        parts.push(
          `<li><a href="#entry-${escapeHtml(other.id)}">${escapeHtml(other.title)}</a></li>`,
        );
      }
      parts.push('</ul>');
    }
    parts.push('</div>');
  }

  // Open Issues section — only when entry has at least one open issue.
  const issues = idx.openIssuesByEntry.get(entry.id);
  if (issues && issues.length > 0) {
    parts.push(
      `<div class="open-issues"><h3>Open Issues (${issues.length})</h3>`,
    );
    for (const issue of issues) {
      const sev = issue.severity.toUpperCase();
      const desc = issue.description?.trim() ?? '';
      const descPart = desc ? `: ${escapeHtml(desc)}` : '';
      parts.push(
        `<p><span class="severity-pill severity-${escapeHtml(sev)}">[${escapeHtml(sev)}]</span> ${escapeHtml(issue.title)}${descPart}</p>`,
      );
    }
    parts.push('</div>');
  }

  parts.push('</section>');
  return parts.join('');
}

function groupEntriesByCategory(
  entries: ExportPayloadEntry[],
): Map<string | null, ExportPayloadEntry[]> {
  const out = new Map<string | null, ExportPayloadEntry[]>();
  for (const e of entries) {
    const list = out.get(e.categoryId);
    if (list) list.push(e);
    else out.set(e.categoryId, [e]);
  }
  return out;
}

function buildOutboundIndex(
  payload: ExportPayload,
): Map<string, Array<{ relation: string; otherEntryId: string }>> {
  const out = new Map<string, Array<{ relation: string; otherEntryId: string }>>();
  const push = (k: string, v: { relation: string; otherEntryId: string }) => {
    const list = out.get(k);
    if (list) list.push(v);
    else out.set(k, [v]);
  };
  for (const l of payload.links) {
    // Phase 35 REL-01: label is now nullable; fall back to linkType then 'related'
    push(l.sourceEntryId, { relation: l.label ?? l.linkType ?? 'related', otherEntryId: l.targetEntryId });
    // Phase 35 REL-01: was `if (l.bidirectional)` — undirected links appear on both sides
    if (l.direction === 'undirected') {
      push(l.targetEntryId, { relation: l.label ?? l.linkType ?? 'related', otherEntryId: l.sourceEntryId });
    }
  }
  return out;
}

function buildOpenIssuesIndex(
  payload: ExportPayload,
): Map<string, ExportPayloadIssue[]> {
  const out = new Map<string, ExportPayloadIssue[]>();
  for (const issue of payload.openIssues) {
    for (const eid of issue.entryIds) {
      const list = out.get(eid);
      if (list) list.push(issue);
      else out.set(eid, [issue]);
    }
  }
  return out;
}

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  TableOfContents,
  PageBreak,
  type Table,
  type ParagraphChild,
} from 'docx';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root } from 'mdast';
import { mdastToDocx } from './walker.js';
import { docxStyles, docxNumbering } from './styles.js';
import type {
  ExportPayload,
  ExportPayloadEntry,
  ExportPayloadIssue,
  ExportPayloadLink,
} from '../payload.js';

/**
 * DOCX exporter — produces a Word document with:
 *
 *   1. Title page (universe name in Word's Title style + description + counts)
 *   2. "Contents" Heading1 + TableOfContents field (Word evaluates on first
 *      open via features.updateFields = true)
 *   3. Per category (sortOrder, Uncategorized last): Heading1 with page break
 *   4. Per entry (alphabetical): Heading2 + meta line + Quote summary +
 *      walker-rendered markdown body + Links section + Open Issues section
 *
 * Resolved issues are filtered out at the payload level (payload.openIssues
 * already excludes them); we never reach the fullIssues list here.
 *
 * Output is a Uint8Array — the route layer hands it directly to c.body().
 * Buffering the full DOCX is acceptable per CONTEXT.md (DOCX size is
 * bounded; the EXP-05 streaming requirement targets ZIP and PDF).
 */

const md = unified().use(remarkParse).use(remarkGfm);

export async function renderUniverseDocx(payload: ExportPayload): Promise<Uint8Array> {
  const children: Array<Paragraph | Table | TableOfContents> = [];

  // ---- Title page ----
  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [new TextRun(payload.universe.name)],
    }),
  );
  if (payload.universe.description) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: payload.universe.description, italics: true })],
      }),
    );
  }
  const counts =
    `${payload.categories.length} categories · ` +
    `${payload.entries.length} entries · ` +
    `${payload.links.length} links · ` +
    `exported ${new Date().toISOString().slice(0, 10)}`;
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun(counts)],
    }),
  );
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // ---- TOC ----
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun('Contents')],
    }),
  );
  children.push(
    new TableOfContents('Contents', {
      hyperlink: true,
      headingStyleRange: '1-2',
    }),
  );
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // ---- Indices ----
  const outboundBySource = buildOutbound(payload);
  const openIssuesByEntry = buildOpenIssues(payload);
  const entryById = new Map(payload.entries.map((e) => [e.id, e] as const));

  // ---- Body: categories then entries ----
  for (const group of groupEntriesByCategory(payload)) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: true,
        children: [new TextRun(group.catLabel)],
      }),
    );
    for (const entry of group.entries) {
      // Heading2: entry title
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun(entry.title)],
        }),
      );

      // Meta line: "Type: X · Tags: a, b, c"
      const tagText = entry.tags.length ? entry.tags.join(', ') : '—';
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `Type: ${entry.entryType} · Tags: ${tagText}`,
              color: '666666',
              size: 18,
            }),
          ],
        }),
      );

      // Summary callout (Quote style)
      if (entry.summary) {
        children.push(
          new Paragraph({
            style: 'Quote',
            children: [new TextRun(entry.summary)],
          }),
        );
      }

      // Body — markdown via walker
      if (entry.body.trim()) {
        const root = md.parse(entry.body) as Root;
        children.push(...mdastToDocx(root, 3));
      }

      // Links section (outbound, grouped by relation label)
      const outbound = outboundBySource.get(entry.id);
      if (outbound && outbound.length) {
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_3,
            children: [new TextRun('Links')],
          }),
        );
        const byRelation = groupBy(outbound, (l) => l.label || 'related');
        for (const [rel, linksInRel] of byRelation) {
          children.push(
            new Paragraph({
              children: [new TextRun({ text: rel, bold: true })],
            }),
          );
          for (const l of linksInRel) {
            const otherId =
              l.sourceEntryId === entry.id ? l.targetEntryId : l.sourceEntryId;
            const other = entryById.get(otherId);
            if (!other) continue;
            children.push(
              new Paragraph({
                style: 'ListParagraph',
                bullet: { level: 0 },
                children: [new TextRun(other.title)],
              }),
            );
          }
        }
      }

      // Open Issues section (only if any open issues for this entry)
      const issues = openIssuesByEntry.get(entry.id);
      if (issues && issues.length) {
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_3,
            children: [new TextRun(`Open Issues (${issues.length})`)],
          }),
        );
        for (const issue of issues) {
          const sev = `[${issue.severity.toUpperCase()}]`;
          const parts: ParagraphChild[] = [
            new TextRun({ text: sev + ' ', bold: true }),
            new TextRun(issue.title),
          ];
          if (issue.description) {
            parts.push(new TextRun({ text: ` — ${issue.description}` }));
          }
          children.push(new Paragraph({ children: parts }));
        }
      }
    }
  }

  const doc = new Document({
    creator: 'Weltbon',
    title: payload.universe.name,
    features: { updateFields: true },
    styles: docxStyles,
    numbering: docxNumbering,
    sections: [{ children }],
  });

  const buf = await Packer.toBuffer(doc);
  return new Uint8Array(buf);
}

// ---------- helpers ----------

interface CategoryGroup {
  catLabel: string;
  entries: ExportPayloadEntry[];
}

function groupEntriesByCategory(payload: ExportPayload): CategoryGroup[] {
  const out: CategoryGroup[] = [];
  for (const cat of payload.categories) {
    const list = payload.entries
      .filter((e) => e.categoryId === cat.id)
      .sort((a, b) => a.title.localeCompare(b.title));
    if (list.length) out.push({ catLabel: cat.label, entries: list });
  }
  const uncat = payload.entries
    .filter((e) => e.categoryId === null)
    .sort((a, b) => a.title.localeCompare(b.title));
  if (uncat.length) out.push({ catLabel: 'Uncategorized', entries: uncat });
  return out;
}

/**
 * Build a map of source entry → outbound links. Bidirectional links appear
 * as outbound on BOTH endpoints (matches the markdown exporter's convention
 * established in plan 04-02).
 */
function buildOutbound(payload: ExportPayload): Map<string, ExportPayloadLink[]> {
  const map = new Map<string, ExportPayloadLink[]>();
  for (const link of payload.links) {
    push(map, link.sourceEntryId, link);
    if (link.direction === 'undirected') push(map, link.targetEntryId, link);
  }
  return map;
}

function buildOpenIssues(
  payload: ExportPayload,
): Map<string, ExportPayloadIssue[]> {
  const map = new Map<string, ExportPayloadIssue[]>();
  for (const issue of payload.openIssues) {
    for (const entryId of issue.entryIds) {
      push(map, entryId, issue);
    }
  }
  return map;
}

function push<K, V>(map: Map<K, V[]>, key: K, val: V): void {
  const list = map.get(key);
  if (list) list.push(val);
  else map.set(key, [val]);
}

function groupBy<T, K>(arr: T[], key: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of arr) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  TableOfContents,
  PageBreak,
  ImageRun,
  type Table,
  type ParagraphChild,
} from 'docx';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root } from 'mdast';
import { mdastToDocx } from './walker.js';
import { docxStyles, docxNumbering } from './styles.js';
import { storageBackend } from '../../storage/local.js';
import type {
  ExportPayload,
  ExportPayloadAsset,
  ExportPayloadEntry,
  ExportPayloadIssue,
  ExportPayloadLink,
} from '../payload.js';


const md = unified().use(remarkParse).use(remarkGfm);

async function buildCoverParagraph(assetId: string): Promise<Paragraph | null> {
  const bytes = await storageBackend.get(assetId);
  if (!bytes) return null;
  return new Paragraph({
    children: [
      new ImageRun({
        type: 'png',
        data: bytes,
        transformation: { width: 400, height: 300 },
        altText: { name: 'cover', description: 'Cover image', title: 'Cover image' },
      }),
    ],
  });
}

async function resolveInlineAssets(
  body: string,
  assetMap: Map<string, ExportPayloadAsset>,
): Promise<Array<Paragraph | Table>> {
  const IMAGE_RE = /!\[([^\]]*)\]\(asset:\/\/([a-f0-9-]+)\)/gi;
  const parts: Array<{ type: 'text'; text: string } | { type: 'image'; uuid: string; alt: string }> = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  IMAGE_RE.lastIndex = 0;
  while ((m = IMAGE_RE.exec(body)) !== null) {
    if (m.index > lastIndex) {
      parts.push({ type: 'text', text: body.slice(lastIndex, m.index) });
    }
    parts.push({ type: 'image', uuid: m[2], alt: m[1] });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < body.length) {
    parts.push({ type: 'text', text: body.slice(lastIndex) });
  }

  const result: Array<Paragraph | Table> = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text.trim()) {
        const md = unified().use(remarkParse).use(remarkGfm);
        const root = md.parse(part.text) as Root;
        result.push(...mdastToDocx(root, 3));
      }
    } else {
      const asset = assetMap.get(part.uuid);
      if (!asset) continue;
      const bytes = await storageBackend.get(part.uuid);
      if (!bytes) continue;
      result.push(
        new Paragraph({
          children: [
            new ImageRun({
              type: 'png',
              data: bytes,
              transformation: { width: 400, height: 300 },
              altText: { name: part.uuid, description: part.alt || 'Image', title: part.alt || 'Image' },
            }),
          ],
        }),
      );
    }
  }
  return result;
}

export async function renderUniverseDocx(payload: ExportPayload): Promise<Uint8Array<ArrayBuffer>> {
  const children: Array<Paragraph | Table | TableOfContents> = [];
  const assetMap = new Map(payload.assets.map((a) => [a.id, a] as const));

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
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          children: [new TextRun(entry.title)],
        }),
      );

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

      if (entry.coverImageId) {
        const coverPara = await buildCoverParagraph(entry.coverImageId);
        if (coverPara) children.push(coverPara);
      }

      if (entry.summary) {
        children.push(
          new Paragraph({
            style: 'Quote',
            children: [new TextRun(entry.summary)],
          }),
        );
      }

      // Body — markdown via walker; resolve asset:// inline embeds (D-08).
      if (entry.body.trim()) {
        const bodyHasAssets = /asset:\/\//i.test(entry.body);
        if (bodyHasAssets) {
          const inlineParagraphs = await resolveInlineAssets(entry.body, assetMap);
          children.push(...inlineParagraphs);
        } else {
          const root = md.parse(entry.body) as Root;
          children.push(...mdastToDocx(root, 3));
        }
      }

      const outbound = outboundBySource.get(entry.id);
      if (outbound && outbound.length) {
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_3,
            children: [new TextRun('Links')],
          }),
        );
        const byRelation = groupBy(outbound, (l) => l.label ?? l.linkType ?? 'related');
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

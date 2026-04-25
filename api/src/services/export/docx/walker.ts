import {
  Paragraph,
  TextRun,
  HeadingLevel,
  ExternalHyperlink,
  Table,
  TableRow,
  TableCell,
  BorderStyle,
} from 'docx';
import type {
  Root,
  RootContent,
  PhrasingContent,
  ListItem,
  Table as MTable,
  TableRow as MTableRow,
  TableCell as MTableCell,
  BlockContent,
} from 'mdast';

/**
 * mdast → docx walker.
 *
 * Produces a flat array of block-level docx constructs (Paragraph | Table)
 * from a remark-parsed mdast tree. Used by the DOCX exporter to translate
 * each entry's markdown body into Word-native formatting (bold/italic/code,
 * lists, links, tables, blockquote callouts).
 *
 * Heading downshift: at base=3, body H1 → HEADING_3, body H2 → HEADING_4,
 * etc., capped at HEADING_6. The DOCX exporter uses base=3 because
 * categories own H1 and entries own H2 — markdown body headings sit
 * underneath the entry heading and must not collide with the TOC range.
 *
 * Blockquote handling uses a threaded `ctx.style` argument rather than
 * post-hoc Paragraph rewriting (the `extractParagraphChildren` placeholder
 * sketched in the plan was known-bad — Paragraph internals are private and
 * cannot be cloned). Threading the style through means the Paragraph is
 * constructed correctly the first time.
 *
 * Unknown / unsupported nodes (image, html, footnoteReference, etc.) drop
 * silently — v1 does not need them.
 */

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

interface WalkContext {
  /** When set, every Paragraph emitted in this subtree is created with this style id (e.g. 'Quote'). */
  style?: string;
}

export function mdastToDocx(root: Root, base: 3 | 4 = 3): Array<Paragraph | Table> {
  const out: Array<Paragraph | Table> = [];
  for (const node of root.children) {
    out.push(...convertBlock(node, base, {}));
  }
  return out;
}

function convertBlock(
  node: RootContent | BlockContent,
  base: 3 | 4,
  ctx: WalkContext,
): Array<Paragraph | Table> {
  switch (node.type) {
    case 'heading': {
      // base + node.depth - 1 indexes into HEADING_LEVELS, capped at 6.
      const idx = Math.min(base + node.depth - 1, 6) - 1;
      return [
        new Paragraph({
          heading: HEADING_LEVELS[idx],
          style: ctx.style,
          children: convertInlines(node.children),
        }),
      ];
    }
    case 'paragraph':
      return [
        new Paragraph({
          style: ctx.style,
          children: convertInlines(node.children),
        }),
      ];
    case 'list': {
      const ordered = !!node.ordered;
      return node.children.map((li, idx) =>
        listItemToParagraph(li, ordered, 0, ctx, idx),
      );
    }
    case 'blockquote':
      // Thread style: 'Quote' through every nested block. This is the
      // researched fix for the placeholder `extractParagraphChildren` —
      // Paragraph cannot be cloned, so set the style at construction time.
      return node.children.flatMap((c) =>
        convertBlock(c, base, { ...ctx, style: 'Quote' }),
      );
    case 'code':
      return [
        new Paragraph({
          style: ctx.style,
          children: [new TextRun({ text: node.value, font: 'Consolas' })],
        }),
      ];
    case 'thematicBreak':
      return [
        new Paragraph({
          style: ctx.style,
          border: {
            bottom: { color: '888888', space: 1, style: BorderStyle.SINGLE, size: 6 },
          },
          children: [],
        }),
      ];
    case 'table':
      return [convertTable(node)];
    // Silently drop everything else — v1 markdown subset doesn't include these.
    case 'html':
    case 'definition':
    case 'footnoteDefinition':
    case 'yaml':
    default:
      return [];
  }
}

function listItemToParagraph(
  li: ListItem,
  ordered: boolean,
  level: number,
  ctx: WalkContext,
  index: number,
): Paragraph {
  // Most list items wrap a single paragraph; flatten its inlines if so.
  const first = li.children[0];
  const inlines: Array<TextRun | ExternalHyperlink> =
    first && first.type === 'paragraph' ? convertInlines(first.children) : [];
  return new Paragraph({
    style: ctx.style ?? 'ListParagraph',
    bullet: ordered ? undefined : { level },
    numbering: ordered ? { reference: 'numbered-list', level, instance: index } : undefined,
    children: inlines,
  });
}

function convertInlines(
  nodes: readonly PhrasingContent[],
): Array<TextRun | ExternalHyperlink> {
  const out: Array<TextRun | ExternalHyperlink> = [];
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        out.push(new TextRun({ text: n.value }));
        break;
      case 'strong':
        // children: convertInlines(...) is filtered to TextRun only — nested
        // ExternalHyperlinks inside **bold** are extremely rare in worldbuilding
        // and would require the link to lose its bold marker anyway.
        out.push(
          new TextRun({
            children: convertInlines(n.children).filter(
              (c): c is TextRun => c instanceof TextRun,
            ),
            bold: true,
          }),
        );
        break;
      case 'emphasis':
        out.push(
          new TextRun({
            children: convertInlines(n.children).filter(
              (c): c is TextRun => c instanceof TextRun,
            ),
            italics: true,
          }),
        );
        break;
      case 'inlineCode':
        out.push(new TextRun({ text: n.value, font: 'Consolas' }));
        break;
      case 'link': {
        const linkChildren = convertInlines(n.children).filter(
          (c): c is TextRun => c instanceof TextRun,
        );
        // If the link has no readable children (e.g. `[](http://x)`), emit the
        // URL itself so the DOCX shows something clickable.
        const innerRuns = linkChildren.length
          ? linkChildren
          : [new TextRun({ text: n.url })];
        // The Hyperlink style on inner runs gives Word the blue underlined look.
        // Re-wrap to apply the style (TextRun children option doesn't accept style;
        // re-construct from the original text with style applied).
        out.push(
          new ExternalHyperlink({
            link: n.url,
            children: innerRuns.map(
              () =>
                new TextRun({
                  text: extractText(n.children) || n.url,
                  style: 'Hyperlink',
                }),
            ).slice(0, 1), // single combined run; Hyperlink children are typically a single run
          }),
        );
        break;
      }
      case 'break':
        out.push(new TextRun({ break: 1 }));
        break;
      // Skip: image, imageReference, linkReference, html, footnoteReference
      default:
        break;
    }
  }
  return out;
}

function convertTable(t: MTable): Table {
  const rows = t.children.map(
    (row: MTableRow) =>
      new TableRow({
        children: row.children.map(
          (cell: MTableCell) =>
            new TableCell({
              children: [new Paragraph({ children: convertInlines(cell.children) })],
            }),
        ),
      }),
  );
  return new Table({ rows });
}

/** Flatten phrasing content into a plain string (used for hyperlink display text). */
function extractText(nodes: readonly PhrasingContent[]): string {
  let s = '';
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
      case 'inlineCode':
        s += n.value;
        break;
      case 'strong':
      case 'emphasis':
      case 'link':
        s += extractText(n.children);
        break;
      default:
        break;
    }
  }
  return s;
}

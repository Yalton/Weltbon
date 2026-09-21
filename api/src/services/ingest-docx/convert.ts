import type {
  DocxBlock, DocxDocument, DocxImage, DocxParagraph, DocxRun, DocxTable,
} from './parse.js';
import { resolveStyledHeading } from './headings.js';
import type { HeadingLevel, StyleIndex } from './headings.js';

export type DocxWarningCode =
  | 'image-dropped' | 'equation-dropped' | 'formatting-dropped'
  | 'tracked-changes-applied' | 'comments-dropped' | 'field-dropped'
  | 'table-flattened' | 'textbox-dropped' | 'symbol-dropped'
  | 'no-headings' | 'unstyled-headings-detected'
  | 'mixed-headings-detected';

export interface DocxWarning { code: DocxWarningCode; message: string; count: number }

export interface DocxMediaRef {
  blockIndex: number; relId: string | null; contentType: string | null;
  name: string | null; declaredBytes: number;
}

export interface ConvertOptions {
  styleIndex: StyleIndex;
  promotedHeadings: Map<number, HeadingLevel>;
  rels: Map<string, string>;
  footnotes: Map<string, string>;
  mediaEntries: Array<{ name: string; declaredBytes: number }>;
  coreProps: Record<string, string> | null;
  numberingFormats?: Map<string, 'bullet' | 'ordered'>;
}

export interface ConvertResult {
  markdown: string; warnings: DocxWarning[]; media: DocxMediaRef[];
}

export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_[\]`#|~<]/g, (ch) => `\\${ch}`);
}

function escapeLineStarts(text: string): string {
  return text.split('\n').map((line) => {
    const split = /^([ \t]*)([\s\S]*)$/.exec(line);
    if (split === null) return line;
    let [, lead, rest] = split;
    if (rest === '') return line;
    if (lead.includes('\t') || lead.length >= 4) lead = '   ';

    if (/^-(?=[ \t]|$)/.test(rest) || /^[- \t]+$/.test(rest)) return `${lead}\\${rest}`;
    if (/^\+(?=[ \t]|$)/.test(rest)) return `${lead}\\${rest}`;
    if (/^>/.test(rest)) return `${lead}\\${rest}`;
    const ordered = /^(\d{1,9})[.)](?=[ \t]|$)/.exec(rest);
    if (ordered !== null) {
      return `${lead}${ordered[1]}\\${rest.slice(ordered[1].length)}`;
    }
    if (/^=+[ \t]*$/.test(rest)) return `${lead}\\${rest}`;
    return `${lead}${rest}`;
  }).join('\n');
}

function stripTrailingBreaks(text: string): string {
  return text.replace(/(?:\\\n)+$/, '');
}

function flattenBreaks(text: string): string {
  return text.replace(/\\\n/g, ' ').replace(/\n/g, ' ');
}

interface Chunk { text: string; listItem: boolean }

const HARD_BREAK = '\\\n';

function hasDroppedFormatting(r: DocxRun): boolean {
  return r.underline || r.highlight || r.vertAlign !== 'baseline';
}

function isQuoteStyle(styleId: string | null): boolean {
  return styleId !== null && /^(intense)?quote$/i.test(styleId.replace(/\s+/g, ''));
}

function decorate(escaped: string, r: DocxRun): string {
  if (!r.bold && !r.italic && !r.strike) return escaped;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(escaped);
  if (m === null || m[2] === '') return escaped;
  let core = m[2];
  if (r.strike) core = `~~${core}~~`;
  if (r.italic) core = `*${core}*`;
  if (r.bold) core = `**${core}**`;
  return `${m[1]}${core}${m[3]}`;
}

function formatDestination(url: string): string {
  if (/[\s<>()]/.test(url)) return `<${url.replace(/([<>\\])/g, '\\$1')}>`;
  return url;
}

function basename(target: string): string {
  const cleaned = target.replace(/[?#].*$/, '');
  const cut = cleaned.lastIndexOf('/');
  return cut === -1 ? cleaned : cleaned.slice(cut + 1);
}

function mediaEntryName(target: string): string {
  const t = target.replace(/^\/+/, '');
  return t.startsWith('word/') ? t : `word/${t}`;
}

interface RenderContext {
  opts: ConvertOptions;
  bump: (code: DocxWarningCode, n?: number) => void;
  footnoteOrder: string[];
}

function renderRuns(
  runs: DocxRun[], ctx: RenderContext, singleLine: boolean, plain = false,
): string {
  let out = '';
  let i = 0;
  while (i < runs.length) {
    const link = runs[i].hyperlink;
    const dest = link === null ? null : resolveLink(link, ctx.opts.rels);
    if (plain || link === null || dest === null) {
      out += renderRun(runs[i], ctx, singleLine, plain);
      i += 1;
      continue;
    }
    let text = '';
    while (i < runs.length) {
      const next = runs[i].hyperlink;
      if (next === null || next.relId !== link.relId || next.anchor !== link.anchor) break;
      text += renderRun(runs[i], ctx, true);
      i += 1;
    }
    out += text === '' ? '' : `[${text}](${formatDestination(dest)})`;
  }
  return out;
}

function resolveLink(
  link: { relId: string | null; anchor: string | null },
  rels: Map<string, string>,
): string | null {
  if (link.relId !== null) {
    const target = rels.get(link.relId);
    if (target !== undefined && target !== '') {
      return link.anchor === null ? target : `${target}#${link.anchor}`;
    }
  }
  if (link.anchor !== null && link.anchor !== '') return `#${link.anchor}`;
  return null;
}

function renderRun(
  r: DocxRun, ctx: RenderContext, singleLine: boolean, plain = false,
): string {
  if (hasDroppedFormatting(r)) ctx.bump('formatting-dropped');
  if (r.lineBreak) return singleLine ? ' ' : HARD_BREAK;
  if (r.tab) return ' ';
  if (plain && r.footnoteRef !== null) return '';
  if (r.footnoteRef !== null) {
    const id = r.footnoteRef;
    if (!ctx.footnoteOrder.includes(id)) ctx.footnoteOrder.push(id);
    return `[^${id}]`;
  }
  const text = r.caps ? r.text.toUpperCase() : r.text;
  if (plain) return text;
  return decorate(escapeMarkdown(text), r);
}

function renderParagraph(
  block: DocxParagraph, index: number, ctx: RenderContext,
  counts: { headings: number },
): Chunk | null {
  const styled = resolveStyledHeading(block, ctx.opts.styleIndex);
  const level = styled ?? ctx.opts.promotedHeadings.get(index) ?? null;

  if (level !== null) {
    const text = renderRuns(block.runs, ctx, true, true).trim();
    if (text === '') return null;
    counts.headings += 1;
    return { text: `${'#'.repeat(level)} ${text}`, listItem: false };
  }

  const body = stripTrailingBreaks(renderRuns(block.runs, ctx, false));
  if (body.trim() === '') return null;

  if (block.numbering !== null) {
    const format = ctx.opts.numberingFormats?.get(block.numbering.numId) ?? 'bullet';
    const marker = format === 'ordered' ? '1.' : '-';
    const indent = (marker === '-' ? '  ' : '   ').repeat(Math.max(0, block.numbering.ilvl));
    return { text: `${indent}${marker} ${escapeLineStarts(flattenBreaks(body))}`, listItem: true };
  }

  const escaped = escapeLineStarts(body);
  if (isQuoteStyle(block.styleId)) {
    return { text: escaped.split('\n').map((l) => `> ${l}`).join('\n'), listItem: false };
  }
  return { text: escaped, listItem: false };
}

function renderTable(block: DocxTable, ctx: RenderContext): Chunk | null {
  if (block.rows.length === 0) return null;
  if (block.hasMergedCells) ctx.bump('table-flattened');
  const width = block.rows.reduce((max, row) => (row.length > max ? row.length : max), 0);
  if (width === 0) return null;

  const cell = (c: { runs: DocxRun[] } | undefined): string =>
    c === undefined ? '' : renderRuns(c.runs, ctx, true).trim();
  const line = (row: Array<{ runs: DocxRun[] }>): string => {
    const cells: string[] = [];
    for (let i = 0; i < width; i += 1) cells.push(cell(row[i]));
    return `| ${cells.join(' | ')} |`;
  };

  const lines = [line(block.rows[0]), `| ${Array(width).fill('---').join(' | ')} |`];
  for (const row of block.rows.slice(1)) lines.push(line(row));
  return { text: lines.join('\n'), listItem: false };
}

function renderImage(
  block: DocxImage, index: number, ctx: RenderContext, media: DocxMediaRef[],
): Chunk {
  ctx.bump('image-dropped');
  const target = block.relId === null ? undefined : ctx.opts.rels.get(block.relId);
  const name = target === undefined || target === '' ? null : basename(target);
  const entry = target === undefined || target === ''
    ? undefined
    : ctx.opts.mediaEntries.find((e) => e.name === mediaEntryName(target));

  media.push({
    blockIndex: index,
    relId: block.relId,
    contentType: null,
    name: entry?.name ?? (target === undefined || target === '' ? null : mediaEntryName(target)),
    declaredBytes: entry?.declaredBytes ?? 0,
  });
  return { text: `![image omitted: ${escapeMarkdown(name ?? 'image')}]()`, listItem: false };
}

const CORE_PROP_ORDER = ['title', 'creator', 'created', 'modified'];

function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9 ._@/+-]*$/.test(value) && !/\s$/.test(value)) return value;
  return JSON.stringify(value);
}

function renderFrontmatter(coreProps: Record<string, string> | null): string | null {
  if (coreProps === null) return null;
  const keys = [
    ...CORE_PROP_ORDER.filter((k) => k in coreProps),
    ...Object.keys(coreProps).filter((k) => !CORE_PROP_ORDER.includes(k)).sort(),
  ];
  const lines: string[] = [];
  for (const key of keys) {
    const value = coreProps[key];
    if (typeof value !== 'string' || value.trim() === '') continue;
    lines.push(`  ${key}: ${yamlScalar(value)}`);
  }
  if (lines.length === 0) return null;
  return ['---', 'docx:', ...lines, '---'].join('\n');
}

interface WarningSpec { code: DocxWarningCode; message: (n: number) => string }

const WARNING_SPECS: WarningSpec[] = [
  {
    code: 'image-dropped',
    message: (n) => `${n} image${n === 1 ? '' : 's'} ${n === 1 ? 'was' : 'were'} not imported. `
      + 'A placeholder marks each position; re-add the images to the entry after import.',
  },
  {
    code: 'equation-dropped',
    message: (n) => `${n} equation${n === 1 ? '' : 's'} could not be converted and `
      + `${n === 1 ? 'was' : 'were'} dropped. Re-enter them after import.`,
  },
  {
    code: 'formatting-dropped',
    message: (n) => `Underline, highlight and superscript/subscript formatting was removed from `
      + `${n} text run${n === 1 ? '' : 's'}. Markdown cannot express it; the text itself was kept.`,
  },
  {
    code: 'comments-dropped',
    message: (n) => `${n} comment${n === 1 ? '' : 's'} ${n === 1 ? 'was' : 'were'} not imported. `
      + 'Word comments are not part of the document text.',
  },
  {
    code: 'field-dropped',
    message: (n) => `${n} Word field${n === 1 ? '' : 's'} (table of contents, cross-reference, `
      + 'page number) had no importable text and were dropped.',
  },
  {
    code: 'table-flattened',
    message: (n) => `${n} table${n === 1 ? '' : 's'} used merged cells, which Markdown tables `
      + 'cannot express. The cells were flattened into a plain grid; check them after import.',
  },
  {
    code: 'textbox-dropped',
    message: (n) => `${n} text box${n === 1 ? '' : 'es'} ${n === 1 ? 'was' : 'were'} dropped, `
      + 'because where the text belongs in the reading order is ambiguous.',
  },
  {
    code: 'symbol-dropped',
    message: (n) => `${n} symbol character${n === 1 ? '' : 's'} (Wingdings or similar) `
      + `${n === 1 ? 'was' : 'were'} dropped.`,
  },
  {
    code: 'no-headings',
    message: () => 'No headings were found, so this file will import as a single entry. '
      + 'Add Heading styles in Word, or split the entry after import.',
  },
];

export function convertDocument(doc: DocxDocument, opts: ConvertOptions): ConvertResult {
  const counts = new Map<DocxWarningCode, number>();
  const bump = (code: DocxWarningCode, n = 1): void => {
    if (n <= 0) return;
    counts.set(code, (counts.get(code) ?? 0) + n);
  };

  const media: DocxMediaRef[] = [];
  const ctx: RenderContext = { opts, bump, footnoteOrder: [] };
  const tally = { headings: 0 };
  const chunks: Chunk[] = [];

  doc.blocks.forEach((block: DocxBlock, index) => {
    switch (block.kind) {
      case 'paragraph': {
        const chunk = renderParagraph(block, index, ctx, tally);
        if (chunk !== null) chunks.push(chunk);
        break;
      }
      case 'table': {
        const chunk = renderTable(block, ctx);
        if (chunk !== null) chunks.push(chunk);
        break;
      }
      case 'image':
        chunks.push(renderImage(block, index, ctx, media));
        break;
      case 'equation':
        bump('equation-dropped');
        break;
      case 'textbox':
        bump('textbox-dropped');
        break;
      default:
        break;
    }
  });

  bump('comments-dropped', doc.counters.commentsDropped);
  bump('field-dropped', doc.counters.fieldsDropped);
  bump('symbol-dropped', doc.counters.symbolsDropped);
  if (tally.headings === 0) bump('no-headings');

  const warnings: DocxWarning[] = [];
  const { insertionsKept, deletionsDropped } = doc.counters;
  if (insertionsKept > 0 || deletionsDropped > 0) {
    warnings.push({
      code: 'tracked-changes-applied',
      message: `Tracked changes were applied as Word displays them: ${insertionsKept} `
        + `insertion${insertionsKept === 1 ? '' : 's'} kept, ${deletionsDropped} `
        + `deletion${deletionsDropped === 1 ? '' : 's'} dropped.`,
      count: insertionsKept + deletionsDropped,
    });
  }
  for (const spec of WARNING_SPECS) {
    const n = counts.get(spec.code) ?? 0;
    if (n > 0) warnings.push({ code: spec.code, message: spec.message(n), count: n });
  }

  const body: string[] = [];
  chunks.forEach((chunk, i) => {
    if (i > 0) body.push(chunks[i - 1].listItem && chunk.listItem ? '\n' : '\n\n');
    body.push(chunk.text);
  });

  const definitions = ctx.footnoteOrder
    .filter((id) => opts.footnotes.has(id))
    .map((id) => `[^${id}]: ${escapeLineStarts(escapeMarkdown(opts.footnotes.get(id) ?? ''))}`);

  const sections = [renderFrontmatter(opts.coreProps), body.join(''), definitions.join('\n\n')]
    .filter((s): s is string => s !== null && s !== '');

  return {
    markdown: sections.length === 0 ? '' : `${sections.join('\n\n')}\n`,
    warnings,
    media,
  };
}

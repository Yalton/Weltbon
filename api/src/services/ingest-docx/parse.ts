import { SaxesParser } from 'saxes';
import { BatchLimitError } from '../ingest-zip.js';
import { DocxFormatError } from './unpack.js';
import type { DocxLimits, DocxWorkBudget } from './limits.js';

export type DocxRun = {
  text: string;
  bold: boolean; italic: boolean; strike: boolean; underline: boolean;
  caps: boolean; highlight: boolean;
  vertAlign: 'baseline' | 'superscript' | 'subscript';
  sizeHalfPoints: number | null;
  hyperlink: { relId: string | null; anchor: string | null } | null;
  footnoteRef: string | null;
  lineBreak: boolean;
  tab: boolean;
};
export interface DocxParagraph {
  kind: 'paragraph';
  styleId: string | null;
  outlineLvl: number | null;
  indentTwips?: number | null;
  numbering: { numId: string; ilvl: number } | null;
  runs: DocxRun[];
}
export interface DocxTable {
  kind: 'table';
  rows: Array<Array<{ runs: DocxRun[] }>>;
  hasMergedCells: boolean;
}
export interface DocxImage { kind: 'image'; relId: string | null }
export interface DocxEquation { kind: 'equation' }
export interface DocxTextbox { kind: 'textbox' }
export type DocxBlock = DocxParagraph | DocxTable | DocxImage | DocxEquation | DocxTextbox;
export interface DocxCounters {
  insertionsKept: number; deletionsDropped: number; commentsDropped: number;
  fieldsDropped: number; symbolsDropped: number;
}
export interface DocxDocument { blocks: DocxBlock[]; counters: DocxCounters }

export function rejectDoctype(xml: string): void {
  //   1. A fixed 4096-char window. Nothing bounds a prolog's length — comments,
  //   2. `xml.search(/<[A-Za-z_:]/)` to find the root element. A plain string
  //      search has no idea what a comment is, so `<!-- pad <Az -->` was read as
  let i = 0;
  for (;;) {
    // `/\s/` is deliberate rather than a hand-rolled " \t\n\r" test: in
    while (i < xml.length && /\s/.test(xml[i])) i += 1;

    // Every give-up below is safe for the same reason: the input is malformed,
    if (i >= xml.length) return;          // no root element at all
    if (xml[i] !== '<') return;           // stray text before the root
    if (xml.startsWith('<!--', i)) {
      const end = xml.indexOf('-->', i + 4);
      if (end === -1) return;             // unterminated comment
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<?', i)) {        // includes the XML declaration
      const end = xml.indexOf('?>', i + 2);
      if (end === -1) return;             // unterminated PI
      i = end + 2;
      continue;
    }
    // produce entity-free XML — so there is no legitimate document this turns
    if (xml.startsWith('<!', i)) {
      throw new DocxFormatError('Not a valid .docx (unsupported XML construct)');
    }
    return;                               // root element start tag: prolog over
  }
}

interface RunFormat {
  bold: boolean; italic: boolean; strike: boolean; underline: boolean;
  caps: boolean; highlight: boolean;
  vertAlign: DocxRun['vertAlign'];
  sizeHalfPoints: number | null;
}

function blankFormat(): RunFormat {
  return {
    bold: false, italic: false, strike: false, underline: false,
    caps: false, highlight: false, vertAlign: 'baseline', sizeHalfPoints: null,
  };
}

function attr(attrs: Record<string, string>, name: string): string | null {
  const value = attrs[name] as string | undefined;
  return value === undefined ? null : value;
}

function intOrNull(value: string | null): number | null {
  if (value === null) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function isOn(attrs: Record<string, string>): boolean {
  const v = attr(attrs, 'w:val');
  return v === null || !(v === '0' || v === 'false' || v === 'off');
}

const SUPPRESSORS = new Set(['w:del', 'w:moveFrom', 'w:txbxContent']);

export function parseDocumentXml(
  xml: string,
  limits: DocxLimits,
  batchBudget?: DocxWorkBudget,
): DocxDocument {
  rejectDoctype(xml);

  const blocks: DocxBlock[] = [];
  const counters: DocxCounters = {
    insertionsKept: 0, deletionsDropped: 0, commentsDropped: 0,
    fieldsDropped: 0, symbolsDropped: 0,
  };

  let depth = 0;
  let charged = 0;

  const suppressAt: number[] = [];
  const suppressed = () => suppressAt.length > 0;

  // self-closing tag can never pop the wrong one. Stacks rather than single
  const paras: Array<{ para: DocxParagraph; depth: number }> = [];
  const tables: Array<{ table: DocxTable; depth: number }> = [];
  const rows: Array<{ row: Array<{ runs: DocxRun[] }>; depth: number }> = [];
  const cells: Array<{ cell: { runs: DocxRun[] }; depth: number }> = [];
  const links: Array<{ relId: string | null; anchor: string | null; depth: number }> = [];

  let fmt: RunFormat | null = null;
  let runDepth = -1;
  let pendingText = '';
  let captureDepth = -1;
  let image: { block: DocxImage; depth: number } | null = null;

  let inNumPr = false;
  let numId: string | null = null;
  let ilvl: number | null = null;

  const top = <T>(stack: T[]): T | null => (stack.length === 0 ? null : stack[stack.length - 1]);

  function charge(): void {
    charged += 1;
    if (charged > limits.docxBlockCount) {
      throw new DocxFormatError(
        `Not a valid .docx (docx_block_count max ${limits.docxBlockCount}; `
        + 'simplify or split the document)',
      );
    }
    if (batchBudget !== undefined) {
      batchBudget.used += 1;
      if (batchBudget.used > batchBudget.max) {
        throw new BatchLimitError('docx_batch_block_count', batchBudget.max);
      }
    }
  }

  function pushBlock<T extends DocxBlock>(block: T): T {
    if (suppressed()) return block;
    charge();
    blocks.push(block);
    return block;
  }

  function runTarget(): DocxRun[] | null {
    if (suppressed()) return null;
    const cell = top(cells);
    if (cell !== null) return cell.cell.runs;
    const para = top(paras);
    if (para !== null) return para.para.runs;
    return null;
  }

  function emitRun(text: string, extra: Partial<DocxRun>): void {
    const target = runTarget();
    if (target === null) return;
    charge();
    const f = fmt ?? blankFormat();
    const link = top(links);
    target.push({
      text,
      bold: f.bold, italic: f.italic, strike: f.strike, underline: f.underline,
      caps: f.caps, highlight: f.highlight,
      vertAlign: f.vertAlign, sizeHalfPoints: f.sizeHalfPoints,
      hyperlink: link === null ? null : { relId: link.relId, anchor: link.anchor },
      footnoteRef: null, lineBreak: false, tab: false,
      ...extra,
    });
  }

  function flushText(): void {
    if (pendingText === '') return;
    const text = pendingText;
    pendingText = '';
    emitRun(text, {});
  }

  const parser = new SaxesParser({ xmlns: false });

  // and a truncated document.xml would parse to a plausible-looking prefix.
  parser.on('error', () => {
    throw new DocxFormatError('Not a valid .docx (malformed XML)');
  });

  parser.on('text', (chunk) => {
    if (captureDepth >= 0) pendingText += chunk;
  });
  parser.on('cdata', (chunk) => {
    if (captureDepth >= 0) pendingText += chunk;
  });

  parser.on('opentag', (tag) => {
    depth += 1;
    if (depth > limits.docxXmlDepth) {
      throw new DocxFormatError('Not a valid .docx (XML nesting too deep)');
    }

    const name = tag.name;
    const attrs = tag.attributes;

    switch (name) {
      case 'w:ins': counters.insertionsKept += 1; break;
      case 'w:del': counters.deletionsDropped += 1; break;
      case 'w:commentRangeStart': counters.commentsDropped += 1; break;
      case 'w:fldSimple':
      case 'w:instrText': counters.fieldsDropped += 1; break;
      case 'w:sym': counters.symbolsDropped += 1; break;
      default: break;
    }

    if (name === 'w:txbxContent') pushBlock<DocxTextbox>({ kind: 'textbox' });
    if (SUPPRESSORS.has(name)) suppressAt.push(depth);

    switch (name) {
      case 'w:p':
        if (top(cells) === null) {
          paras.push({
            para: pushBlock<DocxParagraph>({
              kind: 'paragraph', styleId: null, outlineLvl: null, indentTwips: null,
              numbering: null, runs: [],
            }),
            depth,
          });
        }
        break;

      case 'w:pStyle': {
        const para = top(paras);
        if (para !== null) para.para.styleId = attr(attrs, 'w:val');
        break;
      }
      case 'w:outlineLvl': {
        const para = top(paras);
        if (para !== null) para.para.outlineLvl = intOrNull(attr(attrs, 'w:val'));
        break;
      }
      case 'w:ind': {
        const para = top(paras);
        if (para !== null) {
          const left = intOrNull(attr(attrs, 'w:left'))
            ?? intOrNull(attr(attrs, 'w:start')) ?? 0;
          // First-line indents are common in prose; only the paragraph's
          // whole-line offset can indicate an outline depth.
          para.para.indentTwips = Math.max(0, left);
        }
        break;
      }
      case 'w:numPr':
        inNumPr = true;
        numId = null;
        ilvl = null;
        break;
      case 'w:ilvl': if (inNumPr) ilvl = intOrNull(attr(attrs, 'w:val')); break;
      case 'w:numId': if (inNumPr) numId = attr(attrs, 'w:val'); break;

      case 'w:tbl':
        tables.push({
          table: pushBlock<DocxTable>({ kind: 'table', rows: [], hasMergedCells: false }),
          depth,
        });
        break;
      // that nest inside a single top-level block, so without this a table is
      case 'w:tr': {
        const table = top(tables);
        if (table !== null) {
          const row: Array<{ runs: DocxRun[] }> = [];
          table.table.rows.push(row);
          rows.push({ row, depth });
          charge();
        }
        break;
      }
      case 'w:tc': {
        const row = top(rows);
        if (row !== null) {
          const cell = { runs: [] as DocxRun[] };
          row.row.push(cell);
          cells.push({ cell, depth });
          charge();
        }
        break;
      }
      case 'w:gridSpan': {
        const table = top(tables);
        const span = intOrNull(attr(attrs, 'w:val'));
        if (table !== null && (span === null || span > 1)) table.table.hasMergedCells = true;
        break;
      }
      case 'w:vMerge': {
        const table = top(tables);
        if (table !== null) table.table.hasMergedCells = true;
        break;
      }

      case 'w:r':
        fmt = blankFormat();
        runDepth = depth;
        pendingText = '';
        break;

      case 'w:t':
      case 'w:delText':
        captureDepth = depth;
        break;

      // Guarded on an open run: w:tab also appears in w:pPr/w:tabs as a tab-stop
      case 'w:br': if (fmt !== null) { flushText(); emitRun('', { lineBreak: true }); } break;
      case 'w:tab': if (fmt !== null) { flushText(); emitRun('', { tab: true }); } break;
      case 'w:footnoteReference':
      case 'w:endnoteReference':
        if (fmt !== null) {
          flushText();
          emitRun('', { footnoteRef: attr(attrs, 'w:id') });
        }
        break;

      case 'w:hyperlink':
        links.push({ relId: attr(attrs, 'r:id'), anchor: attr(attrs, 'w:anchor'), depth });
        break;

      // Run properties. Only w:sz, not w:szCs: the complex-script size is a
      case 'w:b':
      case 'w:bCs': if (fmt !== null && isOn(attrs)) fmt.bold = true; break;
      case 'w:i':
      case 'w:iCs': if (fmt !== null && isOn(attrs)) fmt.italic = true; break;
      case 'w:strike':
      case 'w:dstrike': if (fmt !== null && isOn(attrs)) fmt.strike = true; break;
      // w:u and w:highlight are value-typed, not on/off: "none" is the off state.
      case 'w:u': if (fmt !== null && attr(attrs, 'w:val') !== 'none') fmt.underline = true; break;
      case 'w:highlight':
        if (fmt !== null && attr(attrs, 'w:val') !== 'none') fmt.highlight = true;
        break;
      // consumer that uppercases small-caps text would corrupt it.
      case 'w:caps': if (fmt !== null && isOn(attrs)) fmt.caps = true; break;
      case 'w:sz': if (fmt !== null) fmt.sizeHalfPoints = intOrNull(attr(attrs, 'w:val')); break;
      case 'w:vertAlign': {
        const v = attr(attrs, 'w:val');
        if (fmt !== null && (v === 'superscript' || v === 'subscript' || v === 'baseline')) {
          fmt.vertAlign = v;
        }
        break;
      }

      case 'w:drawing':
        image = { block: pushBlock<DocxImage>({ kind: 'image', relId: null }), depth };
        break;
      case 'a:blip': {
        const rel = attr(attrs, 'r:embed') ?? attr(attrs, 'r:link');
        if (image !== null && rel !== null) image.block.relId = rel;
        break;
      }
      case 'v:imagedata': {
        const rel = attr(attrs, 'r:id');
        if (image !== null) image.block.relId = rel;
        else pushBlock<DocxImage>({ kind: 'image', relId: rel });
        break;
      }

      case 'm:oMath':
        pushBlock<DocxEquation>({ kind: 'equation' });
        break;

      default: break;
    }
  });

  parser.on('closetag', (tag) => {
    const name = tag.name;

    switch (name) {
      case 'w:r':
        if (runDepth === depth) {
          flushText();
          fmt = null;
          runDepth = -1;
        }
        break;
      case 'w:t':
      case 'w:delText':
        if (captureDepth === depth) captureDepth = -1;
        break;
      case 'w:numPr': {
        const para = top(paras);
        // ilvl defaults to 0: Word omits it for a top-level list item, and a
        if (para !== null && numId !== null) {
          para.para.numbering = { numId, ilvl: ilvl ?? 0 };
        }
        inNumPr = false;
        numId = null;
        ilvl = null;
        break;
      }
      case 'w:p': if (top(paras)?.depth === depth) paras.pop(); break;
      case 'w:tbl': if (top(tables)?.depth === depth) tables.pop(); break;
      case 'w:tr': if (top(rows)?.depth === depth) rows.pop(); break;
      case 'w:tc': if (top(cells)?.depth === depth) cells.pop(); break;
      case 'w:hyperlink': if (top(links)?.depth === depth) links.pop(); break;
      case 'w:drawing': if (image?.depth === depth) image = null; break;
      default: break;
    }

    if (top(suppressAt) === depth) suppressAt.pop();
    depth -= 1;
  });

  parser.write(xml).close();

  return { blocks, counters };
}

/**
 * Issue #35 (DOCX-06) — stream word/document.xml into a small document model.
 *
 * Separate from unpack.ts because the attacks are separate. unpack.ts bounds
 * BYTES: entry counts, per-part and total uncompressed size. None of those caps
 * can see a billion-laughs payload, because a 500-byte document.xml that
 * expands to gigabytes is, at the zip layer, a 500-byte part. It never trips a
 * single archive cap. The defenses that matter here are all XML-layer, and they
 * need no archive at all to exercise — which is why the tests for this module
 * build no zips.
 *
 * ENTITY REJECTION IS CATEGORICAL, AND HAPPENS BEFORE THE PARSER RUNS.
 * See rejectDoctype(). It scans the WHOLE prolog — everything up to the root
 * start tag — not a fixed-size prefix of it. The prolog is unbounded: comments,
 * processing instructions and whitespace may all precede the DOCTYPE, so any
 * fixed window is padded past trivially. Do not replace this with an expansion
 * budget, and do not move it onto the parser's `doctype` event: both let the
 * parser start work on a payload whose entire cost is in the work.
 *
 * It is worth being precise about what this defense does and does not rest on.
 * saxes 6 happens to capture a DOCTYPE's internal subset as opaque text without
 * ever populating its entity table, so a reference to a declared entity fails as
 * "undefined entity" rather than expanding. That is a property of the vendor
 * parser, it is undocumented, and no test of ours pins it — so it is a backstop,
 * not the mechanism. A saxes upgrade or a parser swap could remove it silently.
 * rejectDoctype() is what must hold.
 *
 * DELETIONS ARE DROPPED HERE, NOT DOWNSTREAM. w:delText never reaches the
 * output at all, so no consumer can forget to filter it. The failure mode this
 * prevents is quiet and expensive: someone's deleted draft imported as live
 * prose reads perfectly well, and would survive review.
 *
 * TABLE CELLS HOLD RUNS, NOT BLOCKS. GFM cells cannot carry block content, so a
 * cell-of-blocks model would only be flattened later. Flattening at parse time
 * keeps one representation instead of two that must agree.
 */
import { SaxesParser } from 'saxes';
import { DocxFormatError } from './unpack.js';
import type { DocxLimits } from './limits.js';

/**
 * A type alias, not an interface, and deliberately so: an interface gets no
 * implicit index signature, so `run as Record<string, unknown>` — how the tests
 * read a flag generically — is rejected as a non-overlapping cast. A type alias
 * is otherwise identical here and keeps that idiom available to consumers.
 */
export type DocxRun = {
  text: string;
  bold: boolean; italic: boolean; strike: boolean; underline: boolean;
  caps: boolean; highlight: boolean;
  vertAlign: 'baseline' | 'superscript' | 'subscript';
  sizeHalfPoints: number | null;
  hyperlink: { relId: string | null; anchor: string | null } | null;
  footnoteRef: number | null;
  lineBreak: boolean;
  tab: boolean;
};
export interface DocxParagraph {
  kind: 'paragraph';
  styleId: string | null;
  outlineLvl: number | null;
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

/**
 * T-35-02 / T-35-06. Categorical rejection, checked on the raw string BEFORE
 * any parser sees it.
 *
 * saxes does not resolve external entities, so file:// and http:// SYSTEM ids
 * are already inert — but a DOCTYPE with *internal* entities is still a pure
 * CPU/memory expansion vector, and that one saxes would happily expand. Rather
 * than tune a budget for it, we refuse the construct: Word, Google Docs, Pages
 * and LibreOffice all emit entity-free XML, so there is no legitimate document
 * this turns away.
 *
 * A string scan rather than the parser's `doctype` event because the parser
 * must never begin: by the time a doctype handler could fire, a sufficiently
 * nested payload has already been read, and the point of the defense was to not
 * pay for it.
 *
 * The cost if this reasoning is wrong is a refused file from some exotic
 * generator, surfaced as a clear 400 — not silence, and not corruption.
 */
function rejectDoctype(xml: string): void {
  // The scan is bounded by the PROLOG, not by a byte count. A DTD is only legal
  // before the root element, so a match after it is ordinary text — a document
  // that happens to discuss DOCTYPEs in its prose — and not ours to refuse.
  //
  // This was a fixed 4096-char window and that was wrong: nothing bounds the
  // prolog's length. `<!-- 5000 chars of padding -->` then the DOCTYPE, or a
  // long processing instruction, or plain whitespace, all push the construct
  // past any fixed offset, and a window can also be straddled so the literal
  // spans its edge. Every one of those parsed cleanly. Do not reintroduce a
  // byte cap here "for performance": the search below stops at the first
  // element start tag, which in a real document is within the first ~100 bytes.
  //
  // `<[A-Za-z_:]` is exactly the root start tag: a name may begin with a letter,
  // an underscore or a colon, while `<!DOCTYPE`, `<!--` and `<?` all begin with
  // a character the class excludes. So the boundary lands on the root element
  // and nowhere earlier.
  const rootAt = xml.search(/<[A-Za-z_:]/);
  const prolog = rootAt === -1 ? xml : xml.slice(0, rootAt);
  if (/<!DOCTYPE/i.test(prolog) || /<!ENTITY/i.test(prolog)) {
    throw new DocxFormatError('Not a valid .docx (unsupported XML construct)');
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

/**
 * tsconfig has no noUncheckedIndexedAccess, so a bare `attrs['w:val']` is typed
 * `string` while being `undefined` at runtime for an absent attribute. Every
 * attribute read goes through here so that lie is told in exactly one place.
 */
function attr(attrs: Record<string, string>, name: string): string | null {
  const value = attrs[name] as string | undefined;
  return value === undefined ? null : value;
}

function intOrNull(value: string | null): number | null {
  if (value === null) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * OOXML on/off attributes: the element alone means on, and an explicit
 * w:val="0"/"false"/"off" means off. Treating a bare <w:b/> as off would silently
 * lose all bold in documents from writers that omit the attribute (most of them).
 */
function isOn(attrs: Record<string, string>): boolean {
  const v = attr(attrs, 'w:val');
  return v === null || !(v === '0' || v === 'false' || v === 'off');
}

/**
 * Elements that suppress everything inside them. w:del and w:moveFrom are the
 * halves of tracked changes that represent text the author removed;
 * w:txbxContent is a text box, which is emitted as one opaque block rather than
 * inlined because its content is positioned, not part of the reading order.
 */
const SUPPRESSORS = new Set(['w:del', 'w:moveFrom', 'w:txbxContent']);

export function parseDocumentXml(xml: string, limits: DocxLimits): DocxDocument {
  rejectDoctype(xml);

  const blocks: DocxBlock[] = [];
  const counters: DocxCounters = {
    insertionsKept: 0, deletionsDropped: 0, commentsDropped: 0,
    fieldsDropped: 0, symbolsDropped: 0,
  };

  let depth = 0;
  let blockCount = 0;

  /**
   * THE suppression stack. Each entry is the depth of an open suppressing
   * element; a frame is popped when the close event arrives at that same depth,
   * which is what makes self-closing and mis-ordered tags harmless.
   *
   * Suppression is enforced at exactly two places — pushBlock() and
   * runTarget() — and nowhere else. In particular, text inside w:delText is
   * still *captured* by the text handler and still flows into emitRun(); it is
   * this stack that discards it. That is deliberate: if delText were simply
   * never captured, every deletion test would pass with the stack ripped out.
   */
  const suppressAt: number[] = [];
  const suppressed = () => suppressAt.length > 0;

  // Open containers, each paired with the depth that opened it so a stray or
  // self-closing tag can never pop the wrong one. Stacks rather than single
  // slots because a text box (suppressed, but still tracked) nests paragraphs
  // inside paragraphs, and a table can nest inside a cell.
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

  /**
   * Bounds CPU on valid-but-pathological input (T-35-04): a document with no
   * anomalous byte count at all can still carry a million empty paragraphs.
   * A suppressed block is built (its object is still needed as a container) but
   * never published, and so never spends budget.
   */
  function pushBlock<T extends DocxBlock>(block: T): T {
    if (suppressed()) return block;
    blockCount += 1;
    if (blockCount > limits.docxBlockCount) {
      throw new DocxFormatError('Not a valid .docx (too many blocks)');
    }
    blocks.push(block);
    return block;
  }

  /** Where a run lands, or null if it lands nowhere. Cells win over paragraphs
   *  because a cell's paragraphs are flattened into the cell. */
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

  /**
   * Emitted as a marker run rather than folded into a flag on the surrounding
   * run: a run may legitimately be text-break-text, and `runs` is ordered, so a
   * flag on one run could not say which side the break fell on.
   */
  function flushText(): void {
    if (pendingText === '') return;
    const text = pendingText;
    pendingText = '';
    emitRun(text, {});
  }

  const parser = new SaxesParser({ xmlns: false });

  // The parser reports malformed input rather than throwing, so this handler is
  // what turns it into a refusal. Without it, saxes recovers and keeps going,
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

    // Counters are diagnostics about what the FILE contained, so they are taken
    // before suppression is consulted: a deletion inside a text box is still a
    // deletion we dropped.
    switch (name) {
      case 'w:ins': counters.insertionsKept += 1; break;
      case 'w:del': counters.deletionsDropped += 1; break;
      case 'w:commentRangeStart': counters.commentsDropped += 1; break;
      case 'w:fldSimple':
      case 'w:instrText': counters.fieldsDropped += 1; break;
      case 'w:sym': counters.symbolsDropped += 1; break;
      default: break;
    }

    // One block for the whole text box; the frame below then keeps its
    // paragraphs out of the reading order. Pushed BEFORE the frame, or it would
    // suppress itself.
    if (name === 'w:txbxContent') pushBlock<DocxTextbox>({ kind: 'textbox' });
    if (SUPPRESSORS.has(name)) suppressAt.push(depth);

    switch (name) {
      case 'w:p':
        // A paragraph inside a cell contributes runs to that cell, not a block.
        if (top(cells) === null) {
          paras.push({
            para: pushBlock<DocxParagraph>({
              kind: 'paragraph', styleId: null, outlineLvl: null, numbering: null, runs: [],
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
      case 'w:numPr':
        inNumPr = true;
        numId = null;
        ilvl = null;
        break;
      // Guarded on inNumPr: w:ilvl and w:numId are not unique to numbering
      // properties, and a stray one must not invent a list.
      case 'w:ilvl': if (inNumPr) ilvl = intOrNull(attr(attrs, 'w:val')); break;
      case 'w:numId': if (inNumPr) numId = attr(attrs, 'w:val'); break;

      case 'w:tbl':
        tables.push({
          table: pushBlock<DocxTable>({ kind: 'table', rows: [], hasMergedCells: false }),
          depth,
        });
        break;
      case 'w:tr': {
        const table = top(tables);
        if (table !== null) {
          const row: Array<{ runs: DocxRun[] }> = [];
          table.table.rows.push(row);
          rows.push({ row, depth });
        }
        break;
      }
      case 'w:tc': {
        const row = top(rows);
        if (row !== null) {
          const cell = { runs: [] as DocxRun[] };
          row.row.push(cell);
          cells.push({ cell, depth });
        }
        break;
      }
      // Recorded as a flag rather than modelled: GFM has no merged cells, so the
      // only decision downstream can make is whether to warn.
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

      // w:delText is captured exactly like w:t on purpose — see the suppression
      // stack's comment. Dropping it here instead would make the deletion tests
      // pass with the stack removed.
      case 'w:t':
      case 'w:delText':
        captureDepth = depth;
        break;

      // Guarded on an open run: w:tab also appears in w:pPr/w:tabs as a tab-stop
      // definition, which is layout, not content.
      case 'w:br': if (fmt !== null) { flushText(); emitRun('', { lineBreak: true }); } break;
      case 'w:tab': if (fmt !== null) { flushText(); emitRun('', { tab: true }); } break;
      case 'w:footnoteReference':
      case 'w:endnoteReference':
        if (fmt !== null) {
          flushText();
          emitRun('', { footnoteRef: intOrNull(attr(attrs, 'w:id')) });
        }
        break;

      case 'w:hyperlink':
        links.push({ relId: attr(attrs, 'r:id'), anchor: attr(attrs, 'w:anchor'), depth });
        break;

      // Run properties. Only w:sz, not w:szCs: the complex-script size is a
      // different measurement and letting it overwrite would report the wrong
      // number for any run carrying both.
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
      // w:caps only, not w:smallCaps: caps means "render uppercase", and a
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

      // Images are a placeholder plus a relationship id; the bytes are never
      // decompressed (see unpack.ts), so there is nothing else to carry.
      case 'w:drawing':
        image = { block: pushBlock<DocxImage>({ kind: 'image', relId: null }), depth };
        break;
      case 'a:blip': {
        const rel = attr(attrs, 'r:embed') ?? attr(attrs, 'r:link');
        if (image !== null && rel !== null) image.block.relId = rel;
        break;
      }
      // VML. w:pict itself emits nothing, because a w:pict is just as often a
      // text box as an image — emitting on the wrapper would invent an image
      // block for every text box in the document.
      case 'v:imagedata': {
        const rel = attr(attrs, 'r:id');
        if (image !== null) image.block.relId = rel;
        else pushBlock<DocxImage>({ kind: 'image', relId: rel });
        break;
      }

      // m:oMath, not m:oMathPara: the para wrapper contains the maths, so
      // handling both would emit two blocks for one equation.
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
        // missing level must not throw the numbering away.
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

    // Popped last so the handling above still sees the frame it was written
    // under — a run closing at the end of a w:del is still suppressed.
    if (top(suppressAt) === depth) suppressAt.pop();
    depth -= 1;
  });

  parser.write(xml).close();

  return { blocks, counters };
}

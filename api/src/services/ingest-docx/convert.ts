/**
 * Issue #35 (DOCX-04 / DOCX-05 / DOCX-07) — document model to Markdown.
 *
 * Pure: no archive, no XML, no I/O. Everything this needs about the parts that
 * are not document.xml arrives pre-parsed in ConvertOptions, which is what lets
 * the whole conversion table be tested with hand-built blocks and no fixture.
 *
 * THE DESIGN BIAS IS "SAY WHAT WAS LOST", NOT "MAXIMUM FIDELITY" (spec preamble).
 * A user who can see what did not survive can fix it; a user handed a silently
 * lossy import cannot. So underline is dropped rather than emitted as <u>,
 * equations are dropped rather than approximated, and every drop is counted.
 *
 * WARNINGS AGGREGATE PER CODE. One warning saying "200 images" rather than 200
 * warnings, because the preview renders them in a list a human reads. The
 * counts are running totals collected during the walk and materialised once at
 * the end (see `bump` / `emitWarnings`).
 *
 * ESCAPING IS SINGLE-PASS AND THEREFORE ORDER-FREE — see escapeMarkdown. The
 * hazard it designs out is real and has bitten this kind of code before: a
 * sequential escaper that handles `*` before `\` re-escapes the backslashes it
 * just inserted, and the corrupted output is still valid Markdown, so it
 * renders fine and survives review.
 */
import type {
  DocxBlock, DocxDocument, DocxImage, DocxParagraph, DocxRun, DocxTable,
} from './parse.js';
import { resolveStyledHeading } from './headings.js';
import type { HeadingLevel, StyleIndex } from './headings.js';

export type DocxWarningCode =
  | 'image-dropped' | 'equation-dropped' | 'formatting-dropped'
  | 'tracked-changes-applied' | 'comments-dropped' | 'field-dropped'
  | 'table-flattened' | 'textbox-dropped' | 'symbol-dropped'
  | 'no-headings' | 'unstyled-headings-detected';

export interface DocxWarning { code: DocxWarningCode; message: string; count: number }

/**
 * DOCX-07's manifest row. `declaredBytes` is the central directory's claim and
 * is deliberately NOT called `bytes`: nothing here was decompressed, and a name
 * suggesting otherwise would invite a future reader to trust it as a real size.
 *
 * `contentType` has no source in ConvertOptions today and is therefore always
 * null; `[Content_Types].xml` is unpacked but not parsed on this branch. The
 * field is kept because the spec's manifest shape names it and the seam is
 * where a future extraction change will fill it in.
 */
export interface DocxMediaRef {
  blockIndex: number; relId: string | null; contentType: string | null;
  name: string | null; declaredBytes: number;
}

export interface ConvertOptions {
  styleIndex: StyleIndex;
  /** Block index → level, from the opt-in heuristic. Consulted only where the
   *  deterministic pass resolved nothing; the caller decides whether to run it
   *  at all (headings.ts enforces no such gate itself). */
  promotedHeadings: Map<number, HeadingLevel>;
  /** relId → relationship target, from word/_rels/document.xml.rels. */
  rels: Map<string, string>;
  /** Footnote/endnote `w:id` AS IT APPEARS IN THE XML → note text. Keyed by
   *  string, and looked up with String(run.footnoteRef): the id is an XML
   *  attribute, and a number-keyed map would miss every lookup silently. */
  footnotes: Map<string, string>;
  /** Central-directory rows for word/media/*. No bytes, ever. */
  mediaEntries: Array<{ name: string; declaredBytes: number }>;
  coreProps: Record<string, string> | null;
  /**
   * numId → list format, from numbering.xml's w:numFmt. Optional because the
   * part is not parsed on this branch yet; absent or unknown means bullet,
   * which is what an unresolvable list looks like to a reader either way.
   * DOCX-04 requires the ordered case, so the channel exists rather than the
   * rule being silently unimplementable.
   */
  numberingFormats?: Map<string, 'bullet' | 'ordered'>;
}

export interface ConvertResult {
  markdown: string; warnings: DocxWarning[]; media: DocxMediaRef[];
  styledHeadings: number;
}

/**
 * One pass over the string, so there is no escape ORDER to get wrong.
 *
 * The alternative — a loop of replacements with `\\` handled first — is what
 * the ordering comment in every Markdown escaper is guarding, and it is only
 * correct as long as nobody reorders the list. A single regex pass cannot
 * re-enter its own output at all, so the failure mode is structurally absent
 * rather than commented against. The test that pins `'\\*' -> '\\\\\\*'` still
 * fails against a sequential wrong-order implementation, which is the property
 * that matters.
 *
 * The set is exactly the characters that change block or inline STRUCTURE when
 * this converter emits its own markers around them: `` \ * _ [ ] ` # | ~ ``.
 * `|` is here for table cells and `~` because strikethrough is emitted by us.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_[\]`#|~]/g, (ch) => `\\${ch}`);
}

/** A rendered chunk plus whether it is a list item, which decides whether the
 *  next chunk is separated by one newline (tight list) or two (new block). */
interface Chunk { text: string; listItem: boolean }

const HARD_BREAK = '\\\n';

/**
 * DOCX-04: text preserved, formatting dropped, warned once per document.
 * `caps` is deliberately NOT counted: it is a render directive, the text is
 * emitted exactly as authored, and nothing was lost that a user could act on.
 */
function hasDroppedFormatting(r: DocxRun): boolean {
  return r.underline || r.highlight || r.vertAlign !== 'baseline';
}

function isQuoteStyle(styleId: string | null): boolean {
  return styleId !== null && /^(intense)?quote$/i.test(styleId.replace(/\s+/g, ''));
}

/**
 * Emphasis markers must sit tight against their text: `** bold **` is not
 * emphasis in CommonMark, and Word routinely puts the trailing space of a
 * sentence inside the bold run. Whitespace is therefore hoisted out of the
 * markers rather than left to corrupt them.
 */
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

/**
 * A link destination is untrusted text from the relationships part. Anything
 * with whitespace or brackets in it is wrapped in <...>, which is the only
 * form CommonMark accepts for such a destination; without this a target
 * containing a space silently truncates the link at that space.
 */
function formatDestination(url: string): string {
  if (/[\s<>()]/.test(url)) return `<${url.replace(/([<>\\])/g, '\\$1')}>`;
  return url;
}

function basename(target: string): string {
  const cleaned = target.replace(/[?#].*$/, '');
  const cut = cleaned.lastIndexOf('/');
  return cut === -1 ? cleaned : cleaned.slice(cut + 1);
}

/** Relationship targets are relative to word/, and Word writes them both with
 *  and without that prefix. Normalising here is presentation only — nothing is
 *  opened, so this is not a path-traversal decision (unpack.ts owns that). */
function mediaEntryName(target: string): string {
  const t = target.replace(/^\/+/, '');
  return t.startsWith('word/') ? t : `word/${t}`;
}

interface RenderContext {
  opts: ConvertOptions;
  bump: (code: DocxWarningCode, n?: number) => void;
  /** Footnote ids in order of first reference; definitions follow that order. */
  footnoteOrder: string[];
}

/**
 * Runs → inline Markdown. `singleLine` is set for headings and table cells,
 * where a hard break cannot be expressed and would break the block's syntax.
 *
 * Consecutive runs sharing one hyperlink are merged into a single link. Word
 * splits a hyperlink across runs at every formatting and spellcheck boundary,
 * so one link per run would emit `[We](u)[ltbon](u)` for ordinary documents.
 */
function renderRuns(runs: DocxRun[], ctx: RenderContext, singleLine: boolean): string {
  let out = '';
  let i = 0;
  while (i < runs.length) {
    const link = runs[i].hyperlink;
    const dest = link === null ? null : resolveLink(link, ctx.opts.rels);
    if (link === null || dest === null) {
      out += renderRun(runs[i], ctx, singleLine);
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
  // An external target wins over an anchor: Word writes both on a link into
  // another document, and the anchor alone would point at nothing local.
  if (link.relId !== null) {
    const target = rels.get(link.relId);
    if (target !== undefined && target !== '') {
      return link.anchor === null ? target : `${target}#${link.anchor}`;
    }
  }
  if (link.anchor !== null && link.anchor !== '') return `#${link.anchor}`;
  return null;
}

function renderRun(r: DocxRun, ctx: RenderContext, singleLine: boolean): string {
  if (hasDroppedFormatting(r)) ctx.bump('formatting-dropped');
  if (r.lineBreak) return singleLine ? ' ' : HARD_BREAK;
  if (r.tab) return ' ';
  if (r.footnoteRef !== null) {
    // String(): `footnotes` is keyed by the raw XML w:id. A number key here
    // misses every entry and drops the note with no warning at all.
    const id = String(r.footnoteRef);
    if (!ctx.footnoteOrder.includes(id)) ctx.footnoteOrder.push(id);
    return `[^${id}]`;
  }
  return decorate(escapeMarkdown(r.text), r);
}

function renderParagraph(
  block: DocxParagraph, index: number, ctx: RenderContext,
  counts: { styled: number; headings: number },
): Chunk | null {
  const styled = resolveStyledHeading(block, ctx.opts.styleIndex);
  const level = styled ?? ctx.opts.promotedHeadings.get(index) ?? null;
  if (styled !== null) counts.styled += 1;

  if (level !== null) {
    const text = renderRuns(block.runs, ctx, true).trim();
    if (text === '') return null;
    counts.headings += 1;
    return { text: `${'#'.repeat(level)} ${text}`, listItem: false };
  }

  const body = renderRuns(block.runs, ctx, false);
  if (body.trim() === '') return null;

  if (block.numbering !== null) {
    const format = ctx.opts.numberingFormats?.get(block.numbering.numId) ?? 'bullet';
    // Every ordered item is emitted as "1." rather than a running ordinal:
    // Markdown renumbers on render, so carrying ordinal state would only add
    // reset rules (nesting, interruption, restarts) that can disagree with
    // what the reader finally sees.
    const marker = format === 'ordered' ? '1.' : '-';
    const indent = '  '.repeat(Math.max(0, block.numbering.ilvl));
    return { text: `${indent}${marker} ${body.replace(/\n/g, ' ')}`, listItem: true };
  }

  if (isQuoteStyle(block.styleId)) {
    return { text: body.split('\n').map((l) => `> ${l}`).join('\n'), listItem: false };
  }
  return { text: body, listItem: false };
}

/**
 * GFM cannot express rowspan/colspan, so a merged table is flattened and the
 * user is told. Ragged rows are padded to the header width instead of emitted
 * short, because a short row silently drops its cells in most renderers.
 */
function renderTable(block: DocxTable, ctx: RenderContext): Chunk | null {
  if (block.rows.length === 0) return null;
  if (block.hasMergedCells) ctx.bump('table-flattened');
  const width = Math.max(...block.rows.map((row) => row.length));
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

/**
 * DOCX-07. The destination is empty on purpose: any path we invented would be
 * a broken link the moment someone clicked it. The name comes from the
 * relationship target — uploaded, therefore untrusted — and is escaped like
 * any other run.
 */
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

/**
 * DOCX-01: core properties become a namespaced `docx:` block and NEVER a
 * `title:` key. inferTitle prefers a frontmatter title over the body's first
 * H1, and Word routinely leaves dc:title as a template name like "Document1" —
 * writing it at the top level would let that beat a perfectly good heading.
 *
 * Values are quoted whenever an unquoted YAML scalar would be ambiguous.
 * core.xml is uploaded content, so a title of `a: b` must not be able to
 * restructure the frontmatter of the entry it lands in.
 */
const CORE_PROP_ORDER = ['title', 'creator', 'created', 'modified'];

function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9 ._@/+-]*$/.test(value) && !/\s$/.test(value)) return value;
  return JSON.stringify(value);
}

function renderFrontmatter(coreProps: Record<string, string> | null): string | null {
  if (coreProps === null) return null;
  const keys = [
    ...CORE_PROP_ORDER.filter((k) => k in coreProps),
    // Anything the caller adds later is preserved rather than silently
    // dropped, in a deterministic order.
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

/** Fixed order so the preview list is stable between runs of the same file. */
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
  const tally = { styled: 0, headings: 0 };
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
      // Equations and text boxes leave no placeholder: unlike an image, there
      // is nothing to re-attach at that position, so the warning is the whole
      // of what we can honestly say.
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
  // NOTE: parse.ts increments fieldsDropped once per w:instrText, and Word
  // splits one field's instructions across several of them — so this count is
  // an upper bound on fields, not an exact tally.
  bump('field-dropped', doc.counters.fieldsDropped);
  bump('symbol-dropped', doc.counters.symbolsDropped);
  if (tally.headings === 0) bump('no-headings');

  const warnings: DocxWarning[] = [];
  // Tracked changes carry two numbers that a single count cannot express, so
  // this one is built by hand rather than from the table above.
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
    .map((id) => `[^${id}]: ${escapeMarkdown(opts.footnotes.get(id) ?? '')}`);

  const sections = [renderFrontmatter(opts.coreProps), body.join(''), definitions.join('\n\n')]
    .filter((s): s is string => s !== null && s !== '');

  return {
    markdown: sections.length === 0 ? '' : `${sections.join('\n\n')}\n`,
    warnings,
    media,
    styledHeadings: tally.styled,
  };
}

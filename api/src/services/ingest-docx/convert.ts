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
  | 'no-headings' | 'unstyled-headings-detected'
  // Informational, emitted by index.ts only (like unstyled-headings-detected):
  // the document HAS styled headings, but far more paragraphs look like
  // headings than there are styled ones. See index.ts for why this exists.
  | 'mixed-headings-detected';

export interface DocxWarning { code: DocxWarningCode; message: string; count: number }

/**
 * DOCX-07's manifest row. `declaredBytes` is the central directory's claim and
 * is deliberately NOT called `bytes`: nothing here was decompressed, and a name
 * suggesting otherwise would invite a future reader to trust it as a real size.
 *
 * `contentType` has no source in ConvertOptions and is therefore always null
 * AS EMITTED HERE. index.ts fills it in from `[Content_Types].xml` after this
 * function returns — that part is a package-level concern (extension defaults
 * plus part-name overrides), and threading it through this pure model→Markdown
 * pass would buy nothing but a second thing to keep in sync. Read the manifest
 * from convertDocx, not from convertDocument, if you want the type populated.
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
  /** Footnote/endnote `w:id` AS IT APPEARS IN THE XML → note text. */
  footnotes: Map<string, string>;
  /** Central-directory rows for word/media/*. No bytes, ever. */
  mediaEntries: Array<{ name: string; declaredBytes: number }>;
  coreProps: Record<string, string> | null;
  /**
   * numId → list format, from numbering.xml's w:numFmt. Wired by index.ts
   * (parseNumbering); optional only so the pure-model tests need not build a
   * numbering table. Absent or unknown means bullet, which is what an
   * unresolvable list looks like to a reader either way.
   */
  numberingFormats?: Map<string, 'bullet' | 'ordered'>;
}

/**
 * No `styledHeadings` here. Counting styled headings means walking the blocks
 * applying resolveStyledHeading, which is headings.ts's predicate, and
 * index.ts must have that number BEFORE this function runs (the DOCX-09
 * promotion gate decides what to pass in `promotedHeadings`). Producing it
 * here as well would be a second walk of the same predicate whose agreement
 * with the first nothing enforces — exactly the shape project documentation warns about.
 * countStyledHeadings() in headings.ts is the single producer.
 */
export interface ConvertResult {
  markdown: string; warnings: DocxWarning[]; media: DocxMediaRef[];
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
 * The set is the characters that change INLINE structure anywhere they appear:
 * `` \ * _ [ ] ` # | ~ < ``. `|` is here for table cells, `~` because
 * strikethrough is emitted by us, and `<` because an html mdast node is
 * DROPPED by a real consumer of entries.body: the PDF export pipeline
 * (services/export/pdf/template.ts) is a bare
 * remarkParse→remarkGfm→remarkRehype→rehypeStringify chain with no
 * allowDangerousHtml, and `<div>note</div>` through it returns the empty
 * string — the word "note" is gone. (The web editor's react-markdown is NOT
 * the consumer that loses it: it disables HTML parsing outright and renders
 * the literal text. The distinction is recorded because the first version of
 * this comment named react-markdown from memory and was wrong.)
 * `>` is NOT here: it is inert mid-line and is handled at line start by
 * escapeLineStarts, which keeps ordinary prose ("a > b") clean.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_[\]`#|~<]/g, (ch) => `\\${ch}`);
}

/**
 * Characters that only mean something at the START of a line, escaped after
 * the inline pass because they need position, not just identity.
 *
 * Every rule here was checked against remark-parse + remark-gfm, and every one
 * of them was a case where the author's text was RESTRUCTURED OR DELETED, not
 * merely restyled:
 *
 *   `---`      thematic break; the text vanishes. As the document's first
 *              line it is worse still — gray-matter (ingest-markdown's
 *              parseFrontmatter) eats it as a frontmatter fence and the entry
 *              body comes out EMPTY.
 *   `- + >`    list item / block quote the author did not write.
 *   `1.` `1)`  ordered list, same.
 *   `===` `--` setext underline: turns the PRECEDING line into a heading.
 *              Reachable inside one paragraph, via a w:br: "Title\" + "===" 
 *              renders as <h1>Title\</h1>.
 *   4+ spaces  indented code block, swallowing the paragraph whole. A tab
 *              counts as four, so it opens one on its own.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO, both because the cost lands in
 * the STORED SOURCE rather than in the rendering:
 *
 * 1. The indent is collapsed to three spaces, not escaped. A space is not
 *    escapable ASCII punctuation; the trick that does work is a numeric
 *    character reference (`&#32;`), and it renders correctly — but entry.body
 *    is edited in a plain textarea (web/src/views/EntryEditor.tsx), so the
 *    user would meet the literal `&#32;` and have to know what it is to
 *    repair their own paragraph. CommonMark only escalates at four, so three
 *    defuses it with no artifact at all. The trade is exact space-count
 *    fidelity, which for incidental Word indentation is not an author-
 *    meaningful signal.
 *
 * 2. `-`, `+` and the ordinal markers are escaped ONLY when whitespace or the
 *    end of the line follows, which is what CommonMark requires of a list
 *    marker. Escaping them unconditionally put a gratuitous backslash into
 *    "1.1 Scope", "2.3.4 Details", "-5 degrees" and "1.5 kg" — numbered
 *    clause headings are ordinary content in exactly the formal documents
 *    this feature exists to ingest. `>` correctly needs no such check: `>x`
 *    is a block quote immediately.
 *
 * Structure characters are tested after up to three leading spaces, because
 * that much indentation does not stop a marker forming a block.
 */
function escapeLineStarts(text: string): string {
  return text.split('\n').map((line) => {
    const split = /^([ \t]*)([\s\S]*)$/.exec(line);
    if (split === null) return line;
    let [, lead, rest] = split;
    if (rest === '') return line;
    if (lead.includes('\t') || lead.length >= 4) lead = '   ';

    // A dash line that is only dashes and spaces is a thematic break or a
    // setext underline, and needs no trailing whitespace to be one.
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

/**
 * A hard break at the END of a block breaks nothing — there is no following
 * line — and CommonMark then renders the backslash as a literal backslash.
 * Word users press Shift+Enter at the end of a line constantly, so this is the
 * common case, not the exotic one.
 */
function stripTrailingBreaks(text: string): string {
  return text.replace(/(?:\\\n)+$/, '');
}

/** Collapse a hard break into a space, backslash included. Dropping only the
 *  newline leaves `a\ b`, and a backslash before a space is not an escape. */
function flattenBreaks(text: string): string {
  return text.replace(/\\\n/g, ' ').replace(/\n/g, ' ');
}

/** A rendered chunk plus whether it is a list item, which decides whether the
 *  next chunk is separated by one newline (tight list) or two (new block). */
interface Chunk { text: string; listItem: boolean }

const HARD_BREAK = '\\\n';

/**
 * DOCX-04: text preserved, formatting dropped, warned once per document.
 * `caps` is NOT counted here because it is APPLIED instead (see renderRun) —
 * nothing is lost, so there is nothing to warn about. It was previously
 * neither applied nor counted, which silently lower-cased headings the author
 * had capitalised.
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
function renderRuns(
  runs: DocxRun[], ctx: RenderContext, singleLine: boolean, plain = false,
): string {
  let out = '';
  let i = 0;
  while (i < runs.length) {
    const link = runs[i].hyperlink;
    const dest = link === null ? null : resolveLink(link, ctx.opts.rels);
    // plain: a link is unwrapped to its text. See renderRun's PLAIN MODE note —
    // `# [The Vale](https://…)` titles the entry `[The Vale](https://…)` and
    // slugs the file `00-the-vale-https-example-com-vale.md`.
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

/**
 * PLAIN MODE — used for heading text, and only for heading text.
 *
 * A heading's inline markup can only ever reach the user as LITERAL TITLE
 * TEXT, so emitting any of it corrupts the title rather than styling it.
 * inferTitle (ingest-markdown.ts) matches /^#\s+(.+?)\s*$/m and returns the
 * raw slice; ingest-split's headingText slices the heading from the SOURCE and
 * strips only the ATX prefix/suffix and a setext underline. Both therefore
 * carry every marker straight into the stored title, and ingest-split then
 * slugs the filename from it. Measured, per marker:
 *
 *   bold        `# **The Vale**`                -> title `**The Vale**`
 *   italic      `# *The Vale*`                  -> title `*The Vale*`
 *   strike      `# ~~The Vale~~`                -> title `~~The Vale~~`
 *   hyperlink   `# [The Vale](https://…)`       -> title `[The Vale](https://…)`,
 *                                                  slug `00-the-vale-https-example-com-vale`
 *   literal `*` `# The \*Vale\*`                -> title `The \*Vale\*`
 *
 * An earlier version of this fix dropped bold only when EVERY run was bold,
 * on the theory that partial emphasis is "a contrast the author drew inside
 * the line". That rationale does not survive contact with the table above:
 * the contrast is invisible in the title either way, and the title is what
 * persists. So plain mode drops emphasis at any coverage and for every
 * marker, unwraps hyperlinks, and skips escapeMarkdown entirely.
 *
 * THE TRADE, ACCEPTED DELIBERATELY: a heading whose text genuinely contains
 * `*` now emits `# The *Vale*`, so the title is right (`The *Vale*`) while
 * the rendered H1 shows that word emphasised. Title correctness dominates —
 * the body H1 is largely redundant with the stored title, whereas a wrong
 * title is permanent, user-visible, and feeds the entry's filename.
 *
 * Line-start escaping is not needed and not applied: the `#` prefix owns the
 * start of the line, so no structure character can begin one.
 *
 * A footnote reference inside a heading is DROPPED rather than emitted as
 * `[^2]` (which would land in the title) and is not registered, so no orphan
 * definition is emitted for it either. Losing a footnote anchored to a
 * heading is a smaller, rarer loss than mistitling every entry that has one.
 */
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
  // w:caps is applied rather than dropped, and deliberately not warned about.
  // Unlike underline it is not formatting Markdown cannot express — it is a
  // transform on the visible text, and the flag is in hand: Word shows
  // "THE VALE", so the entry says THE VALE and nothing is lost. NOT extended
  // to w:smallCaps, which parse.ts does not capture and which has no faithful
  // text equivalent (upper-casing it would corrupt the author's text).
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
    // plain: heading text is emitted as literal text, with no emphasis, no
    // link syntax and no inline escaping — see renderRun's PLAIN MODE note for
    // the measured table of what each marker did to the entry's title.
    // singleLine: a heading cannot contain a line break without ending itself,
    // so a w:br inside one degrades to a space.
    const text = renderRuns(block.runs, ctx, true, true).trim();
    if (text === '') return null;
    counts.headings += 1;
    return { text: `${'#'.repeat(level)} ${text}`, listItem: false };
  }

  const body = stripTrailingBreaks(renderRuns(block.runs, ctx, false));
  if (body.trim() === '') return null;

  if (block.numbering !== null) {
    const format = ctx.opts.numberingFormats?.get(block.numbering.numId) ?? 'bullet';
    // Every ordered item is emitted as "1." rather than a running ordinal:
    // Markdown renumbers on render, so carrying ordinal state would only add
    // reset rules (nesting, interruption, restarts) that can disagree with
    // what the reader finally sees.
    const marker = format === 'ordered' ? '1.' : '-';
    // Indent by the MARKER's width, not a flat two spaces: a nested "1." at
    // two spaces is not nested at all — remark flattens it into one list and
    // the author's outline is gone. (DOCX-04 says both "1." and "two-space
    // indent"; those are incompatible, and preserving the outline is the
    // point of the rule.)
    const indent = (marker === '-' ? '  ' : '   ').repeat(Math.max(0, block.numbering.ilvl));
    // Escaped AFTER flattening, because flattening is what puts the item's
    // second line at the start of a line for the first time.
    return { text: `${indent}${marker} ${escapeLineStarts(flattenBreaks(body))}`, listItem: true };
  }

  // Line starts are escaped before our own markers go on, so a quote's "> "
  // and a list's "- " are the only structure characters left unescaped.
  const escaped = escapeLineStarts(body);
  if (isQuoteStyle(block.styleId)) {
    return { text: escaped.split('\n').map((l) => `> ${l}`).join('\n'), listItem: false };
  }
  return { text: escaped, listItem: false };
}

/**
 * GFM cannot express rowspan/colspan, so a merged table is flattened and the
 * user is told. Ragged rows are padded to the header width instead of emitted
 * short, because a short row silently drops its cells in most renderers.
 */
function renderTable(block: DocxTable, ctx: RenderContext): Chunk | null {
  if (block.rows.length === 0) return null;
  if (block.hasMergedCells) ctx.bump('table-flattened');
  // A reduce, NOT `Math.max(...rows.map(...))`. A spread past ~125 000
  // arguments is a hard V8 RangeError ("Maximum call stack size exceeded"),
  // and the route has no branch for that, so a 1 678-byte .docx holding
  // 130 000 rows left as a 500 instead of DOCX-11's 400. parse.ts now charges
  // rows and cells against docxBlockCount so such a table is refused upstream,
  // but this must not depend on that: convertDocument is exported and is
  // driven directly with hand-built models by most of its tests, and a width
  // computation that can throw on row count is a bug here whatever the parser
  // does. Do not "simplify" this back into a spread.
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
    .map((id) => `[^${id}]: ${escapeLineStarts(escapeMarkdown(opts.footnotes.get(id) ?? ''))}`);

  const sections = [renderFrontmatter(opts.coreProps), body.join(''), definitions.join('\n\n')]
    .filter((s): s is string => s !== null && s !== '');

  return {
    markdown: sections.length === 0 ? '' : `${sections.join('\n\n')}\n`,
    warnings,
    media,
  };
}

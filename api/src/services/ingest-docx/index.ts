/**
 * Issue #35 (DOCX-02) — convertDocx(). The route's only import.
 *
 * unpack → parse → headings → convert. Everything below this file is either
 * pure or single-purpose; this is where the parts meet, and therefore where
 * three decisions live that no other module is in a position to make.
 *
 * 1. THE PROMOTION GATE (DOCX-09). detectUnstyledHeadings is style-blind: hand
 *    it a paragraph carrying styleId "Heading1" and it will happily rank it as
 *    a bold candidate, because it never asks what the deterministic pass
 *    found. The spec says promotion applies ONLY when that pass found no
 *    headings at all, and this file is the only place that knows both answers.
 *    Getting it wrong is silent: a document that mixes real Heading styles with
 *    incidental bold lines would import with extra section boundaries the
 *    author never wrote, and the user would have no way to tell which headings
 *    were theirs.
 *
 * 2. `unstyled-headings-detected` AND `mixed-headings-detected` ARE EMITTED
 *    HERE, and can only be emitted here. With promotion off, convertDocument
 *    receives an empty promoted map and has nothing to report; the counts that
 *    drive the preview's "treat N bold paragraphs as headings" affordance, and
 *    the mixed-document explanation that replaces it when the gate refuses,
 *    exist only at this layer.
 *
 * 3. EVERY PART THAT IS PARSED GOES THROUGH rejectDoctype (T-35-02). The
 *    billion-laughs defense is not ambient — it applies to a part only where
 *    it is called, and an attacker controls styles.xml, numbering.xml,
 *    core.xml and the rels exactly as much as they control document.xml.
 *    parsePart() below is the single door: no part is handed to a SaxesParser
 *    except through it. (styles.xml is guarded inside headings.ts's
 *    parseRawStyleDefs for the same reason — that is its only parse site.)
 *
 * The part parsers are here rather than in modules of their own because each
 * is a dozen lines of attribute plucking with no behaviour worth isolating,
 * and because keeping them together keeps the "everything goes through
 * parsePart" invariant checkable by reading one file.
 */
import { Buffer } from 'node:buffer';
import { SaxesParser } from 'saxes';
import { unpackDocx, DocxFormatError } from './unpack.js';
import { parseDocumentXml, rejectDoctype } from './parse.js';
import { buildStyleIndex, countStyledHeadings, detectUnstyledHeadings } from './headings.js';
import type { HeadingLevel } from './headings.js';
import { convertDocument } from './convert.js';
import type { DocxMediaRef, DocxWarning } from './convert.js';
import { DOCX_LIMITS } from './limits.js';
import type { DocxLimits, DocxWorkBudget } from './limits.js';

export type { DocxWarning, DocxWarningCode, DocxMediaRef } from './convert.js';
export { DocxFormatError } from './unpack.js';

export interface DocxConversion {
  markdown: string;
  warnings: DocxWarning[];
  media: DocxMediaRef[];
  headings: {
    /** Resolved deterministically, from Heading styles + outlineLvl. */
    styled: number;
    /** What the heuristic WOULD promote — 0 whenever the gate would refuse. */
    unstyledCandidates: number;
    /** Whether it did. */
    promoted: boolean;
  };
}

export interface ConvertDocxOptions {
  promoteHeadings?: boolean;
  limits?: DocxLimits;
  batchBudget?: DocxWorkBudget;
}

function attr(attrs: Record<string, string>, name: string): string | null {
  const value = attrs[name] as string | undefined;
  return value === undefined ? null : value;
}

/**
 * THE ONLY WAY A PART REACHES A PARSER. rejectDoctype first, always; the
 * SaxesParser is constructed after it has returned, so a payload whose whole
 * cost is in the expansion never gets started on.
 *
 * `xmlns: false` matches parse.ts: OOXML prefixes are fixed by the format and
 * namespace-aware parsing would only add a way for a hostile file to make a
 * well-formed part unreadable by redeclaring a prefix.
 *
 * A malformed part is a refusal rather than a silent empty result: a
 * numbering.xml we could not read would otherwise turn every ordered list in
 * the document into a bullet list with nothing said about it.
 */
function parsePart(
  xml: string,
  part: string,
  attach: (parser: SaxesParser) => void,
): void {
  rejectDoctype(xml);

  const parser = new SaxesParser({ xmlns: false });
  parser.on('error', () => {
    throw new DocxFormatError(`Not a valid .docx (malformed ${part})`);
  });
  attach(parser);
  parser.write(xml).close();
}

/**
 * word/_rels/document.xml.rels → relId → target.
 *
 * Namespace prefixes are not matched: the relationships part declares a
 * default namespace, so its elements are `Relationship`, but some producers
 * emit a prefixed form. Matching on the local name after the last colon costs
 * nothing and reads both.
 */
function parseRels(xml: string): Map<string, string> {
  const rels = new Map<string, string>();
  parsePart(xml, 'document.xml.rels', (parser) => {
    parser.on('opentag', (tag) => {
      if (localName(tag.name) !== 'Relationship') return;
      const id = attr(tag.attributes as Record<string, string>, 'Id');
      const target = attr(tag.attributes as Record<string, string>, 'Target');
      if (id !== null && target !== null) rels.set(id, target);
    });
  });
  return rels;
}

function localName(name: string): string {
  const cut = name.lastIndexOf(':');
  return cut === -1 ? name : name.slice(cut + 1);
}

/**
 * footnotes.xml / endnotes.xml → w:id (AS WRITTEN, a string) → note text.
 *
 * Keyed by the raw attribute string because that is what convert.ts looks up
 * with String(run.footnoteRef); a number key would miss every entry and drop
 * the note with no warning at all.
 *
 * w:type="separator" / "continuationSeparator" are skipped: they are Word's
 * horizontal rules, carry no author text, and occupy ids (-1, 0) that would
 * otherwise shadow nothing but still clutter the map.
 *
 * w:delText is NOT collected, matching parse.ts's tracked-changes rule — a
 * footnote's deleted draft text must not come back as live prose here after
 * being dropped everywhere else.
 */
function parseNotes(xml: string, part: string, into: Map<string, string>): void {
  parsePart(xml, part, (parser) => {
    let currentId: string | null = null;
    let capture = false;
    let text = '';

    parser.on('opentag', (tag) => {
      const name = localName(tag.name);
      if (name === 'footnote' || name === 'endnote') {
        const type = attr(tag.attributes as Record<string, string>, 'w:type');
        const id = attr(tag.attributes as Record<string, string>, 'w:id');
        currentId = type === null && id !== null ? id : null;
        text = '';
        return;
      }
      if (currentId !== null && name === 't') capture = true;
    });
    parser.on('text', (chunk) => {
      if (capture) text += chunk;
    });
    parser.on('cdata', (chunk) => {
      if (capture) text += chunk;
    });
    parser.on('closetag', (tag) => {
      const name = localName(tag.name);
      if (name === 't') capture = false;
      if (name === 'footnote' || name === 'endnote') {
        // First writer wins, so footnotes.xml is not overwritten by an
        // endnote sharing its id. parse.ts collapses w:footnoteReference and
        // w:endnoteReference into one `footnoteRef` field, so ids from the two
        // parts share a namespace they do not have in OOXML; both starting at
        // 1 is normal. Recorded as a known limitation rather than fixed here:
        // separating them means changing the document model, which is a
        // different change from wiring the parts together.
        if (currentId !== null && text.trim() !== '' && !into.has(currentId)) {
          into.set(currentId, text.trim());
        }
        currentId = null;
        text = '';
      }
    });
  });
}

/**
 * docProps/core.xml → the DOCX-01 `docx:` frontmatter block. Only the four
 * keys the spec names; everything else Word writes (revision, lastModifiedBy,
 * the template name) is noise in an entry's metadata.
 */
const CORE_PROP_KEYS: Record<string, string> = {
  'dc:title': 'title',
  'dc:creator': 'creator',
  'dcterms:created': 'created',
  'dcterms:modified': 'modified',
};

function parseCoreProps(xml: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  parsePart(xml, 'core.xml', (parser) => {
    let key: string | null = null;
    let text = '';
    parser.on('opentag', (tag) => {
      key = CORE_PROP_KEYS[tag.name] ?? null;
      text = '';
    });
    parser.on('text', (chunk) => {
      if (key !== null) text += chunk;
    });
    parser.on('closetag', (tag) => {
      if (key !== null && CORE_PROP_KEYS[tag.name] === key) {
        if (text.trim() !== '') out[key] = text.trim();
        key = null;
        text = '';
      }
    });
  });
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * numbering.xml → numId → 'bullet' | 'ordered' (DOCX-04's list row).
 *
 * Two hops, because OOXML puts the format one indirection away: w:num carries
 * the numId the paragraph references and points at an abstractNumId, and the
 * w:numFmt lives on the abstract definition's levels.
 *
 * Only level 0's numFmt is read. A list can change format per level, but the
 * only decision downstream is one marker per item and convert.ts already
 * indents by level; reading every level would model a distinction the output
 * cannot carry.
 *
 * Anything that is not "bullet" or "none" is ordered — decimal, lowerLetter,
 * upperRoman and the rest all render as an ordinal list. Defaulting the other
 * way would silently flatten every numbered list Word writes with a format we
 * did not enumerate.
 */
function parseNumbering(xml: string): Map<string, 'bullet' | 'ordered'> {
  const formatByAbstract = new Map<string, 'bullet' | 'ordered'>();
  const abstractByNum = new Map<string, string>();

  parsePart(xml, 'numbering.xml', (parser) => {
    let abstractId: string | null = null;
    let numId: string | null = null;
    let level: string | null = null;

    parser.on('opentag', (tag) => {
      const attrs = tag.attributes as Record<string, string>;
      switch (tag.name) {
        case 'w:abstractNum':
          abstractId = attr(attrs, 'w:abstractNumId');
          break;
        case 'w:lvl':
          level = attr(attrs, 'w:ilvl');
          break;
        case 'w:numFmt': {
          if (abstractId === null || level !== '0') break;
          if (formatByAbstract.has(abstractId)) break;
          const val = attr(attrs, 'w:val');
          formatByAbstract.set(
            abstractId,
            val === 'bullet' || val === 'none' || val === null ? 'bullet' : 'ordered',
          );
          break;
        }
        case 'w:num':
          numId = attr(attrs, 'w:numId');
          break;
        case 'w:abstractNumId': {
          // Inside w:num this element carries the link; inside w:abstractNum
          // the id is an attribute of the parent, so the guard on numId is
          // what keeps the two apart.
          const val = attr(attrs, 'w:val');
          if (numId !== null && val !== null) abstractByNum.set(numId, val);
          break;
        }
        default:
          break;
      }
    });
    parser.on('closetag', (tag) => {
      if (tag.name === 'w:abstractNum') abstractId = null;
      if (tag.name === 'w:lvl') level = null;
      if (tag.name === 'w:num') numId = null;
    });
  });

  const out = new Map<string, 'bullet' | 'ordered'>();
  for (const [num, abstract] of abstractByNum) {
    const format = formatByAbstract.get(abstract);
    if (format !== undefined) out.set(num, format);
  }
  return out;
}

interface ContentTypeIndex {
  /** Lower-cased extension → content type, from <Default>. */
  byExtension: Map<string, string>;
  /** Absolute part name ("/word/media/x.png") → content type, from <Override>. */
  byPartName: Map<string, string>;
}

/**
 * [Content_Types].xml — the only source there is for DOCX-07's `contentType`,
 * and the reason the manifest field stopped being permanently null.
 *
 * Reading it costs nothing extra: unpack.ts already decompresses the part, and
 * no image byte is touched to resolve a type — the extension and the override
 * table are all it takes.
 */
function parseContentTypes(xml: string): ContentTypeIndex {
  const byExtension = new Map<string, string>();
  const byPartName = new Map<string, string>();
  parsePart(xml, '[Content_Types].xml', (parser) => {
    parser.on('opentag', (tag) => {
      const attrs = tag.attributes as Record<string, string>;
      const name = localName(tag.name);
      if (name === 'Default') {
        const ext = attr(attrs, 'Extension');
        const type = attr(attrs, 'ContentType');
        if (ext !== null && type !== null) byExtension.set(ext.toLowerCase(), type);
      } else if (name === 'Override') {
        const part = attr(attrs, 'PartName');
        const type = attr(attrs, 'ContentType');
        if (part !== null && type !== null) byPartName.set(part, type);
      }
    });
  });
  return { byExtension, byPartName };
}

/**
 * Override wins over Default — that is what an override is for, and a media
 * part whose extension lies about its type is exactly the case the package
 * author used it to correct.
 */
function resolveContentType(name: string | null, index: ContentTypeIndex | null): string | null {
  if (name === null || index === null) return null;
  const partName = name.startsWith('/') ? name : `/${name}`;
  const override = index.byPartName.get(partName);
  if (override !== undefined) return override;
  const dot = name.lastIndexOf('.');
  if (dot === -1) return null;
  return index.byExtension.get(name.slice(dot + 1).toLowerCase()) ?? null;
}

export async function convertDocx(
  buffer: Buffer,
  opts: ConvertDocxOptions,
): Promise<DocxConversion> {
  const limits = opts.limits ?? DOCX_LIMITS;
  const parts = await unpackDocx(buffer, limits);

  const doc = parseDocumentXml(parts.document, limits, opts.batchBudget);
  const styleIndex = buildStyleIndex(parts.styles);

  const rels = parts.rels === null ? new Map<string, string>() : parseRels(parts.rels);
  const footnotes = new Map<string, string>();
  if (parts.footnotes !== null) parseNotes(parts.footnotes, 'footnotes.xml', footnotes);
  if (parts.endnotes !== null) parseNotes(parts.endnotes, 'endnotes.xml', footnotes);
  const coreProps = parts.coreProps === null ? null : parseCoreProps(parts.coreProps);
  const numberingFormats = parts.numbering === null
    ? new Map<string, 'bullet' | 'ordered'>()
    : parseNumbering(parts.numbering);
  const contentTypes = parts.contentTypes === null ? null : parseContentTypes(parts.contentTypes);

  // The manifest's rows, straight off the central directory. Not one of these
  // entries is ever decompressed (T-35-05); unpack.ts recorded name and
  // declared size while walking, and that is all DOCX-07 asks for.
  const mediaEntries = parts.otherEntries.filter((e) => e.name.startsWith('word/media/'));

  // DOCX-09's gate. The heuristic's result may only become headings when the
  // deterministic pass found nothing.
  const styledCount = countStyledHeadings(doc.blocks, styleIndex);

  // THE HEURISTIC NOW RUNS UNCONDITIONALLY, and its result is used for two
  // different things that must not be conflated.
  //
  // It used to run only when styledCount === 0, on the reasoning that a
  // discarded count should not be computed. That reasoning was wrong in a way
  // that was invisible: ONE accidental styled heading — and styling a document
  // TITLE as Heading 1 is Word's default — took the count to zero, which took
  // away the promotion affordance AND every diagnostic at once. Measured on a
  // document of 40 hand-formatted sections plus one styled title: warnings was
  // the empty array. The same document without the title reported both
  // `no-headings` and `unstyled-headings-detected`. The user got one entry and
  // no explanation of why.
  //
  // The extra cost is one linear pass over the blocks, which is the same order
  // as the conversion that follows it.
  const heuristic = detectUnstyledHeadings(doc.blocks);

  // Reported as 0 when styled headings exist, because that is what the
  // heuristic WOULD promote here: nothing, the gate refuses. Reporting the raw
  // count instead would make the preview offer "treat N bold paragraphs as
  // headings", and accepting it would change nothing at all — a control that
  // silently does not work is worse than one that is absent. The client's
  // eligibility test is `unstyledCandidates > 0` and nothing else, so this
  // zeroing is load-bearing on both sides.
  const candidates: Map<number, HeadingLevel> = styledCount === 0
    ? heuristic
    : new Map();
  const promoted = opts.promoteHeadings === true && candidates.size > 0;

  const result = convertDocument(doc, {
    styleIndex,
    promotedHeadings: promoted ? candidates : new Map<number, HeadingLevel>(),
    rels,
    footnotes,
    mediaEntries,
    coreProps,
    numberingFormats,
  });

  const warnings = [...result.warnings];
  // convertDocument cannot raise this one: with promotion off it is handed an
  // empty map and has no idea any candidate exists. Emitted only when the
  // candidates are still on the table — once promoted, they ARE headings, the
  // affordance is spent, and repeating the offer would be noise.
  if (candidates.size > 0 && !promoted) {
    const n = candidates.size;
    warnings.push({
      code: 'unstyled-headings-detected',
      message: `${n} paragraph${n === 1 ? '' : 's'} look${n === 1 ? 's' : ''} like a heading `
        + `(bold, larger or capitalised) but carr${n === 1 ? 'ies' : 'y'} no Heading style. `
        + `Re-import with heading promotion on to treat ${n === 1 ? 'it' : 'them'} as headings.`,
      count: n,
    });
  }

  // The mixed-document diagnostic. DELIBERATELY DIAGNOSTIC ONLY: whether
  // promotion should be OFFERED for a mixed document is a product decision that
  // has not been made, and DOCX-09 forbids it today. So the counts ride in the
  // warning text and nowhere else — `headings.unstyledCandidates` stays 0, and
  // the UI's affordance stays off.
  //
  // The trigger is "substantially more candidates than styled headings", not
  // "any candidate at all": a properly styled document with a couple of bold
  // asides must not be nagged at, or the warning becomes noise and stops being
  // read. Three times as many, and at least three of them — chosen so the
  // 1-styled/40-candidates case fires loudly and a 6-styled/1-candidate
  // document stays silent. If the ratio is wrong the cost is a warning that is
  // either slightly noisy or slightly quiet; it never changes what is imported.
  //
  // Guarded on styledCount > 0 because at zero the case is already reported by
  // `unstyled-headings-detected` above, and two warnings for one situation is
  // worse than one.
  const MIXED_RATIO = 3;
  const MIXED_FLOOR = 3;
  if (
    styledCount > 0
    && heuristic.size >= MIXED_FLOOR
    && heuristic.size >= styledCount * MIXED_RATIO
  ) {
    const one = styledCount === 1;
    const styledWord = `${styledCount} styled heading${one ? '' : 's'}`;
    const lookWord = `${heuristic.size} paragraphs that look like headings`;
    warnings.push({
      code: 'mixed-headings-detected',
      message: `This document has ${styledWord} but ${lookWord} `
        + `(bold, larger or capitalised). Only the styled heading${one ? '' : 's'} `
        + `${one ? 'was' : 'were'} used; the rest were imported as ordinary `
        + 'paragraphs. Add Heading styles in Word to the sections you want '
        + 'split out.',
      count: heuristic.size,
    });
  }

  const media = result.media.map((ref) => ({
    ...ref,
    contentType: resolveContentType(ref.name, contentTypes),
  }));

  return {
    markdown: result.markdown,
    warnings,
    media,
    headings: {
      styled: styledCount,
      unstyledCandidates: candidates.size,
      promoted,
    },
  };
}

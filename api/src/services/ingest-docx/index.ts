/**
 *
 * unpack → parse → headings → convert. Everything below this file is either
 * pure or single-purpose; this is where the parts meet, and therefore where
 * three decisions live that no other module is in a position to make.
 *
 * 1. THE PROMOTION GATE (DOCX-09). detectUnstyledHeadings is style-blind, so
 *    this layer combines its result with the deterministic styled-heading
 *    count. Unstyled-only documents are eligible; mixed documents must cross
 *    the server's floor plus ratio-or-absolute threshold. convertDocument
 *    still resolves a styled heading before consulting the promoted map, so
 *    promotion adds eligible structure without replacing authored structure.
 *
 * 2. `unstyled-headings-detected` AND `mixed-headings-detected` ARE EMITTED
 *    HERE, and can only be emitted here. With promotion off, convertDocument
 *    receives an empty promoted map and has nothing to report; the counts that
 *    drive the preview's "treat N bold paragraphs as headings" affordance and
 *    the mixed-document explanation exist only at this layer.
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
    styled: number;
    unstyledCandidates: number;
    promoted: boolean;
  };
}

export interface ConvertDocxOptions {
  promoteHeadings?: boolean;
  limits?: DocxLimits;
  batchBudget?: DocxWorkBudget;
}

export function isHeadingPromotionEligible(
  styledCount: number,
  candidateCount: number,
): boolean {
  if (styledCount === 0) return candidateCount > 0;
  return candidateCount >= 3
    && (candidateCount >= styledCount * 3 || candidateCount >= 10);
}

function attr(attrs: Record<string, string>, name: string): string | null {
  const value = attrs[name] as string | undefined;
  return value === undefined ? null : value;
}

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
        if (currentId !== null && text.trim() !== '' && !into.has(currentId)) {
          into.set(currentId, text.trim());
        }
        currentId = null;
        text = '';
      }
    });
  });
}

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
  byExtension: Map<string, string>;
  byPartName: Map<string, string>;
}

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

  // entries is ever decompressed (T-35-05); unpack.ts recorded name and
  // declared size while walking, and that is all DOCX-07 asks for.
  const mediaEntries = parts.otherEntries.filter((e) => e.name.startsWith('word/media/'));

  const styledCount = countStyledHeadings(doc.blocks, styleIndex);

  // document of 40 hand-formatted sections plus one styled title: warnings was
  // `no-headings` and `unstyled-headings-detected`. The user got one entry and
  const heuristic = detectUnstyledHeadings(doc.blocks);

  const eligibleCandidates: Map<number, HeadingLevel> = isHeadingPromotionEligible(
    styledCount,
    heuristic.size,
  ) ? heuristic : new Map();
  const promoted = opts.promoteHeadings === true && eligibleCandidates.size > 0;

  const result = convertDocument(doc, {
    styleIndex,
    promotedHeadings: promoted ? eligibleCandidates : new Map<number, HeadingLevel>(),
    rels,
    footnotes,
    mediaEntries,
    coreProps,
    numberingFormats,
  });

  const warnings = [...result.warnings];
  if (eligibleCandidates.size > 0 && !promoted) {
    const n = eligibleCandidates.size;
    warnings.push({
      code: 'unstyled-headings-detected',
      message: `${n} paragraph${n === 1 ? '' : 's'} look${n === 1 ? 's' : ''} like a heading `
        + `(bold, larger or capitalised) but carr${n === 1 ? 'ies' : 'y'} no Heading style. `
        + `Re-import with heading promotion on to treat ${n === 1 ? 'it' : 'them'} as headings.`,
      count: n,
    });
  }

  if (styledCount > 0 && eligibleCandidates.size > 0) {
    const one = styledCount === 1;
    const styledWord = `${styledCount} styled heading${one ? '' : 's'}`;
    const lookWord = `${heuristic.size} paragraphs that look like headings`;
    warnings.push({
      code: 'mixed-headings-detected',
      message: `This document has ${styledWord} but ${lookWord} `
        + `(bold, larger or capitalised). The styled heading${one ? '' : 's'} `
        + `${one ? 'is' : 'are'} preserved; the candidate paragraphs ${promoted
          ? 'were also promoted to headings.'
          : 'were imported as ordinary paragraphs unless heading promotion is selected for this upload.'}`,
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
      unstyledCandidates: eligibleCandidates.size,
      promoted,
    },
  };
}

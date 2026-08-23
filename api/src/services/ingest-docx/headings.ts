/**
 * Issue #35 (DOCX-09) — deciding which paragraphs are headings.
 *
 * This module drives where a .docx gets shattered into separate Weltbon
 * entries, and it does that with two mechanisms that have different
 * guarantees and must not be blurred together:
 *
 *   1. Style/outlineLvl resolution (buildStyleIndex/resolveStyledHeading) is
 *      DETERMINISTIC and always on. A styleId or w:name that resolves to a
 *      heading level is an author-declared fact about the document; we never
 *      second-guess it.
 *   2. The unstyled heuristic (detectUnstyledHeadings) is OPT-IN: it only
 *      runs when the deterministic pass found nothing to work with, because
 *      it is a guess (bold/size/caps standing in for structure) and a wrong
 *      guess should never be able to override an explicit style.
 *
 * DETERMINISM IS A CORRECTNESS PROPERTY HERE. The heuristic decides where the
 * document is split; if its result could vary between runs (e.g. because a
 * sort order depended on Map/Set insertion order), the same file would
 * shatter differently each time and the preview-before-commit safety check
 * would stop meaning anything. That is why the signature sort below breaks
 * ties on the signature string itself rather than leaving the comparator
 * partial — a partial comparator's result on ties is whatever the engine's
 * sort implementation happens to do with equal elements, which is not
 * something a document-splitting decision should depend on.
 */
import { SaxesParser } from 'saxes';
import { DocxFormatError } from './unpack.js';
import type { DocxBlock, DocxParagraph } from './parse.js';

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface StyleIndex {
  /** styleId → resolved heading level, basedOn chains already followed. */
  headingLevelByStyleId: Map<string, HeadingLevel>;
}

function attrOf(attrs: Record<string, string>, name: string): string | null {
  const value = attrs[name] as string | undefined;
  return value === undefined ? null : value;
}

/**
 * The one place both signals — an English `styleId` and a (possibly
 * localized) `w:name` — are tested against the heading pattern. Word
 * localizes the display name but usually keeps the id in English; some
 * localizations (French Word, notably) localize the id too, so relying on
 * either signal alone misses real documents. Neither is a guarantee, which
 * is exactly why both are checked here rather than picking one.
 */
function directHeadingLevel(styleId: string | null, name: string | null): HeadingLevel | null {
  if (styleId !== null) {
    const m = /^Heading([1-6])$/i.exec(styleId);
    if (m) return Number(m[1]) as HeadingLevel;
  }
  if (name !== null) {
    const normalized = name.trim().toLowerCase().replace(/\s+/g, ' ');
    const m = /^heading ([1-6])$/.exec(normalized);
    if (m) return Number(m[1]) as HeadingLevel;
  }
  return null;
}

interface RawStyleDef {
  name: string | null;
  basedOn: string | null;
}

/** Parses styles.xml into styleId → {name, basedOn}. No resolution here. */
function parseRawStyleDefs(stylesXml: string): Map<string, RawStyleDef> {
  const defs = new Map<string, RawStyleDef>();
  const parser = new SaxesParser({ xmlns: false });

  parser.on('error', () => {
    throw new DocxFormatError('Not a valid .docx (malformed styles.xml)');
  });

  let depth = 0;
  let currentId: string | null = null;
  let currentDepth = -1;

  parser.on('opentag', (tag) => {
    depth += 1;
    if (tag.name === 'w:style') {
      const id = attrOf(tag.attributes, 'w:styleId');
      if (id !== null) {
        currentId = id;
        currentDepth = depth;
        if (!defs.has(id)) defs.set(id, { name: null, basedOn: null });
      }
      return;
    }
    if (currentId === null) return;
    const def = defs.get(currentId);
    if (def === undefined) return;
    if (tag.name === 'w:name') {
      const val = attrOf(tag.attributes, 'w:val');
      if (val !== null) def.name = val;
    } else if (tag.name === 'w:basedOn') {
      const val = attrOf(tag.attributes, 'w:val');
      if (val !== null) def.basedOn = val;
    }
  });

  parser.on('closetag', (tag) => {
    if (tag.name === 'w:style' && depth === currentDepth) {
      currentId = null;
      currentDepth = -1;
    }
    depth -= 1;
  });

  parser.write(stylesXml).close();
  return defs;
}

/**
 * Follows basedOn with a visited set so a circular chain (malformed input —
 * two styles based on each other) terminates at `null` instead of recursing
 * forever. A style with no name of its own inherits nothing else from its
 * parent for this purpose: only whether the chain eventually reaches
 * something the heading pattern matches.
 */
function resolveChain(
  styleId: string,
  defs: Map<string, RawStyleDef>,
  visited: Set<string>,
): HeadingLevel | null {
  if (visited.has(styleId)) return null;
  visited.add(styleId);

  const def = defs.get(styleId) ?? null;
  const direct = directHeadingLevel(styleId, def?.name ?? null);
  if (direct !== null) return direct;

  if (def?.basedOn) return resolveChain(def.basedOn, defs, visited);
  return null;
}

export function buildStyleIndex(stylesXml: string | null): StyleIndex {
  const headingLevelByStyleId = new Map<string, HeadingLevel>();
  if (stylesXml === null) return { headingLevelByStyleId };

  const defs = parseRawStyleDefs(stylesXml);
  for (const styleId of defs.keys()) {
    const level = resolveChain(styleId, defs, new Set());
    if (level !== null) headingLevelByStyleId.set(styleId, level);
  }
  return { headingLevelByStyleId };
}

/**
 * Style wins when both a style and an outlineLvl are present: outlineLvl is
 * itself often just an artifact of whatever style was applied, and a style
 * resolution is a stronger, more specific signal than that derived value.
 *
 * The styleId regex fallback here (rather than only in buildStyleIndex)
 * matters because styles.xml need not declare the built-in Heading1..6
 * styles at all — Word applies them by convention without always writing an
 * explicit <w:style> entry — so a styleId of "Heading1" must resolve even
 * when the index has nothing recorded for it.
 */
export function resolveStyledHeading(block: DocxParagraph, index: StyleIndex): HeadingLevel | null {
  if (block.styleId !== null) {
    const fromIndex = index.headingLevelByStyleId.get(block.styleId);
    if (fromIndex !== undefined) return fromIndex;
    const direct = directHeadingLevel(block.styleId, null);
    if (direct !== null) return direct;
  }
  if (block.outlineLvl !== null) {
    const level = Math.min(Math.max(block.outlineLvl + 1, 1), 6);
    return level as HeadingLevel;
  }
  return null;
}

interface CandidateSignature {
  bold: boolean;
  caps: boolean;
  size: number | null;
}

interface CandidateEntry {
  index: number;
  sig: CandidateSignature;
  text: string;
}

/** Rule 5: every run in the paragraph must share the same (bold, caps, size)
 *  signature. A line that is half bold is emphasis inside prose, not a
 *  heading, and returning null here is what keeps such a paragraph out of
 *  every downstream computation — including the body-size estimate. */
function uniformSignature(p: DocxParagraph): CandidateSignature | null {
  if (p.runs.length === 0) return null;
  const first = p.runs[0];
  for (const r of p.runs) {
    if (r.bold !== first.bold || r.caps !== first.caps || r.sizeHalfPoints !== first.sizeHalfPoints) {
      return null;
    }
  }
  return { bold: first.bold, caps: first.caps, size: first.sizeHalfPoints };
}

function paragraphText(p: DocxParagraph): string {
  return p.runs.map((r) => r.text).join('');
}

function signatureKey(sig: CandidateSignature): string {
  return `${sig.bold}|${sig.size ?? 'null'}|${sig.caps}`;
}

/**
 * DOCX-09's unstyled heuristic. Opt-in: callers only reach for this when
 * resolveStyledHeading found nothing anywhere in the document, so a wrong
 * guess here is bounded — the default is to promote nothing, and any
 * promotion that IS made is visible in the preview entry list before
 * anything is committed.
 */
export function detectUnstyledHeadings(blocks: DocxBlock[]): Map<number, HeadingLevel> {
  const result = new Map<number, HeadingLevel>();

  // Gather every paragraph that could conceivably be a heading at all:
  // rule 4 (no list items) and rule 5 (uniform run signature) applied here,
  // up front, because both exclude a paragraph categorically regardless of
  // formatting or context.
  const paraEntries: CandidateEntry[] = [];
  blocks.forEach((b, index) => {
    if (b.kind !== 'paragraph') return;
    if (b.numbering !== null) return;
    const sig = uniformSignature(b);
    if (sig === null) return;
    paraEntries.push({ index, sig, text: paragraphText(b) });
  });

  // Body size is the modal size among paragraphs NOT already flagged
  // prominent via bold or caps alone — those are excluded from the body
  // population regardless of their size, since bold/caps already marks them
  // as unusual. Ties in the mode are broken by ascending size so the result
  // does not depend on iteration order.
  const boldOrCapsFlagged = paraEntries.filter((e) => e.sig.bold || e.sig.caps);
  const others = paraEntries.filter((e) => !(e.sig.bold || e.sig.caps));

  const sizeCounts = new Map<number, number>();
  for (const e of others) {
    if (e.sig.size !== null) sizeCounts.set(e.sig.size, (sizeCounts.get(e.sig.size) ?? 0) + 1);
  }
  let bodySize = 22; // 11pt default, per DOCX-09
  let bestCount = -1;
  for (const [size, count] of [...sizeCounts.entries()].sort((a, b) => a[0] - b[0])) {
    if (count > bestCount) {
      bestCount = count;
      bodySize = size;
    }
  }

  const sizeFlagged = others.filter((e) => e.sig.size !== null && e.sig.size > bodySize);
  const prominent = new Set<number>([...boldOrCapsFlagged, ...sizeFlagged].map((e) => e.index));

  // Rules 2 and 3: length and terminal punctuation. A question mark or
  // exclamation mark is allowed — those are heading-shaped too — but a full
  // stop marks an ordinary sentence, not a title.
  const shapeOk = new Set<number>();
  for (const e of paraEntries) {
    if (!prominent.has(e.index)) continue;
    const text = e.text.trim();
    if (text.length === 0 || text.length > 100) continue;
    if (text[text.length - 1] === '.') continue;
    shapeOk.add(e.index);
  }

  // Rule 6: a candidate must be followed by a non-candidate block — nothing
  // after it (end of document) is rejected, and so is a run of two
  // consecutive heading-shaped paragraphs with nothing distinguishing which
  // one is real, using shapeOk (computed above, not the final candidate set)
  // so this check cannot recurse into itself.
  const finalCandidates: CandidateEntry[] = [];
  for (const e of paraEntries) {
    if (!shapeOk.has(e.index)) continue;
    const nextIndex = e.index + 1;
    if (nextIndex >= blocks.length) continue;
    if (shapeOk.has(nextIndex)) continue;
    finalCandidates.push(e);
  }

  if (finalCandidates.length === 0) return result;

  // Rank distinct signatures by prominence: size descending, then bold, then
  // caps, THEN the signature string itself. That last key is what makes the
  // comparator total — without it, two signatures that tie on every other
  // key sort however the engine happens to place equal elements, and the
  // heuristic's whole determinism guarantee rests on there being no such
  // "however" left.
  const bySignature = new Map<string, CandidateSignature>();
  for (const e of finalCandidates) bySignature.set(signatureKey(e.sig), e.sig);

  const rankedKeys = [...bySignature.keys()].sort((ka, kb) => {
    const a = bySignature.get(ka)!;
    const b = bySignature.get(kb)!;
    const sizeA = a.size ?? -Infinity;
    const sizeB = b.size ?? -Infinity;
    if (sizeA !== sizeB) return sizeB - sizeA;
    if (a.bold !== b.bold) return a.bold ? -1 : 1;
    if (a.caps !== b.caps) return a.caps ? -1 : 1;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const levelByKey = new Map<string, HeadingLevel>();
  rankedKeys.forEach((key, rank) => {
    levelByKey.set(key, Math.min(rank + 1, 6) as HeadingLevel);
  });

  for (const e of finalCandidates) {
    result.set(e.index, levelByKey.get(signatureKey(e.sig))!);
  }

  return result;
}

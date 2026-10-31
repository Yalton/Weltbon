import { SaxesParser } from 'saxes';
import { DocxFormatError } from './unpack.js';
import { rejectDoctype } from './parse.js';
import type { DocxBlock, DocxParagraph } from './parse.js';

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface StyleIndex {
  headingLevelByStyleId: Map<string, HeadingLevel>;
}

function attrOf(attrs: Record<string, string>, name: string): string | null {
  const value = attrs[name] as string | undefined;
  return value === undefined ? null : value;
}

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

function parseRawStyleDefs(stylesXml: string): Map<string, RawStyleDef> {
  rejectDoctype(stylesXml);

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

export function countStyledHeadings(blocks: DocxBlock[], index: StyleIndex): number {
  let n = 0;
  for (const block of blocks) {
    if (block.kind !== 'paragraph') continue;
    if (resolveStyledHeading(block, index) !== null) n += 1;
  }
  return n;
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

export function detectUnstyledHeadings(blocks: DocxBlock[]): Map<number, HeadingLevel> {
  const result = new Map<number, HeadingLevel>();

  // surfaces as a standalone `kind: 'paragraph'` block), rule 3's single-line
  // <w:p> and still be two visual lines), and rule 5's uniform-signature
  const paraEntries: CandidateEntry[] = [];
  blocks.forEach((b, index) => {
    if (b.kind !== 'paragraph') return;
    if (b.numbering !== null) return;
    if ((b.indentTwips ?? 0) > 0 || b.runs.some((r) => r.tab)) return;
    if (b.runs.some((r) => r.lineBreak)) return;
    const sig = uniformSignature(b);
    if (sig === null) return;
    paraEntries.push({ index, sig, text: paragraphText(b) });
  });

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

  // Spec's emphatic-signature rule 5 requires size >= body size + 2pt, i.e.
  // +4 half-points — not "any amount over". A candidate only 1pt larger than
  const SIZE_FLOOR_HALF_POINTS = 4; // 2pt
  const sizeFlagged = others.filter(
    (e) => e.sig.size !== null && e.sig.size >= bodySize + SIZE_FLOOR_HALF_POINTS,
  );
  const prominent = new Set<number>([...boldOrCapsFlagged, ...sizeFlagged].map((e) => e.index));

  // Rule 3 (length; single-line already excluded up front) and rule 4
  // allowed — those are heading-shaped too, e.g. "What is the Vale?"; a
  // trailing comma, semicolon, or colon marks lead-in prose, not a title —
  const TERMINAL_PUNCTUATION = new Set(['.', ',', ';', ':']);
  const shapeOk = new Set<number>();
  for (const e of paraEntries) {
    if (!prominent.has(e.index)) continue;
    const text = e.text.trim();
    if (text.length === 0 || text.length > 100) continue;
    // A quoted line is dialogue even when its entire run is bold.
    if (/^["'“‘«„]/u.test(text)) continue;
    if (TERMINAL_PUNCTUATION.has(text[text.length - 1])) continue;
    shapeOk.add(e.index);
  }

  // Rule 6: a candidate must be followed by a non-candidate block — nothing
  // consecutive heading-shaped paragraphs with nothing distinguishing which
  const finalCandidates: CandidateEntry[] = [];
  for (const e of paraEntries) {
    if (!shapeOk.has(e.index)) continue;
    const nextIndex = e.index + 1;
    if (nextIndex >= blocks.length) continue;
    if (shapeOk.has(nextIndex)) continue;
    finalCandidates.push(e);
  }

  if (finalCandidates.length === 0) return result;

  // means that refactor doesn't get to silently reintroduce order-dependence.
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
    return ka < kb ? -1 : ka > kb ? 1 : 0; // dead code today — see comment above
  });

  const levelByKey = new Map<string, HeadingLevel>();
  let level = 1;
  rankedKeys.forEach((key, rank) => {
    if (rank > 0) {
      const previous = bySignature.get(rankedKeys[rank - 1])!;
      const current = bySignature.get(key)!;
      // Small font changes within the same treatment are usually document
      // variation, not a deliberate extra outline depth.
      const sameTier = previous.bold === current.bold
        && previous.caps === current.caps
        && previous.size !== null && current.size !== null
        && previous.size - current.size <= 4;
      if (!sameTier) level += 1;
    }
    levelByKey.set(key, Math.min(level, 6) as HeadingLevel);
  });

  for (const e of finalCandidates) {
    result.set(e.index, levelByKey.get(signatureKey(e.sig))!);
  }

  return result;
}

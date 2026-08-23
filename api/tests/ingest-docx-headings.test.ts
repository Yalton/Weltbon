/**
 * Issue #35 (DOCX-09) — heading resolution.
 *
 * Two mechanisms with different guarantees. Style/outlineLvl resolution is
 * deterministic and always on. The unstyled heuristic is opt-in, and is tested
 * for DETERMINISM as hard as for accuracy: it decides where a document gets
 * shattered, so a result that varies between runs would shatter it differently
 * each time.
 */
import { describe, it, expect } from 'vitest';
import {
  buildStyleIndex, resolveStyledHeading, detectUnstyledHeadings,
} from '../src/services/ingest-docx/headings.js';
import type { DocxParagraph, DocxRun } from '../src/services/ingest-docx/parse.js';

function run(text: string, over: Partial<DocxRun> = {}): DocxRun {
  return {
    text, bold: false, italic: false, strike: false, underline: false,
    caps: false, highlight: false, vertAlign: 'baseline', sizeHalfPoints: null,
    hyperlink: null, footnoteRef: null, lineBreak: false, tab: false, ...over,
  };
}

function para(text: string, over: Partial<DocxParagraph> = {}, runOver: Partial<DocxRun> = {}): DocxParagraph {
  return {
    kind: 'paragraph', styleId: null, outlineLvl: null, numbering: null,
    runs: [run(text, runOver)], ...over,
  };
}

describe('buildStyleIndex / resolveStyledHeading (DOCX-04)', () => {
  it('resolves an English styleId', () => {
    const idx = buildStyleIndex(null);
    expect(resolveStyledHeading(para('x', { styleId: 'Heading1' }), idx)).toBe(1);
    expect(resolveStyledHeading(para('x', { styleId: 'Heading6' }), idx)).toBe(6);
  });

  it('resolves a localized style by its w:name', () => {
    // French Word: styleId is localized too, so the id regex alone misses it.
    const styles = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:styleId="Titre2"><w:name w:val="heading 2"/></w:style>
    </w:styles>`;
    const idx = buildStyleIndex(styles);
    expect(resolveStyledHeading(para('x', { styleId: 'Titre2' }), idx)).toBe(2);
  });

  it('follows a basedOn chain to a heading style', () => {
    const styles = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:styleId="Heading3"><w:name w:val="heading 3"/></w:style>
      <w:style w:styleId="ChapterTitle"><w:basedOn w:val="Heading3"/></w:style>
    </w:styles>`;
    const idx = buildStyleIndex(styles);
    expect(resolveStyledHeading(para('x', { styleId: 'ChapterTitle' }), idx)).toBe(3);
  });

  it('does not loop forever on a circular basedOn chain', () => {
    const styles = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:styleId="A"><w:basedOn w:val="B"/></w:style>
      <w:style w:styleId="B"><w:basedOn w:val="A"/></w:style>
    </w:styles>`;
    const idx = buildStyleIndex(styles);
    expect(resolveStyledHeading(para('x', { styleId: 'A' }), idx)).toBeNull();
  });

  it('resolves outlineLvl with no style at all', () => {
    const idx = buildStyleIndex(null);
    expect(resolveStyledHeading(para('x', { outlineLvl: 0 }), idx)).toBe(1);
    expect(resolveStyledHeading(para('x', { outlineLvl: 5 }), idx)).toBe(6);
  });

  it('prefers the style over outlineLvl when both are present', () => {
    const idx = buildStyleIndex(null);
    expect(resolveStyledHeading(para('x', { styleId: 'Heading1', outlineLvl: 4 }), idx)).toBe(1);
  });

  it('returns null for an ordinary paragraph', () => {
    expect(resolveStyledHeading(para('just prose'), buildStyleIndex(null))).toBeNull();
  });

  it('ignores a non-heading style with a heading-like number in its name', () => {
    const styles = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:style w:styleId="ListParagraph2"><w:name w:val="List Paragraph 2"/></w:style>
    </w:styles>`;
    expect(resolveStyledHeading(para('x', { styleId: 'ListParagraph2' }), buildStyleIndex(styles)))
      .toBeNull();
  });
});

describe('detectUnstyledHeadings (DOCX-09)', () => {
  const BODY = { sizeHalfPoints: 22 };  // 11pt

  it('promotes a bold short line followed by prose', () => {
    const blocks = [
      para('The Vale', {}, { bold: true, ...BODY }),
      para('A long stretch of ordinary prose about the Vale.', {}, BODY),
    ];
    expect(detectUnstyledHeadings(blocks).get(0)).toBe(1);
  });

  it('rejects a candidate ending in terminal punctuation', () => {
    const blocks = [
      para('This is a bold sentence.', {}, { bold: true, ...BODY }),
      para('Prose.', {}, BODY),
    ];
    expect(detectUnstyledHeadings(blocks).size).toBe(0);
  });

  it('allows a question mark or exclamation mark', () => {
    const blocks = [
      para('What is the Vale?', {}, { bold: true, ...BODY }),
      para('Prose.', {}, BODY),
    ];
    expect(detectUnstyledHeadings(blocks).get(0)).toBe(1);
  });

  it('rejects a line longer than 100 characters', () => {
    const blocks = [
      para('x'.repeat(101), {}, { bold: true, ...BODY }),
      para('Prose.', {}, BODY),
    ];
    expect(detectUnstyledHeadings(blocks).size).toBe(0);
  });

  it('rejects a list item even when it looks like a heading', () => {
    const blocks = [
      para('The Vale', { numbering: { numId: '1', ilvl: 0 } }, { bold: true, ...BODY }),
      para('Prose.', {}, BODY),
    ];
    expect(detectUnstyledHeadings(blocks).size).toBe(0);
  });

  it('rejects a trailing candidate with nothing after it', () => {
    const blocks = [
      para('Prose.', {}, BODY),
      para('The Vale', {}, { bold: true, ...BODY }),
    ];
    expect(detectUnstyledHeadings(blocks).size).toBe(0);
  });

  it('promotes on font size alone, without bold', () => {
    const blocks = [
      para('The Vale', {}, { sizeHalfPoints: 32 }),   // 16pt vs 11pt body
      para('Prose about the Vale.', {}, BODY),
    ];
    expect(detectUnstyledHeadings(blocks).get(0)).toBe(1);
  });

  it('promotes on all-caps alone', () => {
    const blocks = [
      para('THE VALE', {}, { caps: true, ...BODY }),
      para('Prose about the Vale.', {}, BODY),
    ];
    expect(detectUnstyledHeadings(blocks).get(0)).toBe(1);
  });

  it('rejects a paragraph whose runs disagree about formatting', () => {
    // Rule 5 says EVERY run shares the signature. A line that is half bold is
    // emphasis inside prose, not a heading.
    const blocks: DocxParagraph[] = [
      { kind: 'paragraph', styleId: null, outlineLvl: null, numbering: null,
        runs: [run('The ', { bold: true, ...BODY }), run('Vale', BODY)] },
      para('Prose.', {}, BODY),
    ];
    expect(detectUnstyledHeadings(blocks).size).toBe(0);
  });

  it('ranks two signatures into levels 1 and 2 by prominence', () => {
    const blocks = [
      para('Part One', {}, { sizeHalfPoints: 36, bold: true }),
      para('Prose.', {}, BODY),
      para('Chapter A', {}, { sizeHalfPoints: 28, bold: true }),
      para('Prose.', {}, BODY),
    ];
    const got = detectUnstyledHeadings(blocks);
    expect(got.get(0)).toBe(1);
    expect(got.get(2)).toBe(2);
  });

  it('is deterministic across repeated runs on the same input', () => {
    // The heuristic decides where a document is shattered. A result that
    // varied would shatter it differently each time, and preview-before-commit
    // would stop being a reliable check.
    const blocks = [
      para('Alpha', {}, { sizeHalfPoints: 36, bold: true }), para('Prose.', {}, BODY),
      para('Beta', {}, { sizeHalfPoints: 28, bold: true }), para('Prose.', {}, BODY),
      para('Gamma', {}, { caps: true, ...BODY }), para('Prose.', {}, BODY),
    ];
    const first = JSON.stringify([...detectUnstyledHeadings(blocks)].sort());
    for (let i = 0; i < 20; i++) {
      expect(JSON.stringify([...detectUnstyledHeadings(blocks)].sort())).toBe(first);
    }
  });

  it('caps rank assignment at level 6', () => {
    const sizes = [40, 38, 36, 34, 32, 30, 28, 26];
    const blocks = sizes.flatMap((sz) => [
      para(`H${sz}`, {}, { sizeHalfPoints: sz, bold: true }),
      para('Prose.', {}, BODY),
    ]);
    const levels = [...detectUnstyledHeadings(blocks).values()];
    expect(Math.max(...levels)).toBeLessThanOrEqual(6);
  });

  it('returns an empty map for a document with no candidates', () => {
    expect(detectUnstyledHeadings([para('Just prose.', {}, BODY)]).size).toBe(0);
  });
});

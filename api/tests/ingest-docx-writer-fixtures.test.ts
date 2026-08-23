/**
 * Issue #35 — conversion against documents produced by a real OOXML WRITER.
 *
 * The spec's Testing section promises exactly this and nothing on the branch
 * delivered it: every other fixture in this suite is hand-authored
 * `document.xml`, written by the same person who wrote the parser, against the
 * same mental model. That is a closed loop. A hand-authored fixture cannot
 * catch an assumption the implementation and the fixture SHARE — the parser
 * looks for `<w:pStyle w:val="Heading1"/>` and the fixture obligingly contains
 * one, so the test passes whether or not any real writer emits that.
 *
 * `docx` (already a dependency — the export half of the app uses it) emits a
 * complete package: a real `styles.xml` with `w:basedOn` chains and localised
 * names, a real `numbering.xml` with abstract/concrete indirection, real
 * relationships, real `docProps/core.xml`. Every one of those is a part
 * `index.ts` parses and none of them is written by us here.
 *
 * These are DELIBERATELY end-to-end and coarse. Fine-grained rules belong in
 * the hand-authored files, where a single XML attribute can be varied in
 * isolation; what these add is "and a genuine package still comes out right",
 * which is the assertion the hand-authored ones structurally cannot make.
 *
 * Timestamps: `docProps/core.xml` carries the moment `Packer.toBuffer` ran, so
 * `created`/`modified` are asserted as PRESENT, never as a value.
 */
import { describe, it, expect } from 'vitest';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, ExternalHyperlink, FootnoteReferenceRun,
} from 'docx';
import { convertDocx } from '../src/services/ingest-docx/index.js';

/** Writer → bytes → our converter. No hand-written XML anywhere in the path. */
async function convertWritten(doc: Document, promoteHeadings = false) {
  const buffer = Buffer.from(await Packer.toBuffer(doc));
  // Guards against a writer change silently producing something that is not a
  // zip at all, which would otherwise surface as a confusing DocxFormatError.
  expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');
  return convertDocx(buffer, { promoteHeadings });
}

describe('convertDocx — documents produced by the `docx` writer', () => {
  it('converts a properly styled manuscript with nothing lost and nothing warned', async () => {
    const doc = new Document({
      title: 'The Vale',
      creator: 'A Writer',
      sections: [{
        children: [
          new Paragraph({ text: 'The Vale', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({
            children: [
              new TextRun('Cold and '),
              new TextRun({ text: 'high', bold: true }),
              new TextRun(', and '),
              new TextRun({ text: 'old', italics: true }),
              new TextRun('.'),
            ],
          }),
          new Paragraph({ text: 'Geography', heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ text: 'Peaks', bullet: { level: 0 } }),
          new Paragraph({ text: 'The Spire', bullet: { level: 1 } }),
          new Paragraph({ text: 'Valleys', bullet: { level: 0 } }),
          new Paragraph({
            children: [
              new TextRun('See '),
              new ExternalHyperlink({
                children: [new TextRun('the atlas')],
                link: 'https://example.com/atlas',
              }),
              new TextRun(' for more.'),
            ],
          }),
          new Table({
            rows: [
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('Peak')] }),
                  new TableCell({ children: [new Paragraph('Height')] }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('The Spire')] }),
                  new TableCell({ children: [new Paragraph('4200 m')] }),
                ],
              }),
            ],
          }),
        ],
      }],
    });

    const out = await convertWritten(doc);

    // Headings resolved through the writer's OWN styles.xml, not through the
    // styleId fallback: `docx` writes <w:style w:styleId="Heading1"> with a
    // basedOn chain, which is the path buildStyleIndex exists for.
    expect(out.headings.styled).toBe(2);
    expect(out.markdown).toContain('# The Vale');
    expect(out.markdown).toContain('## Geography');

    expect(out.markdown).toContain('Cold and **high**, and *old*.');

    // Nesting comes from a real numbering.xml — numId → abstractNumId →
    // w:numFmt — and the level-1 item must be indented under its parent, not
    // flattened into one list.
    expect(out.markdown).toContain('- Peaks\n  - The Spire\n- Valleys');

    // The hyperlink resolves through word/_rels/document.xml.rels.
    expect(out.markdown).toContain('[the atlas](https://example.com/atlas)');

    expect(out.markdown).toContain('| Peak | Height |');
    expect(out.markdown).toContain('| --- | --- |');
    expect(out.markdown).toContain('| The Spire | 4200 m |');

    // DOCX-01: core properties land in a namespaced `docx:` block and never as
    // a top-level `title:` that would beat the body's H1.
    expect(out.markdown.startsWith('---\ndocx:\n')).toBe(true);
    expect(out.markdown).toContain('  title: The Vale');
    expect(out.markdown).toContain('  creator: A Writer');
    expect(out.markdown).toMatch(/\n {2}created: /);
    expect(out.markdown).not.toMatch(/^title:/m);

    // The whole point of the fixture: a clean document must produce a clean
    // preview. A spurious warning here is the failure mode this catches —
    // the user is told something was lost when nothing was.
    expect(out.warnings).toEqual([]);
  });

  it('reports, then promotes, hand-formatted sections in a writer-produced file', async () => {
    // No Heading styles at all: bold 16pt against 11pt body, which is exactly
    // the document DOCX-09's heuristic exists for, but written by a real
    // writer rather than by us guessing at the rPr it would emit.
    const build = () => new Document({
      sections: [{
        children: [
          new Paragraph({ children: [new TextRun({ text: 'The Vale', bold: true, size: 32 })] }),
          new Paragraph({ children: [new TextRun({ text: 'Cold and high.', size: 22 })] }),
          new Paragraph({ children: [new TextRun({ text: 'The Spire', bold: true, size: 32 })] }),
          new Paragraph({ children: [new TextRun({ text: 'Tallest of them.', size: 22 })] }),
        ],
      }],
    });

    const off = await convertWritten(build(), false);
    expect(off.headings.styled).toBe(0);
    expect(off.headings.promoted).toBe(false);
    expect(off.headings.unstyledCandidates).toBe(2);
    expect(off.markdown).toContain('**The Vale**');
    expect(off.markdown).not.toContain('# The Vale');
    expect(off.warnings.map((w) => w.code).sort())
      .toEqual(['no-headings', 'unstyled-headings-detected']);

    const on = await convertWritten(build(), true);
    expect(on.headings.promoted).toBe(true);
    expect(on.markdown).toContain('# The Vale');
    expect(on.markdown).toContain('# The Spire');
    // Both affordance warnings are spent once the promotion is applied.
    expect(on.warnings).toEqual([]);
  });

  it('drops what Markdown cannot carry, and says so, on a writer-produced file', async () => {
    const doc = new Document({
      footnotes: { 1: { children: [new Paragraph('Recorded by the cartographers.')] } },
      sections: [{
        children: [
          new Paragraph({
            children: [
              new TextRun('The Vale'),
              new FootnoteReferenceRun(1),
              new TextRun({ text: ' is underlined here', underline: {} }),
              new TextRun({ text: ' and highlighted here', highlight: 'yellow' }),
            ],
          }),
        ],
      }],
    });

    const out = await convertWritten(doc);

    // The footnote survives as GFM, with its definition appended — and the id
    // is read out of the writer's real footnotes.xml, where separator and
    // continuationSeparator notes occupy ids -1 and 0 and must be skipped.
    expect(out.markdown).toContain('The Vale[^1]');
    expect(out.markdown).toContain('[^1]: Recorded by the cartographers.');

    // Underline and highlight are dropped rather than emitted as raw HTML
    // (DOCX-04), and the TEXT of both survives untouched.
    expect(out.markdown).toContain('is underlined here');
    expect(out.markdown).toContain('and highlighted here');
    expect(out.markdown).not.toContain('<u>');
    const dropped = out.warnings.find((w) => w.code === 'formatting-dropped');
    expect(dropped?.count).toBe(2);
  });
});

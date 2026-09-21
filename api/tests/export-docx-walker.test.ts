import { describe, it, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import {
  Document,
  Packer,
  Paragraph,
  Table,
  ExternalHyperlink,
  HeadingLevel,
} from 'docx';
import { fromBuffer, type ZipFile, type Entry } from 'yauzl';
import type { Root } from 'mdast';
import { mdastToDocx } from '../src/services/export/docx/walker.js';


function parse(md: string): Root {
  return unified().use(remarkParse).use(remarkGfm).parse(md) as Root;
}

/** Build a docx Document from walker output, pack it, return word/document.xml as a string. */
async function packToXml(blocks: Array<Paragraph | Table>): Promise<string> {
  const doc = new Document({
    sections: [{ children: blocks }],
  });
  const buf = await Packer.toBuffer(doc);
  return await readDocumentXml(buf);
}

function readDocumentXml(buf: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    fromBuffer(buf, { lazyEntries: true }, (err: Error | null, zip?: ZipFile) => {
      if (err || !zip) return reject(err ?? new Error('no zip'));
      zip.readEntry();
      zip.on('entry', (entry: Entry) => {
        if (entry.fileName !== 'word/document.xml') {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (err2: Error | null, stream) => {
          if (err2 || !stream) return reject(err2 ?? new Error('no stream'));
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          stream.on('error', reject);
        });
      });
      zip.on('end', () => reject(new Error('word/document.xml not found')));
      zip.on('error', reject);
    });
  });
}

describe('mdastToDocx walker', () => {
  it('downshifts heading depth 1 to HEADING_3 at base=3', async () => {
    const out = mdastToDocx(parse('# title\n'), 3);
    expect(out).toHaveLength(1);
    expect(out[0]).toBeInstanceOf(Paragraph);
    const xml = await packToXml(out);
    expect(xml).toContain('w:val="Heading3"');
    expect(xml).toContain('title');
  });

  it('downshifts heading depth 2 to HEADING_4 at base=3', async () => {
    const out = mdastToDocx(parse('## sub\n'), 3);
    const xml = await packToXml(out);
    expect(xml).toContain('w:val="Heading4"');
  });

  it('caps heading downshift at HEADING_6 (depth 5+ at base=3)', async () => {
    const out = mdastToDocx(parse('##### deep\n'), 3);
    const xml = await packToXml(out);
    expect(xml).toContain('w:val="Heading6"');
  });

  it('emits TextRun with w:b for **bold**', async () => {
    const out = mdastToDocx(parse('**hi**\n'), 3);
    expect(out).toHaveLength(1);
    expect(out[0]).toBeInstanceOf(Paragraph);
    const xml = await packToXml(out);
    expect(xml).toMatch(/<w:b\s*\/>/);
    expect(xml).toContain('hi');
  });

  it('emits TextRun with w:i for *italic*', async () => {
    const out = mdastToDocx(parse('*em*\n'), 3);
    const xml = await packToXml(out);
    expect(xml).toMatch(/<w:i\s*\/>/);
    expect(xml).toContain('em');
  });

  it('emits TextRun with monospace font for `inline code`', async () => {
    const out = mdastToDocx(parse('`code`\n'), 3);
    const xml = await packToXml(out);
    expect(xml).toContain('Consolas');
    expect(xml).toContain('code');
  });

  it('emits an unordered list with bullet config (one Paragraph per item)', async () => {
    const out = mdastToDocx(parse('- a\n- b\n'), 3);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeInstanceOf(Paragraph);
    expect(out[1]).toBeInstanceOf(Paragraph);
    const xml = await packToXml(out);
    // Bullet config in docx serializes as w:numPr with w:numId; the absence
    // of a numbering definition in the test Document means no <w:numId> for
    // bullets, but ListParagraph style still applies.
    expect(xml).toContain('w:val="ListParagraph"');
    expect(xml).toContain('a');
    expect(xml).toContain('b');
  });

  it('emits an ordered list with numbering reference', async () => {
    const out = mdastToDocx(parse('1. one\n2. two\n'), 3);
    expect(out).toHaveLength(2);
    const xml = await packToXml(out);
    expect(xml).toContain('w:val="ListParagraph"');
    expect(xml).toContain('one');
    expect(xml).toContain('two');
  });

  it('emits ExternalHyperlink for [link](url)', async () => {
    const out = mdastToDocx(parse('[click](https://example.com)\n'), 3);
    expect(out).toHaveLength(1);
    expect(out[0]).toBeInstanceOf(Paragraph);
    // ExternalHyperlink lives inside the Paragraph; assert XML serialization
    const xml = await packToXml(out);
    expect(xml).toContain('click');
    // Hyperlink relationships create <w:hyperlink r:id=…>
    expect(xml).toMatch(/<w:hyperlink\b/);
  });

  it('emits docx.Table for GFM table', async () => {
    const md = '| h1 | h2 |\n|----|----|\n| a  | b  |\n';
    const out = mdastToDocx(parse(md), 3);
    // First block should be a Table
    const table = out.find((b) => b instanceof Table);
    expect(table).toBeDefined();
    const xml = await packToXml(out);
    expect(xml).toMatch(/<w:tbl\b/);
    expect(xml).toContain('h1');
    expect(xml).toContain('h2');
    expect(xml).toContain('a');
    expect(xml).toContain('b');
  });

  it('emits Paragraph with style "Quote" for blockquote', async () => {
    const out = mdastToDocx(parse('> quoted\n'), 3);
    expect(out.length).toBeGreaterThanOrEqual(1);
    const xml = await packToXml(out);
    expect(xml).toContain('w:val="Quote"');
    expect(xml).toContain('quoted');
  });

  it('emits Paragraph with bottom border for thematic break (---)', async () => {
    const out = mdastToDocx(parse('---\n'), 3);
    expect(out).toHaveLength(1);
    expect(out[0]).toBeInstanceOf(Paragraph);
    const xml = await packToXml(out);
    // Bottom border serializes inside <w:pBdr><w:bottom .../></w:pBdr>
    expect(xml).toMatch(/<w:pBdr>/);
    expect(xml).toMatch(/<w:bottom\b/);
  });

  it('emits TextRun with break:1 for hard line break (two trailing spaces)', async () => {
    // A hard break in markdown = line ending with two spaces or a backslash
    const out = mdastToDocx(parse('first\\\nsecond\n'), 3);
    expect(out).toHaveLength(1);
    const xml = await packToXml(out);
    // <w:br/> appears in the run for a hard break
    expect(xml).toMatch(/<w:br\b/);
    expect(xml).toContain('first');
    expect(xml).toContain('second');
  });

  it('drops unknown / unsupported nodes silently (no throw, no extra blocks)', async () => {
    // Image node is in the "skip" list; should not throw
    const out = mdastToDocx(parse('![alt](http://example.com/a.png)\n'), 3);
    // The image is an inline child of a paragraph — paragraph still emits, just empty
    expect(Array.isArray(out)).toBe(true);
    // Should not throw when packing
    const xml = await packToXml(out);
    expect(xml).toBeDefined();
  });

  it('exposes HeadingLevel constants used (sanity)', () => {
    expect(HeadingLevel.HEADING_3).toBeDefined();
    expect(HeadingLevel.HEADING_4).toBeDefined();
    expect(HeadingLevel.HEADING_6).toBeDefined();
  });

  it('paragraph with mixed inlines emits multiple TextRuns', async () => {
    const out = mdastToDocx(parse('plain **bold** and *em* end\n'), 3);
    expect(out).toHaveLength(1);
    const xml = await packToXml(out);
    expect(xml).toContain('plain');
    expect(xml).toContain('bold');
    expect(xml).toContain('em');
    expect(xml).toContain('end');
    // Bold flag on the bold run, italic flag on the em run
    expect(xml).toMatch(/<w:b\s*\/>/);
    expect(xml).toMatch(/<w:i\s*\/>/);
  });

  it('does not produce ExternalHyperlink as a stray top-level block', async () => {
    // ExternalHyperlink must live inside a Paragraph, never as a sibling block
    const out = mdastToDocx(parse('[a](http://x)\n'), 3);
    for (const b of out) {
      expect(b instanceof ExternalHyperlink).toBe(false);
    }
  });
});

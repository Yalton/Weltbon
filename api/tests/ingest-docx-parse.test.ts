/**
 * Issue #35 (DOCX-06) — XML-layer hardening and the document model.
 *
 * No archives here. A billion-laughs payload needs no zip, which is why this is
 * a separate module from unpack.ts.
 *
 * Threat anchors: T-35-02 (entity expansion), T-35-04 (CPU exhaustion),
 * T-35-06 (no external entity resolution / no network).
 */
import { describe, it, expect } from 'vitest';
import { parseDocumentXml } from '../src/services/ingest-docx/parse.js';
import { DOCX_LIMITS } from '../src/services/ingest-docx/limits.js';
import { DocxFormatError } from '../src/services/ingest-docx/unpack.js';
import { documentWith } from './helpers/docx-fixture.js';

const p = (xml: string) => parseDocumentXml(documentWith(xml), DOCX_LIMITS);

describe('parseDocumentXml — entity expansion (T-35-02)', () => {
  it('rejects a DOCTYPE outright', () => {
    // Categorical, not budgeted: no real writer emits a DOCTYPE, so there is
    // no expansion budget to tune and no way to be "just under" the limit.
    const xml = `<?xml version="1.0"?><!DOCTYPE foo><w:document/>`;
    expect(() => parseDocumentXml(xml, DOCX_LIMITS)).toThrow(DocxFormatError);
  });

  it('rejects a billion-laughs payload without expanding it', () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE lolz [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
  <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<w:document>&lol3;</w:document>`;

    const started = process.hrtime.bigint();
    expect(() => parseDocumentXml(xml, DOCX_LIMITS)).toThrow(DocxFormatError);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    // Bounded rather than "did not crash": expansion would be visibly slower.
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('rejects an external entity declaration (T-35-06)', () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<w:document>&xxe;</w:document>`;
    expect(() => parseDocumentXml(xml, DOCX_LIMITS)).toThrow(DocxFormatError);
  });

  it('still decodes the five predefined XML entities in text', () => {
    // Rejecting DOCTYPE must not break ordinary escaped prose.
    const doc = p('<w:p><w:r><w:t>Tom &amp; Jerry &lt;here&gt;</w:t></w:r></w:p>');
    expect((doc.blocks[0] as { runs: Array<{ text: string }> }).runs[0].text)
      .toBe('Tom & Jerry <here>');
  });
});

describe('parseDocumentXml — resource caps (T-35-04)', () => {
  it('rejects nesting past the depth cap', () => {
    const deep = '<w:x>'.repeat(300) + '</w:x>'.repeat(300);
    expect(() => p(deep)).toThrow(DocxFormatError);
  });

  it('rejects a document past the block cap', () => {
    const many = '<w:p><w:r><w:t>x</w:t></w:r></w:p>'.repeat(50);
    expect(() => parseDocumentXml(documentWith(many), { ...DOCX_LIMITS, docxBlockCount: 10 }))
      .toThrow(DocxFormatError);
  });

  it('rejects malformed XML', () => {
    expect(() => parseDocumentXml('<w:document><w:body>', DOCX_LIMITS)).toThrow(DocxFormatError);
  });
});

describe('parseDocumentXml — paragraphs and runs', () => {
  it('reads a plain paragraph', () => {
    const doc = p('<w:p><w:r><w:t>Hello</w:t></w:r></w:p>');
    expect(doc.blocks).toHaveLength(1);
    const para = doc.blocks[0] as { kind: string; runs: Array<{ text: string }> };
    expect(para.kind).toBe('paragraph');
    expect(para.runs[0].text).toBe('Hello');
  });

  it('reads run formatting flags', () => {
    const doc = p(`<w:p><w:r>
      <w:rPr><w:b/><w:i/><w:strike/><w:u w:val="single"/><w:caps/>
             <w:sz w:val="32"/><w:vertAlign w:val="superscript"/></w:rPr>
      <w:t>Styled</w:t></w:r></w:p>`);
    const run = (doc.blocks[0] as { runs: Array<Record<string, unknown>> }).runs[0];
    expect(run.bold).toBe(true);
    expect(run.italic).toBe(true);
    expect(run.strike).toBe(true);
    expect(run.underline).toBe(true);
    expect(run.caps).toBe(true);
    expect(run.sizeHalfPoints).toBe(32);
    expect(run.vertAlign).toBe('superscript');
  });

  it('reads pStyle, outlineLvl and numbering off a paragraph', () => {
    const doc = p(`<w:p>
      <w:pPr><w:pStyle w:val="Heading2"/><w:outlineLvl w:val="1"/>
             <w:numPr><w:ilvl w:val="2"/><w:numId w:val="7"/></w:numPr></w:pPr>
      <w:r><w:t>x</w:t></w:r></w:p>`);
    const para = doc.blocks[0] as {
      styleId: string; outlineLvl: number; numbering: { numId: string; ilvl: number };
    };
    expect(para.styleId).toBe('Heading2');
    expect(para.outlineLvl).toBe(1);
    expect(para.numbering).toEqual({ numId: '7', ilvl: 2 });
  });

  it('preserves whitespace-only runs marked xml:space="preserve"', () => {
    const doc = p('<w:p><w:r><w:t>a</w:t></w:r><w:r><w:t xml:space="preserve"> b</w:t></w:r></w:p>');
    const runs = (doc.blocks[0] as { runs: Array<{ text: string }> }).runs;
    expect(runs.map((r) => r.text).join('')).toBe('a b');
  });

  it('records w:br and w:tab as run flags rather than text', () => {
    const doc = p('<w:p><w:r><w:br/><w:tab/><w:t>x</w:t></w:r></w:p>');
    const runs = (doc.blocks[0] as { runs: Array<Record<string, unknown>> }).runs;
    expect(runs.some((r) => r.lineBreak === true)).toBe(true);
    expect(runs.some((r) => r.tab === true)).toBe(true);
  });
});

describe('parseDocumentXml — tracked changes (DOCX-04)', () => {
  it('keeps w:ins content and counts it', () => {
    const doc = p('<w:p><w:ins><w:r><w:t>added</w:t></w:r></w:ins></w:p>');
    expect((doc.blocks[0] as { runs: Array<{ text: string }> }).runs[0].text).toBe('added');
    expect(doc.counters.insertionsKept).toBe(1);
  });

  it('drops w:del content and counts it', () => {
    // Comparing two documents rather than asserting an absence: the deleted
    // text must be gone AND the surviving text must be intact.
    const doc = p('<w:p><w:r><w:t>keep</w:t></w:r>' +
                  '<w:del><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>');
    const text = (doc.blocks[0] as { runs: Array<{ text: string }> }).runs
      .map((r) => r.text).join('');
    expect(text).toBe('keep');
    expect(doc.counters.deletionsDropped).toBe(1);
  });

  it('keeps w:moveTo and drops w:moveFrom', () => {
    const doc = p('<w:p><w:moveFrom><w:r><w:t>old</w:t></w:r></w:moveFrom>' +
                  '<w:moveTo><w:r><w:t>new</w:t></w:r></w:moveTo></w:p>');
    const text = (doc.blocks[0] as { runs: Array<{ text: string }> }).runs
      .map((r) => r.text).join('');
    expect(text).toBe('new');
  });
});

describe('parseDocumentXml — non-text blocks', () => {
  it('emits an image block for w:drawing and counts nothing as text', () => {
    const doc = p('<w:p><w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r></w:p>');
    expect(doc.blocks.some((b) => b.kind === 'image')).toBe(true);
  });

  it('emits an equation block for m:oMath', () => {
    const doc = p('<w:p><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p>');
    expect(doc.blocks.some((b) => b.kind === 'equation')).toBe(true);
  });

  it('emits a textbox block and does not inline its content', () => {
    const doc = p('<w:p><w:r><w:pict><v:textbox><w:txbxContent>' +
                  '<w:p><w:r><w:t>inside</w:t></w:r></w:p>' +
                  '</w:txbxContent></v:textbox></w:pict></w:r></w:p>');
    expect(doc.blocks.some((b) => b.kind === 'textbox')).toBe(true);
    const anyText = doc.blocks
      .filter((b): b is Extract<typeof b, { kind: 'paragraph' }> => b.kind === 'paragraph')
      .flatMap((b) => b.runs.map((r) => r.text)).join('');
    expect(anyText).not.toContain('inside');
  });

  it('counts dropped comments and fields', () => {
    const doc = p('<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>x</w:t></w:r>' +
                  '<w:fldSimple w:instr="TOC \\o"/></w:p>');
    expect(doc.counters.commentsDropped).toBe(1);
    expect(doc.counters.fieldsDropped).toBe(1);
  });

  it('reads a table into rows of cells of runs, flagging merged cells', () => {
    const doc = p(`<w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>
            <w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>
            <w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>`);
    const table = doc.blocks.find((b) => b.kind === 'table') as {
      rows: Array<Array<{ runs: Array<{ text: string }> }>>; hasMergedCells: boolean;
    };
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0].map((c) => c.runs.map((r) => r.text).join(''))).toEqual(['A', 'B']);
    expect(table.hasMergedCells).toBe(true);
  });
});

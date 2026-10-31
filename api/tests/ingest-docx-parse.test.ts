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
import type { DocxRun } from '../src/services/ingest-docx/parse.js';
import {
  DOCX_LIMITS,
  createDocxWorkBudget,
} from '../src/services/ingest-docx/limits.js';
import type { DocxLimits } from '../src/services/ingest-docx/limits.js';
import { DocxFormatError } from '../src/services/ingest-docx/unpack.js';
import { documentWith } from './helpers/docx-fixture.js';

const p = (xml: string, limits: DocxLimits = DOCX_LIMITS) => parseDocumentXml(documentWith(xml), limits);
const blockCapMessage = (limit: number) =>
  `Not a valid .docx (docx_block_count max ${limit}; simplify or split the document)`;
const docWithUnits = (units: number) => documentWith('<w:p/>'.repeat(units));

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

  it('charges retained nodes cumulatively against one shared batch budget', () => {
    const budget = createDocxWorkBudget(5);

    parseDocumentXml(
      docWithUnits(3),
      { ...DOCX_LIMITS, docxBlockCount: 10 },
      budget,
    );

    expect(budget.used).toBe(3);
    expect(() => parseDocumentXml(
      docWithUnits(3),
      { ...DOCX_LIMITS, docxBlockCount: 10 },
      budget,
    )).toThrow('docx_batch_block_count (max 5)');
  });

  it('checks the per-file cap before charging the shared batch budget', () => {
    const budget = createDocxWorkBudget(5);

    expect(() => parseDocumentXml(
      docWithUnits(3),
      { ...DOCX_LIMITS, docxBlockCount: 2 },
      budget,
    )).toThrow(blockCapMessage(2));
    expect(budget.used).toBe(2);
  });
});

describe('parseDocumentXml — paragraphs and runs', () => {
  it('reads paragraph indentation for unnumbered outlines', () => {
    const doc = p('<w:p><w:pPr><w:ind w:left="720" w:firstLine="720"/></w:pPr><w:r><w:t>Child</w:t></w:r></w:p>');
    expect(doc.blocks[0]).toMatchObject({ kind: 'paragraph', indentTwips: 720 });
  });

  it('does not treat a manuscript first-line indent as an outline depth', () => {
    const doc = p('<w:p><w:pPr><w:ind w:firstLine="720"/></w:pPr><w:r><w:t>Ordinary prose.</w:t></w:r></w:p>');
    expect(doc.blocks[0]).toMatchObject({ kind: 'paragraph', indentTwips: 0 });
  });
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

  // Demoted to a todo rather than left green, because it asserted nothing.
  // parse.ts has no xml:space handler at all — saxes hands us the text verbatim
  // and every run is captured verbatim — so the attribute is inert. Measured:
  //
  //   with    xml:space="preserve" -> ["a"," b"]
  //   without xml:space            -> ["a"," b"]   (identical)
  //
  // The test passed with the attribute deleted from its own fixture, which
  // means it was reading as coverage for a rule that does not exist. Real
  // coverage would need a case where the two DIFFER — i.e. an implementation
  // that collapses whitespace unless the attribute is present, which is a
  // behaviour change, not a test.
  it.todo('collapses whitespace-only runs UNLESS marked xml:space="preserve"');

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

/*
 * ---------------------------------------------------------------------------
 * Below this line: tests added in review, not part of the original brief.
 *
 * Two kinds. First, the padded-prolog bypasses — the original scan looked at a
 * fixed 4096-char prefix, and the prolog has no length bound, so a comment, a
 * processing instruction or plain whitespace pushed a DOCTYPE clean past it.
 * Second, the anti-vacuity tests: the 20 tests above can ALL pass while a
 * mechanism is dead, and these are the ones that notice. Each is annotated with
 * the specific green-test-dead-mechanism state it rules out.
 * ---------------------------------------------------------------------------
 */

/** The thrown message, or a sentinel. Four defenses share DocxFormatError, so
 *  `toThrow(DocxFormatError)` alone cannot say which of them fired. */
const msg = (fn: () => unknown): string => {
  try { fn(); } catch (e) { return (e as Error).message; }
  return '<<did not throw>>';
};

describe('parseDocumentXml — the prolog scan cannot be padded past or short-circuited (T-35-02)', () => {
  // Two families of bypass, both of which reached the parser at some point in
  // this module's history. PADDING: nothing bounds the length of an XML prolog,
  // so every payload in the first group walked past a fixed 4096-char window.
  // SHORT-CIRCUITING: a scanner that finds the root element by searching for
  // the first `<letter` is fooled by that sequence appearing INSIDE a comment or
  // a processing instruction, which truncates the prolog before the DOCTYPE and
  // needs roughly fifteen bytes rather than four thousand. Finding the boundary
  // requires stepping over each prolog item, because skipping a comment means
  // finding its terminator.
  const REJECTED = 'Not a valid .docx (unsupported XML construct)';
  const doc = '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>';

  it('rejects a DOCTYPE hidden behind a comment longer than any fixed window', () => {
    const xml = `<?xml version="1.0"?><!--${'A'.repeat(5000)}-->` +
                `<!DOCTYPE d [<!ENTITY a "AAAA">]>${doc}`;
    expect(msg(() => parseDocumentXml(xml, DOCX_LIMITS))).toBe(REJECTED);
  });

  it('rejects a DOCTYPE hidden behind a long processing instruction', () => {
    const xml = `<?xml version="1.0"?><?pad ${'A'.repeat(5000)}?>` +
                `<!DOCTYPE d [<!ENTITY a "AAAA">]>${doc}`;
    expect(msg(() => parseDocumentXml(xml, DOCX_LIMITS))).toBe(REJECTED);
  });

  it('rejects an external SYSTEM DOCTYPE hidden behind a comment (T-35-06)', () => {
    const xml = `<?xml version="1.0"?><!--${'A'.repeat(5000)}-->` +
                `<!DOCTYPE w:document SYSTEM "http://evil.example/x.dtd">${doc}`;
    expect(msg(() => parseDocumentXml(xml, DOCX_LIMITS))).toBe(REJECTED);
  });

  it('rejects a DOCTYPE that straddles the old window boundary', () => {
    // Padded so `<!DOCTYPE` starts at index 4090 and runs to 4098, spanning the
    // old 4096 edge: the prolog slice ended mid-literal at `<!DOCTY`, so it
    // matched neither the window nor anything after it. A cap does not merely
    // let a payload past, it can be cut in half by one.
    const xml = `${' '.repeat(4090)}<!DOCTYPE d [<!ENTITY a "AAAA">]>${doc}`;
    expect(xml.indexOf('<!DOCTYPE')).toBe(4090);
    expect(msg(() => parseDocumentXml(xml, DOCX_LIMITS))).toBe(REJECTED);
  });

  it('rejects a DOCTYPE after a comment whose CONTENT looks like a root tag', () => {
    // The round-1 regex read `<Az` inside the comment as the root element,
    // truncated the prolog there, and never inspected the DOCTYPE that followed.
    // ~15 bytes of padding, against the 4096 the previous bug needed.
    const xml = `<!-- pad <Az --><!DOCTYPE w:document SYSTEM "http://evil.example/x.dtd">${doc}`;
    expect(msg(() => parseDocumentXml(xml, DOCX_LIMITS))).toBe(REJECTED);
  });

  it('rejects a DOCTYPE after a processing instruction whose CONTENT looks like a root tag', () => {
    const xml = `<?pi <Az ?><!DOCTYPE d [<!ENTITY a "AAAA">]>${doc}`;
    expect(msg(() => parseDocumentXml(xml, DOCX_LIMITS))).toBe(REJECTED);
  });

  it('rejects a DOCTYPE behind a stack of such comments', () => {
    // The scan must be a loop, not a single skip: prolog items may repeat
    // without limit, and each one is another chance to be short-circuited.
    const xml = `<!-- <a --><!-- <b --><!-- <c --><!DOCTYPE d [<!ENTITY e "E">]>${doc}`;
    expect(msg(() => parseDocumentXml(xml, DOCX_LIMITS))).toBe(REJECTED);
  });

  it('does not silently accept a DOCTYPE hidden after an unterminated comment', () => {
    // The scanner gives up when a comment has no terminator, because there is no
    // way to know where the prolog ends. That give-up must not become an accept.
    // It does not, and for a reason worth naming: the same unterminated comment
    // makes the document malformed, so the parser refuses it a moment later.
    // Asserting the exact message pins WHICH defense caught it — if this ever
    // reads 'unsupported XML construct' the scanner changed, and if it ever
    // reads '<<did not throw>>' the document was accepted.
    const xml = `<!--x<!DOCTYPE d [<!ENTITY a "AAAA">]>${doc}`;
    const caught = msg(() => parseDocumentXml(xml, DOCX_LIMITS));
    expect(caught).not.toBe('<<did not throw>>');
    expect(caught).toBe('Not a valid .docx (malformed XML)');
  });

  it('rejects a DOCTYPE hidden behind a byte-order mark', () => {
    // saxes skips a leading BOM, so a scanner that treats U+FEFF as "stray text
    // before the root" and gives up would hand the DOCTYPE straight to a parser
    // that tolerates it — a one-character bypass. JS `\s` matches U+FEFF, so the
    // whitespace loop covers this; the test is here because that fact is
    // invisible at the call site and a hand-rolled whitespace test would lose it.
    const xml = `\uFEFF<!DOCTYPE d [<!ENTITY a "AAAA">]>${doc}`;
    expect(msg(() => parseDocumentXml(xml, DOCX_LIMITS))).toBe(REJECTED);
  });

  it('still parses a legitimate document that carries a comment and a PI before the root', () => {
    // The negative half, and the one that costs real files if it breaks: Word
    // and LibreOffice both emit a mso-application PI, and generators add
    // comments. An over-eager scanner would reject genuine input, so this is the
    // test that has to notice.
    const xml = '<!-- generated by Word --><?mso-application progid="Word.Document"?>' +
      '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>real</w:t></w:r></w:p></w:body></w:document>';
    const parsed = parseDocumentXml(xml, DOCX_LIMITS);
    expect((parsed.blocks[0] as { runs: DocxRun[] }).runs[0].text).toBe('real');
  });

  it('does not refuse a document that mentions a DOCTYPE inside a prolog comment', () => {
    // A behaviour change, and the right one: the round-1 scan sliced the prolog
    // at the first `<letter` and then string-matched the slice, so a comment
    // ABOUT a DOCTYPE was refused as if it were one. Stepping over the comment
    // means its contents are never inspected — the check now looks only at what
    // an XML parser would treat as a declaration.
    const xml = `<!-- <!DOCTYPE foo> -->${doc}`;
    expect((parseDocumentXml(xml, DOCX_LIMITS).blocks[0] as { runs: DocxRun[] }).runs[0].text)
      .toBe('hi');
  });

  it('still does not refuse a document whose prose merely mentions a DOCTYPE', () => {
    // The other direction, and the reason the scan is bounded by the prolog
    // rather than run over the whole string: escaped prose about XML must
    // remain importable. 201 blocks, not "did not throw" — a count, so a
    // silently truncated parse could not satisfy it.
    const pad = '<w:p><w:r><w:t>pad</w:t></w:r></w:p>'.repeat(200);
    const doc2 = p(pad + '<w:p><w:r><w:t>&lt;!DOCTYPE evil&gt;</w:t></w:r></w:p>');
    expect(doc2.blocks).toHaveLength(201);
  });
});

describe('parseDocumentXml — hyperlinks and footnote references', () => {


  it('puts r:id and w:anchor on the runs inside w:hyperlink, and only those', () => {
    const doc = p('<w:p><w:hyperlink r:id="rId9" w:anchor="sec1">' +
                  '<w:r><w:t>link</w:t></w:r></w:hyperlink>' +
                  '<w:r><w:t>plain</w:t></w:r></w:p>');
    const runs = (doc.blocks[0] as { runs: DocxRun[] }).runs;
    // Comparing the two runs rather than asserting one: a frame that is pushed
    // and never popped would decorate 'plain' too, and asserting only the first
    // run would never notice.
    expect(runs.map((r) => r.text)).toEqual(['link', 'plain']);
    expect(runs[0].hyperlink).toEqual({ relId: 'rId9', anchor: 'sec1' });
    expect(runs[1].hyperlink).toBeNull();
  });

  it('reads an anchor-only hyperlink as a null relId, not an empty string', () => {
    const doc = p('<w:p><w:hyperlink w:anchor="top"><w:r><w:t>up</w:t></w:r></w:hyperlink></w:p>');
    expect((doc.blocks[0] as { runs: DocxRun[] }).runs[0].hyperlink)
      .toEqual({ relId: null, anchor: 'top' });
  });

  it('emits w:footnoteReference as a raw string footnoteRef on its own marker run', () => {
    const doc = p('<w:p><w:r><w:t>x</w:t><w:footnoteReference w:id="3"/></w:r></w:p>');
    const runs = (doc.blocks[0] as { runs: DocxRun[] }).runs;
    expect(runs.map((r) => r.text)).toEqual(['x', '']);
    expect(runs[0].footnoteRef).toBeNull();
    expect(runs[1].footnoteRef).toBe('3');
    expect(typeof runs[1].footnoteRef).toBe('string');
  });

  it('preserves footnote w:id as an exact raw string', () => {
    const doc = p(
      '<w:p><w:r><w:footnoteReference w:id="a1"/></w:r>'
      + '<w:r><w:endnoteReference w:id="9007199254740993"/></w:r></w:p>',
    );
    const para = doc.blocks[0] as { runs: DocxRun[] };
    expect(para.runs.map((run) => run.footnoteRef)).toEqual([
      'a1',
      '9007199254740993',
    ]);
  });
});

describe('parseDocumentXml — the caps fire for their own reason', () => {
  // Both cap tests above only move a limit, so nothing in them distinguishes
  // "the cap fired" from "the document was refused for some other reason" —
  // and <w:x> repeated 300 times is an element the parser has never seen.
  it('parses the same 300-deep XML cleanly when only the depth cap moves', () => {
    const deep = '<w:x>'.repeat(300) + '</w:x>'.repeat(300);
    expect(p(deep, { ...DOCX_LIMITS, docxXmlDepth: 1000 }).blocks).toEqual([]);
    expect(msg(() => p(deep))).toBe('Not a valid .docx (XML nesting too deep)');
  });

  it('applies the depth cap exactly: 299 levels pass, 300 do not, at a cap of 301', () => {
    const mk = (n: number) => '<w:x>'.repeat(n) + '</w:x>'.repeat(n);
    const lim = { ...DOCX_LIMITS, docxXmlDepth: 301 }; // w:document + w:body = 2
    expect(msg(() => p(mk(299), lim))).toBe('<<did not throw>>');
    expect(msg(() => p(mk(300), lim))).toBe('Not a valid .docx (XML nesting too deep)');
  });

  it('parses the same 50 paragraphs to 50 blocks when only the block cap moves', () => {
    const many = '<w:p><w:r><w:t>x</w:t></w:r></w:p>'.repeat(50);
    expect(p(many).blocks).toHaveLength(50);
    expect(msg(() => p(many, { ...DOCX_LIMITS, docxBlockCount: 10 })))
      .toBe(blockCapMessage(10));
  });

  it('applies the block cap exactly: 10 units pass at a cap of 10, 11 do not', () => {
    // Empty paragraphs, so one <w:p> is exactly one unit. The cap's unit is a
    // RETAINED MODEL NODE — a published block, a table row, a table cell, or an
    // emitted run (A1) — so this used to read `<w:p><w:r><w:t>x` and was
    // measuring two things at once the moment runs started being charged.
    const empty = (n: number) => '<w:p/>'.repeat(n);
    const lim = { ...DOCX_LIMITS, docxBlockCount: 10 };
    expect(msg(() => p(empty(10), lim))).toBe('<<did not throw>>');
    expect(msg(() => p(empty(11), lim))).toBe(blockCapMessage(10));

    // The other half of the same rule: a paragraph carrying one run costs two,
    // so five pass at the same cap and six do not.
    const withRun = (n: number) => '<w:p><w:r><w:t>x</w:t></w:r></w:p>'.repeat(n);
    expect(msg(() => p(withRun(5), lim))).toBe('<<did not throw>>');
    expect(msg(() => p(withRun(6), lim))).toBe(blockCapMessage(10));
  });

  it('gives each defense its own message', () => {
    // Four defenses share one error class. Without this, a single over-broad
    // reject — a depth cap of 1, say — would satisfy all four toThrow() tests.
    expect(msg(() => parseDocumentXml('<?xml version="1.0"?><!DOCTYPE foo><w:document/>', DOCX_LIMITS)))
      .toBe('Not a valid .docx (unsupported XML construct)');
    expect(msg(() => parseDocumentXml('<w:document><w:body>', DOCX_LIMITS)))
      .toBe('Not a valid .docx (malformed XML)');
  });
});

describe('parseDocumentXml — the suppression stack is live, not incidental', () => {
  it('captures w:delText as text when no w:del frame is open', () => {
    // THE assertion that makes every deletion test above non-vacuous. If
    // w:delText were simply never read — the obvious shortcut, and what the
    // brief suggested — "drops w:del content" would still pass with the
    // suppression stack deleted outright.
    const doc = p('<w:p><w:r><w:delText>gone</w:delText></w:r></w:p>');
    expect((doc.blocks[0] as { runs: DocxRun[] }).runs.map((r) => r.text).join(''))
      .toBe('gone');
  });

  it('pops the w:del frame: text after a deletion survives', () => {
    // A frame that is pushed and never popped silently swallows the remainder
    // of any real document, and every one of the 20 brief tests still passes,
    // because nothing follows the suppressed region in any of them.
    const doc = p('<w:p><w:del><w:r><w:delText>gone</w:delText></w:r></w:del>' +
                  '<w:r><w:t>after</w:t></w:r></w:p>');
    expect((doc.blocks[0] as { runs: DocxRun[] }).runs.map((r) => r.text).join(''))
      .toBe('after');
  });

  it('pops the w:txbxContent frame: the outer paragraph keeps taking runs', () => {
    const doc = p('<w:p><w:r><w:pict><v:textbox><w:txbxContent>' +
                  '<w:p><w:r><w:t>inside</w:t></w:r></w:p>' +
                  '</w:txbxContent></v:textbox></w:pict></w:r>' +
                  '<w:r><w:t>outside</w:t></w:r></w:p>');
    const para = doc.blocks.find((b) => b.kind === 'paragraph') as { runs: DocxRun[] };
    expect(para.runs.map((r) => r.text).join('')).toBe('outside');
  });
});

/**
 * A1 — the block cap must charge what a table actually costs.
 *
 * The bug these pin shipped: `docxBlockCount` charged only PUBLISHED TOP-LEVEL
 * blocks, so a `w:tbl` cost exactly ONE unit no matter how many `w:tr`/`w:tc`
 * it carried. A 1 678-byte .docx holding 130 000 rows therefore parsed in
 * ~75 ms as a single block and sailed through every cap — and then died in the
 * converter (see the renderTable test in ingest-docx-convert.test.ts), which
 * the route maps to a 500. DOCX-11 says a document we will not parse is a 400.
 *
 * The unit of the cap is now a RETAINED MODEL NODE: a published block, a table
 * row, a table cell, or an emitted run. Those are precisely the things that
 * accumulate without bound under a single top-level block.
 */
describe('parseDocumentXml — the block cap charges rows, cells and runs (A1)', () => {
  const tableOf = (rowCount: number, cellsPerRow = 1) => {
    const cell = '<w:tc><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc>';
    const row = `<w:tr>${cell.repeat(cellsPerRow)}</w:tr>`;
    return `<w:tbl>${row.repeat(rowCount)}</w:tbl>`;
  };

  it('refuses an oversized table under the SHIPPED limits, naming the block cap', () => {
    // Deliberately at DOCX_LIMITS, not a lowered cap: the shipped numbers are
    // what the reproduction ran against, and a lowered-cap-only test would
    // stay green if the shipped value were later raised past the point where
    // renderTable can still be reached.
    let err: unknown;
    try { p(tableOf(40_000)); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DocxFormatError);
    expect((err as Error).message).toBe(blockCapMessage(100_000));
  });

  it('still parses a large-but-legal table: 1 000 rows x 3 cells', () => {
    // Word's own hard limit is 32 767 rows, so the cap has to sit far above
    // anything a writer emits. This is the half that fails if the charge is
    // set too aggressively — an over-tight cap turns real documents into 400s.
    const doc = p(tableOf(1_000, 3));
    expect(doc.blocks).toHaveLength(1);
    const table = doc.blocks[0] as { kind: string; rows: Array<Array<unknown>> };
    expect(table.kind).toBe('table');
    expect(table.rows).toHaveLength(1_000);
    expect(table.rows[0]).toHaveLength(3);
  });

  it('charges a row and a cell each, not just the table', () => {
    // One 4-row x 1-cell table = 1 table + 4 rows + 4 cells + 4 runs = 13.
    // At a cap of 12 that must throw; at 13 it must not. Pinning both sides
    // is what stops a charge of "1 per table, as before" passing the first.
    const xml = tableOf(4);
    expect(msg(() => p(xml, { ...DOCX_LIMITS, docxBlockCount: 13 })))
      .toBe('<<did not throw>>');
    expect(msg(() => p(xml, { ...DOCX_LIMITS, docxBlockCount: 12 })))
      .toBe(blockCapMessage(12));
  });

  it('charges runs, so one paragraph of a million runs cannot slip the cap', () => {
    // The hole that charging only rows and cells would leave open: a single
    // <w:p> (or a single <w:tc>) holding unbounded runs is still one block.
    const runs = '<w:r><w:t>x</w:t></w:r>'.repeat(20);
    expect(msg(() => p(`<w:p>${runs}</w:p>`, { ...DOCX_LIMITS, docxBlockCount: 10 })))
      .toBe(blockCapMessage(10));
  });
});

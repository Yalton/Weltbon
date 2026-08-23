/**
 * Issue #35 (DOCX-04/05) — the conversion table and the warning taxonomy.
 *
 * Escaping gets its own describe block because it is the most likely source of
 * silent corruption in the feature: a Word paragraph containing *asterisks* or
 * beginning with # must survive as literal text, and a failure here reads as
 * perfectly valid Markdown.
 */
import { describe, it, expect } from 'vitest';
import { convertDocument, escapeMarkdown } from '../src/services/ingest-docx/convert.js';
import { buildStyleIndex } from '../src/services/ingest-docx/headings.js';
import type { DocxDocument, DocxParagraph, DocxRun } from '../src/services/ingest-docx/parse.js';

const NO_COUNTERS = {
  insertionsKept: 0, deletionsDropped: 0, commentsDropped: 0,
  fieldsDropped: 0, symbolsDropped: 0,
};

function run(text: string, over: Partial<DocxRun> = {}): DocxRun {
  return {
    text, bold: false, italic: false, strike: false, underline: false,
    caps: false, highlight: false, vertAlign: 'baseline', sizeHalfPoints: null,
    hyperlink: null, footnoteRef: null, lineBreak: false, tab: false, ...over,
  };
}
function para(runs: DocxRun[], over: Partial<DocxParagraph> = {}): DocxParagraph {
  return { kind: 'paragraph', styleId: null, outlineLvl: null, numbering: null, runs, ...over };
}
function convert(blocks: DocxDocument['blocks'], over: Partial<Parameters<typeof convertDocument>[1]> = {}) {
  return convertDocument({ blocks, counters: NO_COUNTERS }, {
    styleIndex: buildStyleIndex(null),
    promotedHeadings: new Map(),
    rels: new Map(),
    footnotes: new Map(),
    mediaEntries: [],
    coreProps: null,
    ...over,
  });
}

describe('escapeMarkdown', () => {
  it('escapes emphasis characters so Word prose stays literal', () => {
    expect(escapeMarkdown('*not emphasis*')).toBe('\\*not emphasis\\*');
    expect(escapeMarkdown('_snake_case_')).toBe('\\_snake\\_case\\_');
  });

  it('escapes a leading hash so a line does not become a heading', () => {
    expect(escapeMarkdown('# not a heading')).toBe('\\# not a heading');
  });

  it('escapes link and image brackets', () => {
    expect(escapeMarkdown('[bracketed]')).toBe('\\[bracketed\\]');
  });

  it('escapes a backslash before anything else, exactly once', () => {
    // Ordering bug guard: escaping \ after * would double-escape the inserted
    // backslashes and corrupt every emphasis character in the document.
    expect(escapeMarkdown('a\\b')).toBe('a\\\\b');
    expect(escapeMarkdown('\\*')).toBe('\\\\\\*');
  });

  it('leaves ordinary prose untouched', () => {
    expect(escapeMarkdown('The Vale is cold.')).toBe('The Vale is cold.');
  });

  it('escapes the remaining structural characters', () => {
    // `|` matters inside table cells, `` ` `` would open a code span, and `~`
    // would collide with the strikethrough this converter emits itself.
    expect(escapeMarkdown('a|b`c~d')).toBe('a\\|b\\`c\\~d');
  });
});

describe('convertDocument — blocks', () => {
  it('renders a styled heading at its level', () => {
    const r = convert([para([run('The Vale')], { styleId: 'Heading2' })]);
    expect(r.markdown).toContain('## The Vale');
    expect(r.styledHeadings).toBe(1);
  });

  it('renders a promoted heading at the level it was given', () => {
    const r = convert([para([run('The Vale')]), para([run('Prose.')])],
      { promotedHeadings: new Map([[0, 1 as const]]) });
    expect(r.markdown).toContain('# The Vale');
  });

  it('renders a bullet list with nesting', () => {
    const r = convert([
      para([run('top')], { numbering: { numId: '1', ilvl: 0 } }),
      para([run('nested')], { numbering: { numId: '1', ilvl: 1 } }),
    ], { });
    expect(r.markdown).toContain('- top');
    expect(r.markdown).toContain('  - nested');
  });

  it('renders a GFM table and warns when cells were merged', () => {
    const r = convert([{
      kind: 'table',
      rows: [[{ runs: [run('A')] }, { runs: [run('B')] }], [{ runs: [run('C')] }]],
      hasMergedCells: true,
    }]);
    expect(r.markdown).toContain('| A | B |');
    expect(r.markdown).toContain('| --- | --- |');
    expect(r.warnings.some((w) => w.code === 'table-flattened')).toBe(true);
  });

  it('pads a ragged row to the header width so the table stays valid GFM', () => {
    const r = convert([{
      kind: 'table',
      rows: [[{ runs: [run('A')] }, { runs: [run('B')] }], [{ runs: [run('C')] }]],
      hasMergedCells: false,
    }]);
    expect(r.markdown).toContain('| C |  |');
    expect(r.warnings.some((w) => w.code === 'table-flattened')).toBe(false);
  });

  it('renders Quote and IntenseQuote styles as blockquotes', () => {
    const r = convert([
      para([run('quiet')], { styleId: 'Quote' }),
      para([run('loud')], { styleId: 'IntenseQuote' }),
    ]);
    expect(r.markdown).toContain('> quiet');
    expect(r.markdown).toContain('> loud');
  });

  it('escapes heading text like any other run', () => {
    const r = convert([para([run('#1 *The* Vale')], { styleId: 'Heading1' })]);
    expect(r.markdown).toContain('# \\#1 \\*The\\* Vale');
  });

  it('renders an ordered list when numbering.xml said the format is ordered', () => {
    const r = convert([
      para([run('first')], { numbering: { numId: '7', ilvl: 0 } }),
      para([run('second')], { numbering: { numId: '7', ilvl: 0 } }),
    ], { numberingFormats: new Map([['7', 'ordered' as const]]) });
    expect(r.markdown).toContain('1. first');
    expect(r.markdown).toContain('1. second');
    expect(r.markdown).not.toContain('- first');
  });
});

describe('convertDocument — inline', () => {
  it('renders bold, italic and strikethrough', () => {
    const r = convert([para([
      run('b', { bold: true }), run('i', { italic: true }), run('s', { strike: true }),
    ])]);
    expect(r.markdown).toContain('**b**');
    expect(r.markdown).toContain('*i*');
    expect(r.markdown).toContain('~~s~~');
  });

  it('keeps emphasis markers tight against the text they emphasise', () => {
    // `** bold **` is not emphasis in CommonMark: the marker must not be
    // separated from its text by whitespace, and Word runs routinely carry
    // their trailing space inside the formatted run.
    const r = convert([para([run('bold ', { bold: true }), run('after')])]);
    expect(r.markdown).toContain('**bold** after');
  });

  it('resolves a hyperlink through the rels map', () => {
    const r = convert(
      [para([run('Weltbon', { hyperlink: { relId: 'rId7', anchor: null } })])],
      { rels: new Map([['rId7', 'https://example.test/vale']]) },
    );
    expect(r.markdown).toContain('[Weltbon](https://example.test/vale)');
  });

  it('renders an internal anchor link', () => {
    const r = convert([para([run('see', { hyperlink: { relId: null, anchor: 'vale' } })])]);
    expect(r.markdown).toContain('[see](#vale)');
  });

  it('merges consecutive runs that share one hyperlink into a single link', () => {
    // Word splits a link across runs on every formatting or spellcheck
    // boundary; emitting one link per run would produce [We](u)[ltbon](u).
    const r = convert(
      [para([
        run('Wel', { hyperlink: { relId: 'rId7', anchor: null } }),
        run('tbon', { hyperlink: { relId: 'rId7', anchor: null }, bold: true }),
        run(' is cold.'),
      ])],
      { rels: new Map([['rId7', 'https://example.test/vale']]) },
    );
    expect(r.markdown).toContain('[Wel**tbon**](https://example.test/vale) is cold.');
  });

  it('renders a tab as a single space and a break as a hard line break', () => {
    const r = convert([para([run('a'), run('', { tab: true }), run('b'),
      run('', { lineBreak: true }), run('c')])]);
    expect(r.markdown).toContain('a b\\\nc');
  });

  it('keeps underlined text but drops the formatting, warning once', () => {
    const r = convert([
      para([run('under', { underline: true })]),
      para([run('also', { underline: true })]),
    ]);
    expect(r.markdown).toContain('under');
    expect(r.markdown).not.toContain('<u>');
    const w = r.warnings.filter((x) => x.code === 'formatting-dropped');
    expect(w).toHaveLength(1);
    expect(w[0].count).toBe(2);
  });

  it('counts highlight and super/subscript as dropped formatting too', () => {
    const r = convert([para([
      run('hi', { highlight: true }),
      run('sup', { vertAlign: 'superscript' }),
      run('plain'),
    ])]);
    const w = r.warnings.filter((x) => x.code === 'formatting-dropped');
    expect(w).toHaveLength(1);
    expect(w[0].count).toBe(2);
    expect(r.markdown).toContain('hisupplain');
  });
});

describe('convertDocument — warnings and media', () => {
  it('emits an image placeholder and records the media ref without bytes', () => {
    const r = convert([{ kind: 'image', relId: 'rId5' }], {
      rels: new Map([['rId5', 'media/image1.png']]),
      mediaEntries: [{ name: 'word/media/image1.png', declaredBytes: 4096 }],
    });
    expect(r.markdown).toContain('![image omitted: image1.png]()');
    expect(r.media).toHaveLength(1);
    expect(r.media[0].declaredBytes).toBe(4096);
    expect(Object.keys(r.media[0])).not.toContain('bytes');
    expect(r.warnings.some((w) => w.code === 'image-dropped')).toBe(true);
  });

  it('records the block position of each image', () => {
    const r = convert([
      para([run('before')]),
      { kind: 'image', relId: 'rId5' },
      para([run('after')]),
    ]);
    expect(r.media).toHaveLength(1);
    expect(r.media[0].blockIndex).toBe(1);
    expect(r.media[0].relId).toBe('rId5');
  });

  it('escapes an image name that contains markdown characters', () => {
    // The name comes from the uploaded file: untrusted text.
    const r = convert([{ kind: 'image', relId: 'rId5' }], {
      rels: new Map([['rId5', 'media/a]b*c.png']]),
      mediaEntries: [{ name: 'word/media/a]b*c.png', declaredBytes: 1 }],
    });
    expect(r.markdown).toContain('\\]');
    expect(r.markdown).toContain('\\*');
  });

  it('warns about tracked changes with both counts', () => {
    const r = convertDocument(
      { blocks: [para([run('x')])], counters: { ...NO_COUNTERS, insertionsKept: 3, deletionsDropped: 2 } },
      { styleIndex: buildStyleIndex(null), promotedHeadings: new Map(), rels: new Map(),
        footnotes: new Map(), mediaEntries: [], coreProps: null },
    );
    const w = r.warnings.find((x) => x.code === 'tracked-changes-applied');
    expect(w).toBeDefined();
    expect(w!.message).toContain('3');
    expect(w!.message).toContain('2');
  });

  it('warns no-headings when nothing resolved', () => {
    const r = convert([para([run('Just prose.')])]);
    expect(r.warnings.some((w) => w.code === 'no-headings')).toBe(true);
  });

  it('does not warn no-headings when a heading exists', () => {
    const r = convert([para([run('T')], { styleId: 'Heading1' })]);
    expect(r.warnings.some((w) => w.code === 'no-headings')).toBe(false);
  });

  it('does not warn no-headings when only promoted headings exist', () => {
    // A promoted document will not import as a single entry, which is the
    // whole content of the no-headings warning.
    const r = convert([para([run('The Vale')]), para([run('Prose.')])],
      { promotedHeadings: new Map([[0, 1 as const]]) });
    expect(r.warnings.some((w) => w.code === 'no-headings')).toBe(false);
    expect(r.styledHeadings).toBe(0);
  });

  it('aggregates every counter-driven code into one warning carrying its count', () => {
    const r = convertDocument(
      {
        blocks: [
          { kind: 'equation' }, { kind: 'equation' },
          { kind: 'textbox' },
          para([run('x')], { styleId: 'Heading1' }),
        ],
        counters: { ...NO_COUNTERS, commentsDropped: 4, fieldsDropped: 5, symbolsDropped: 6 },
      },
      { styleIndex: buildStyleIndex(null), promotedHeadings: new Map(), rels: new Map(),
        footnotes: new Map(), mediaEntries: [], coreProps: null },
    );
    const byCode = (code: string) => r.warnings.filter((w) => w.code === code);
    for (const [code, count] of [
      ['equation-dropped', 2], ['textbox-dropped', 1],
      ['comments-dropped', 4], ['field-dropped', 5], ['symbol-dropped', 6],
    ] as const) {
      expect(byCode(code), code).toHaveLength(1);
      expect(byCode(code)[0].count, code).toBe(count);
    }
  });

  it('emits no warning for a code with nothing to report', () => {
    const r = convert([para([run('T')], { styleId: 'Heading1' })]);
    expect(r.warnings).toHaveLength(0);
  });

  it('emits core properties as a docx frontmatter block, never as title', () => {
    // inferTitle prefers frontmatter `title:` over the body H1, and Word leaves
    // this property as a template name; hijacking the title is the bug this
    // shape prevents.
    const r = convert([para([run('T')], { styleId: 'Heading1' })], {
      coreProps: { title: 'Document1', creator: 'A. Writer' },
    });
    expect(r.markdown).toMatch(/^---\n/);
    expect(r.markdown).toContain('docx:');
    expect(r.markdown).toContain('creator: A. Writer');
    expect(r.markdown).not.toMatch(/^title:/m);
  });

  it('quotes a core property that would otherwise break the YAML', () => {
    // docProps/core.xml is attacker-controlled text; an unquoted `a: b` value
    // makes the frontmatter parse as a nested map or fail outright.
    const r = convert([para([run('T')], { styleId: 'Heading1' })], {
      coreProps: { title: 'Vale: the "cold" one', creator: '#hash' },
    });
    expect(r.markdown).toContain('title: "Vale: the \\"cold\\" one"');
    expect(r.markdown).toContain('creator: "#hash"');
  });

  it('omits the frontmatter block entirely when there are no core properties', () => {
    const r = convert([para([run('T')], { styleId: 'Heading1' })], { coreProps: { title: '' } });
    expect(r.markdown).not.toContain('---');
    expect(r.markdown).not.toContain('docx:');
  });

  it('renders footnote references and appends definitions', () => {
    const r = convert([para([run('claim', { footnoteRef: 2 })])],
      { footnotes: new Map([['2', 'The source.']]) });
    expect(r.markdown).toContain('[^2]');
    expect(r.markdown).toContain('[^2]: The source.');
  });

  it('appends definitions once, in reference order, and only when defined', () => {
    const r = convert([
      para([run('a', { footnoteRef: 3 })]),
      para([run('b', { footnoteRef: 1 })]),
      para([run('c', { footnoteRef: 3 })]),
      para([run('d', { footnoteRef: 9 })]),
    ], { footnotes: new Map([['1', 'One.'], ['3', 'Three *starred*.']]) });
    expect(r.markdown.indexOf('[^3]: ')).toBeLessThan(r.markdown.indexOf('[^1]: '));
    expect(r.markdown.match(/^\[\^3\]: /gm)).toHaveLength(1);
    expect(r.markdown).not.toContain('[^9]: ');
    // Footnote text comes from footnotes.xml — escaped like any other run.
    expect(r.markdown).toContain('[^3]: Three \\*starred\\*.');
  });
});

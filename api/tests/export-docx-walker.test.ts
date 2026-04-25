import { describe, it } from 'vitest';

// Wave 0 stub for the mdast → docx walker units — implementation lands in plan 04-04.
// These are pure unit tests over the walker function; they do not touch the
// route or the DB, so once filled in they will not need integration setup.

describe.skip('walker: heading depth 1 with base=3 emits HeadingLevel.HEADING_3', () => {
  it('placeholder', () => {
    // TODO plan 04-04
  });
});

describe.skip('walker: **bold** emits TextRun with bold:true', () => {
  it('placeholder', () => {
    // TODO plan 04-04
  });
});

describe.skip('walker: *italic* emits TextRun with italics:true', () => {
  it('placeholder', () => {
    // TODO plan 04-04
  });
});

describe.skip('walker: `inline code` emits TextRun with monospace font', () => {
  it('placeholder', () => {
    // TODO plan 04-04
  });
});

describe.skip('walker: ordered list emits ListParagraph with numbering', () => {
  it('placeholder', () => {
    // TODO plan 04-04
  });
});

describe.skip('walker: link emits ExternalHyperlink with url + Hyperlink-styled TextRun', () => {
  it('placeholder', () => {
    // TODO plan 04-04
  });
});

describe.skip('walker: table emits docx.Table with rows + cells', () => {
  it('placeholder', () => {
    // TODO plan 04-04
  });
});

describe.skip('walker: blockquote emits Paragraph with style "Quote"', () => {
  it('placeholder', () => {
    // TODO plan 04-04
  });
});

describe.skip('walker: thematicBreak emits Paragraph with bottom border', () => {
  it('placeholder', () => {
    // TODO plan 04-04
  });
});

describe.skip('walker: unknown node types drop silently', () => {
  it('placeholder', () => {
    // TODO plan 04-04
  });
});

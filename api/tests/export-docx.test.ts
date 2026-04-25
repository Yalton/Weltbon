import { describe, it } from 'vitest';

// Wave 0 stub for EXP-04 — implementation lands in plan 04-04.
// Once the DOCX exporter ships, these suites unzip the .docx via yauzl and
// inspect word/document.xml for required style references and TOC field codes.

describe.skip('EXP-04: Packer.toBuffer produces valid ZIP openable by yauzl', () => {
  it('placeholder', () => {
    // TODO plan 04-04
  });
});

describe.skip('EXP-04: word/document.xml contains w:pStyle w:val="Title" for universe name', () => {
  it('placeholder', () => {
    // TODO plan 04-04
  });
});

describe.skip('EXP-04: word/document.xml contains w:pStyle w:val="Heading1" for each category', () => {
  it('placeholder', () => {
    // TODO plan 04-04
  });
});

describe.skip('EXP-04: word/document.xml contains w:instrText with TOC field code', () => {
  it('placeholder', () => {
    // TODO plan 04-04
  });
});

describe.skip('EXP-04: features.updateFields=true is set so Word refreshes TOC on first open', () => {
  it('placeholder', () => {
    // TODO plan 04-04
  });
});

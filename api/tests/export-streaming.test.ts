import { describe, it } from 'vitest';

// Wave 0 stub for EXP-05 streaming behavior — implementation lands across
// plans 04-02/03/04 and consolidates in 04-05. DOCX is intentionally
// Content-Length (not chunked) per CONTEXT.md exemption.

describe.skip('EXP-05: markdown ZIP response has Transfer-Encoding chunked and no Content-Length', () => {
  it('placeholder', () => {
    // TODO plan 04-02 / 04-05
  });
});

describe.skip('EXP-05: PDF response has Transfer-Encoding chunked and no Content-Length', () => {
  it('placeholder', () => {
    // TODO plan 04-03 / 04-05
  });
});

describe.skip('EXP-05: DOCX response uses Content-Length (DOCX size bounded; CONTEXT exemption)', () => {
  it('placeholder', () => {
    // TODO plan 04-04 / 04-05
  });
});

describe.skip('EXP-05: 3 sequential PDF requests do not leak Chromium processes (count stable)', () => {
  it('placeholder', () => {
    // TODO plan 04-03 / 04-05
  });
});

describe.skip('EXP-05: all formats return Content-Disposition attachment with the correct extension', () => {
  it('placeholder', () => {
    // TODO plan 04-05
  });
});

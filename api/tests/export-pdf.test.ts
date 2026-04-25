import fs from 'node:fs';
import { describe, it } from 'vitest';

// Wave 0 stub for EXP-03 — implementation lands in plan 04-03.
// Skipped unconditionally for now; once the PDF exporter ships, the suite
// switches to `describe.skipIf(!HAS_CHROMIUM)` so CI without Chromium stays green.
const HAS_CHROMIUM = Boolean(process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH));
void HAS_CHROMIUM;

describe.skip('EXP-03: PDF response has Content-Type application/pdf and Content-Disposition attachment', () => {
  it('placeholder', () => {
    // TODO plan 04-03
  });
});

describe.skip('EXP-03: pdf-parse extracts universe title from page 1, every category name, every entry title', () => {
  it('placeholder', () => {
    // TODO plan 04-03
  });
});

describe.skip('EXP-03: footer page numbers present on page 2 onward; title page (page 1) has none', () => {
  it('placeholder', () => {
    // TODO plan 04-03
  });
});

describe.skip('EXP-05: browser process closes after request completes (assert via spy that browser.close() ran)', () => {
  it('placeholder', () => {
    // TODO plan 04-03
  });
});

describe.skip('EXP-05: response uses Transfer-Encoding: chunked, no Content-Length header', () => {
  it('placeholder', () => {
    // TODO plan 04-03
  });
});

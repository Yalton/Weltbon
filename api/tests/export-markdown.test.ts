import { describe, it } from 'vitest';

// Wave 0 stub for EXP-02 — implementation lands in plan 04-02.
// describe.skip keeps suites compiling under tsc -b without spinning up
// not-yet-existing exporter modules.

describe.skip('EXP-02: ZIP layout — universe-slug folder with _index.md and per-category subfolders', () => {
  it('placeholder', () => {
    // TODO plan 04-02
  });
});

describe.skip('EXP-02: per-entry .md has YAML frontmatter (parses via yaml.parse), H1 title, summary blockquote, body, ## Links, ## Backlinks, ## Open Issues', () => {
  it('placeholder', () => {
    // TODO plan 04-02
  });
});

describe.skip('EXP-02: relative links from _index.md and entries resolve to existing files in the ZIP', () => {
  it('placeholder', () => {
    // TODO plan 04-02
  });
});

describe.skip('EXP-02: resolved=true issues are NOT in any entry\'s ## Open Issues section', () => {
  it('placeholder', () => {
    // TODO plan 04-02
  });
});

describe.skip('EXP-02: Uncategorized folder holds entries with categoryId=null and appears last in _index.md TOC', () => {
  it('placeholder', () => {
    // TODO plan 04-02
  });
});

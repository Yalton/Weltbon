import { describe, it } from 'vitest';

// Wave 0 stub for slug + collision rules — implementation fills in plan 04-01 Task 2.
// Currently describe.skip; Task 2 of this plan replaces with real `describe(...)` blocks.

describe.skip('asciiSlug strips combining diacritics and emits ASCII lowercase hyphenated', () => {
  it('placeholder', () => {
    // TODO 04-01 Task 2
  });
});

describe.skip('asciiSlug returns "untitled" for input that normalizes to empty', () => {
  it('placeholder', () => {
    // TODO 04-01 Task 2
  });
});

describe.skip('buildSlugMap assigns -2/-3 suffixes for duplicates within the same category bucket', () => {
  it('placeholder', () => {
    // TODO 04-01 Task 2
  });
});

describe.skip('buildSlugMap buckets independently per categoryId so identical titles in different categories keep base slug', () => {
  it('placeholder', () => {
    // TODO 04-01 Task 2
  });
});

describe.skip('exportFilename produces {slug}-{YYYY-MM-DD}.{ext} with the correct extension', () => {
  it('placeholder', () => {
    // TODO 04-01 Task 2
  });
});

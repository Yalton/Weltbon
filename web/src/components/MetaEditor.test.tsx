import { describe, it, expect } from 'vitest';

describe.skip('MetaEditor (dup-key polish) — Wave 0 stub (Plan 07 fills in)', () => {
  it('placeholder', () => {
    expect(true).toBe(true);
  });
  // Plan 07 adds:
  //  - Existing behavior regression: add/remove/rename rows still works
  //  - Two rows with same key → both rows render with aria-invalid='true' and red ring
  //  - onValidityChange callback fires false while duplicates exist, true when resolved
  //  - When duplicates exist, internal value object is NOT updated (parent's
  //    onChange not called)
});

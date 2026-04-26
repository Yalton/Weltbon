import { describe, it, expect } from 'vitest';

describe.skip('LinkEditor (combobox autocomplete) — Wave 0 stub (Plan 06 fills in)', () => {
  it('placeholder', () => {
    expect(true).toBe(true);
  });
  // Plan 06 adds:
  //  - Relation field renders RelationCombobox (Popover-driven)
  //  - Typing 'cre' shows filtered suggestions sorted by count desc, with count
  //    beside each
  //  - Selecting suggestion populates the field
  //  - Pressing Enter on no-match keeps the typed string as the new label
  //  - Existing entry-search and bidirectional checkbox behavior unchanged (regression)
});

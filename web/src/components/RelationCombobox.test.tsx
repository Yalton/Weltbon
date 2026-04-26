import { describe, it, expect } from 'vitest';

describe.skip('RelationCombobox (standalone) — Wave 0 stub (Plan 06 fills in)', () => {
  it('placeholder', () => {
    expect(true).toBe(true);
  });
  // Plan 06 adds:
  //  - Renders standalone with controlled value/onChange
  //  - Popover opens on focus
  //  - Filter is prefix-insensitive (lowercased substring match)
  //  - Empty options + non-empty input → submit-on-Enter still calls onChange
  //    with the typed value
});

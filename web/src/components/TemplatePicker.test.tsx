import { describe, it, expect } from 'vitest';

describe.skip('TemplatePicker (picker dialog) — Wave 0 stub (Plan 07 fills in)', () => {
  it('placeholder', () => {
    expect(true).toBe(true);
  });
  // Plan 07 adds:
  //  - Renders 10 cards grouped by 5 categories
  //  - Selecting Blank navigates to /entries/new with NO state
  //  - Selecting Location navigates to /entries/new with
  //    state.template = entryTemplates.getTemplate('location')
  //  - Closing picker without selecting does NOT navigate
});

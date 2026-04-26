import { describe, it, expect } from 'vitest';

describe.skip('EntryTypesSection (chips/add/rename/delete UI) — Wave 0 stub (Plan 06 fills in)', () => {
  it('placeholder', () => {
    expect(true).toBe(true);
  });
  // Plan 06 adds:
  //  - Renders chips from universe.entryTypes
  //  - 'Add type' input + Enter triggers PATCH action=add mutation
  //  - Each chip has a remove × button
  //  - Each chip has a rename inline-edit affordance (double-click or pencil icon)
  //  - Remove flow: 0 entries → confirm + delete; >0 entries → fallback dialog
  //    with select
});

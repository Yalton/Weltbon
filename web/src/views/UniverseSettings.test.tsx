import { describe, it, expect } from 'vitest';

describe.skip('UniverseSettings (entry-types section) — Wave 0 stub (Plan 06 fills in)', () => {
  it('placeholder', () => {
    expect(true).toBe(true);
  });
  // Plan 06 adds:
  //  - Renders existing name+description fields (regression)
  //  - EntryTypesSection lists default 9 chips
  //  - Adding 'mythos' chip via input+enter calls PATCH with action=add
  //  - Removing 'culture' chip with no entries using it: confirm dialog →
  //    DELETE no fallback succeeds
  //  - Removing 'culture' chip with entries using it: 409 → fallback dialog
  //    opens with select listing remaining types
  //  - Renaming 'concept' → 'idea' via inline edit calls PATCH with action=rename
});

import { describe, it, expect } from 'vitest';

describe.skip('TimelineView (/timeline route) — Wave 0 stub (Plan 05 fills in)', () => {
  it('placeholder', () => {
    expect(true).toBe(true);
  });
  // Plan 05 adds:
  //  - Empty pins → renders EmptyState with 'No pins yet' copy
  //  - 3 pins (one era) → renders era as sticky section header, 2 non-era pins
  //    under it
  //  - Pins are clickable Links navigating to /universes/:uid/entries/:id
  //  - Sort ascending by position (assert DOM order)
});

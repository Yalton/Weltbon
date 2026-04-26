import { describe, it, expect } from 'vitest';

describe.skip('TimelinePinSection (per-entry pin section) — Wave 0 stub (Plan 05 fills in)', () => {
  it('placeholder', () => {
    expect(true).toBe(true);
  });
  // Plan 05 adds:
  //  - 'Not pinned' state with 'Add pin' button when no pin exists
  //  - Existing pin shows label + position + precision badge with Edit/Remove buttons
  //  - Add pin button opens PinEditor dialog (position + label + precision form)
  //  - Submit calls useUpsertTimelinePin mutation
  //  - Remove triggers ConfirmDialog → useDeleteTimelinePin
});

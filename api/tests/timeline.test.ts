import { describe, it, expect } from 'vitest';

describe.skip('Timeline routes (TIME-01..04) — Wave 0 stub (Plan 02 fills in)', () => {
  it('placeholder', () => {
    expect(true).toBe(true);
  });
  // Plan 02 adds:
  //  - POST /entries/:id/pin upserts (insert + duplicate POST replaces, no second row)
  //  - DB UNIQUE on entry_id rejects manual double-INSERT (23505)
  //  - Zod rejects non-finite position (NaN, Infinity, "abc" string)
  //  - Zod rejects precision not in enum
  //  - requireUniverse 403 on cross-tenant pin POST
  //  - DELETE /pin returns 204; 404 if no pin
  //  - Entry delete cascades to pin (FK)
  //  - GET /timeline returns sorted ASC by position with extreme floats (-10000, 0, 4.35e17)
  //  - GET /timeline includes joined entry title + type + icon
});

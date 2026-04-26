import { describe, it, expect } from 'vitest';

describe.skip('Universe entry-types CRUD (POL-02) — Wave 0 stub (Plan 03 fills in)', () => {
  it('placeholder', () => {
    expect(true).toBe(true);
  });
  // Plan 03 adds:
  //  - PATCH /universes/:id/entry-types with action=add appends + dedupes
  //  - PATCH with action=rename: array_replace + entries.entry_type cascade in one tx
  //    (verify both before/after under same connection)
  //  - DELETE /entry-types/:name without ?fallback returns 409 + count + type body
  //  - DELETE with ?fallback=valid: cascades entries.entry_type then array_remove
  //  - DELETE with ?fallback=invalid (not in entry_types) returns 400
  //  - DELETE with ?fallback=self (the same name being deleted) returns 400
  //  - All routes 403 on cross-tenant
  //  - GET /universes/:uid/relations returns [{label,count}] sorted by count desc,
  //    label tiebreak (POL-03 backend lives here too — covered by extending
  //    api/tests/links.test.ts in Plan 03)
});

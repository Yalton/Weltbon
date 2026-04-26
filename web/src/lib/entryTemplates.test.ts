import { describe, it, expect } from 'vitest';

describe.skip('entryTemplates (template lookup) — Wave 0 stub (Plan 04 fills in)', () => {
  it('placeholder', () => {
    expect(true).toBe(true);
  });
  // Plan 04 adds:
  //  - TEMPLATES contains exactly 10 entries (9 builtin types + Blank)
  //  - getTemplate('blank') returns the Blank template with empty body + meta
  //  - getTemplate('location') returns body containing '## Geography', meta keys
  //    'region','climate','population'
  //  - getTemplate(unknown) returns undefined
  //  - TEMPLATE_GROUPS has 5 groups (Setting, People, Things, Time, Other) and
  //    groups sum to 10
});

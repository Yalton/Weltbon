import { describe, it, expect } from 'vitest';

describe.skip('parsePosition (TIME-04 float parsing) — Wave 0 stub (Plan 04 fills in)', () => {
  it('placeholder', () => {
    expect(true).toBe(true);
  });
  // Plan 04 adds:
  //  - parsePosition('-10000') → ok
  //  - parsePosition('4.35e17') → ok
  //  - parsePosition('0') → ok (zero is valid)
  //  - parsePosition('') → error 'Required'
  //  - parsePosition('  ') → error 'Required'
  //  - parsePosition('10abc') → error (Number is strict)
  //  - parsePosition('NaN') → error (not finite)
  //  - parsePosition('Infinity') → error (not finite)
});

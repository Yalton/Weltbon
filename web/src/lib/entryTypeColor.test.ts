import { describe, it, expect } from 'vitest';
import { entryTypeHexColor, ENTRY_TYPE_NAMES } from './entryTypeColor';

describe('entryTypeHexColor', () => {
  it('returns 6-digit hex for every known type AND the unknown fallback', () => {
    // medallion.ts appends an alpha suffix directly (`${hue}33`), which is only valid
    // for 6-digit hex. A named color or rgb() here would silently produce garbage CSS —
    // no crash, no visual error in dev, just a disc that doesn't render. Pin it.
    for (const type of [...ENTRY_TYPE_NAMES, 'a-type-that-does-not-exist']) {
      expect(entryTypeHexColor(type)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

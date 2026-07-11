import { describe, it, expect } from 'vitest';
import { themeSchema } from '../src/routes/universes.js';
import { shareThemeSchema } from '../src/routes/share.js';

/**
 * Share-seam drift guard (spec §1.3 / project share-parity rule): the share
 * namespace declares its own theme schema (D-04 forbids importing from
 * routes/universes.ts), so this test pins the two schemas to identical
 * accept/reject behavior. If one side changes shape, this fails.
 */
const VALID = [
  {},
  { palette: 'ember' },
  { palette: 'observatory', accent: '#a1b2c3', displayFont: 'crimson' },
  { backdropAssetId: '4dcb44a5-8f6a-4f7e-9d0e-1c2b3a4d5e6f' },
];
const INVALID = [
  { palette: 'neon' },
  { accent: 'red' },
  { accent: '#ff00' },
  { displayFont: 'arial' },
  { backdropAssetId: 'nope' },
];

describe('theme schema parity (auth vs share)', () => {
  it.each(VALID.map((v, i) => [i, v] as const))('both accept valid fixture %#', (_i, v) => {
    expect(themeSchema.safeParse(v).success).toBe(true);
    expect(shareThemeSchema.safeParse(v).success).toBe(true);
  });

  it.each(INVALID.map((v, i) => [i, v] as const))('both reject invalid fixture %#', (_i, v) => {
    expect(themeSchema.safeParse(v).success).toBe(false);
    expect(shareThemeSchema.safeParse(v).success).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { themeSchema, patchSchema } from '../src/routes/universes.js';

describe('themeSchema', () => {
  it('accepts a full valid theme', () => {
    const r = themeSchema.safeParse({
      palette: 'ember',
      accent: '#ea580c',
      displayFont: 'cinzel',
      backdropAssetId: '4dcb44a5-8f6a-4f7e-9d0e-1c2b3a4d5e6f',
    });
    expect(r.success).toBe(true);
  });

  it('accepts an empty object and null', () => {
    expect(themeSchema.safeParse({}).success).toBe(true);
    expect(themeSchema.nullable().safeParse(null).success).toBe(true);
  });

  it('rejects bad hex accents', () => {
    expect(themeSchema.safeParse({ accent: 'red' }).success).toBe(false);
    expect(themeSchema.safeParse({ accent: '#ff00' }).success).toBe(false);
    expect(themeSchema.safeParse({ accent: '#gggggg' }).success).toBe(false);
  });

  it('rejects unknown palette and font enums', () => {
    expect(themeSchema.safeParse({ palette: 'neon' }).success).toBe(false);
    expect(themeSchema.safeParse({ displayFont: 'comic-sans' }).success).toBe(false);
  });

  it('rejects a non-uuid backdropAssetId', () => {
    expect(themeSchema.safeParse({ backdropAssetId: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('patchSchema with theme', () => {
  it('accepts theme alone as a valid patch', () => {
    expect(patchSchema.safeParse({ theme: { palette: 'verdant' } }).success).toBe(true);
  });

  it('accepts theme: null (reset)', () => {
    expect(patchSchema.safeParse({ theme: null }).success).toBe(true);
  });

  it('still rejects an empty patch', () => {
    expect(patchSchema.safeParse({}).success).toBe(false);
  });
});

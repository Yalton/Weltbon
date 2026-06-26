/**
 * Tests for MAP_GLYPHS, MAP_GLYPH_GROUPS, MAP_GLYPH_KEYS, and getGlyphPath.
 *
 * RED: MAP_GLYPH_GROUPS doesn't exist yet; MAP_GLYPHS has only 11 entries.
 * GREEN: After expansion to 25-35 glyphs + MAP_GLYPH_GROUPS export.
 */
import { describe, it, expect } from 'vitest';
import {
  MAP_GLYPHS,
  MAP_GLYPH_KEYS,
  MAP_GLYPH_GROUPS,
  getGlyphPath,
} from './mapGlyphs';

describe('MAP_GLYPHS — expanded glyph set', () => {
  it('has between 25 and 35 entries (D-01)', () => {
    const count = Object.keys(MAP_GLYPHS).length;
    expect(count).toBeGreaterThanOrEqual(25);
    expect(count).toBeLessThanOrEqual(35);
  });

  it('all values are literal path strings (T-40-10 invariant)', () => {
    for (const [key, val] of Object.entries(MAP_GLYPHS)) {
      expect(typeof val, `MAP_GLYPHS["${key}"] must be a string`).toBe('string');
      expect(val.trim(), `MAP_GLYPHS["${key}"] must start with <path`).toMatch(/^<path/);
    }
  });
});

describe('MAP_GLYPH_KEYS — auto-derived from MAP_GLYPHS', () => {
  it('contains exactly the keys present in MAP_GLYPHS', () => {
    expect(MAP_GLYPH_KEYS).toEqual(Object.keys(MAP_GLYPHS));
  });
});

describe('getGlyphPath', () => {
  it('returns path string for known keys', () => {
    expect(getGlyphPath('star')).toMatch(/^<path/);
  });

  it('returns null for unknown keys', () => {
    expect(getGlyphPath('__unknown_key__')).toBeNull();
  });
});

describe('MAP_GLYPH_GROUPS — themed grouping (D-01)', () => {
  const EXPECTED_THEMES = [
    'settlements',
    'terrain',
    'danger-war',
    'poi',
    'nature',
    'mystical',
  ];

  it('is exported and is a plain object', () => {
    expect(typeof MAP_GLYPH_GROUPS).toBe('object');
    expect(MAP_GLYPH_GROUPS).not.toBeNull();
  });

  it('has exactly six themes', () => {
    expect(Object.keys(MAP_GLYPH_GROUPS)).toHaveLength(6);
  });

  it('contains all six required theme keys', () => {
    for (const theme of EXPECTED_THEMES) {
      expect(
        MAP_GLYPH_GROUPS,
        `MAP_GLYPH_GROUPS must have a "${theme}" key`,
      ).toHaveProperty(theme);
    }
  });

  it('every glyph key in every group is present in MAP_GLYPHS', () => {
    for (const [theme, keys] of Object.entries(MAP_GLYPH_GROUPS)) {
      for (const key of keys) {
        expect(
          MAP_GLYPHS,
          `MAP_GLYPH_GROUPS["${theme}"] references unknown key "${key}"`,
        ).toHaveProperty(key);
      }
    }
  });

  it('every group has at least one key', () => {
    for (const [theme, keys] of Object.entries(MAP_GLYPH_GROUPS)) {
      expect(keys.length, `Group "${theme}" must have at least one key`).toBeGreaterThan(0);
    }
  });
});

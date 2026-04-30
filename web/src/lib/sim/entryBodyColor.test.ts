/**
 * Tests for entryTypeBodyColor helper.
 *
 * Per UI-SPEC §3.3 + §7.2:
 * - Dark theme: hex unchanged (L factor = 1.0)
 * - Light theme: L * 0.85 via oklch conversion — must return a different hex
 * - Unknown type returns neutral fallback (#6b7280 dark, adjusted light)
 * - Pure function; does NOT mutate entryTypeColor.ts table
 *
 * Luma encoding choice: HSL L * 0.85
 * (simpler than oklch pipeline; acceptable per plan; documented here)
 */

import { describe, it, expect } from 'vitest';
import { entryTypeBodyColor } from './entryBodyColor';

describe('entryTypeBodyColor', () => {
  it('dark theme: concept returns #3b82f6 (unchanged)', () => {
    expect(entryTypeBodyColor('concept', true)).toBe('#3b82f6');
  });

  it('dark theme: entity returns #10b981 (unchanged)', () => {
    expect(entryTypeBodyColor('entity', true)).toBe('#10b981');
  });

  it('dark theme: unknown type returns neutral fallback #6b7280', () => {
    expect(entryTypeBodyColor('unknown-type-xyz', true)).toBe('#6b7280');
  });

  it('light theme: concept does NOT return #3b82f6 (must be luma-adjusted)', () => {
    const result = entryTypeBodyColor('concept', false);
    expect(result).not.toBe('#3b82f6');
  });

  it('light theme: result is a valid 6-char hex string', () => {
    const result = entryTypeBodyColor('concept', false);
    expect(result).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('light theme: unknown type returns luma-adjusted neutral fallback (not #6b7280)', () => {
    const result = entryTypeBodyColor('unknown-type-xyz', false);
    // Must be a valid hex but NOT the original fallback
    expect(result).toMatch(/^#[0-9a-f]{6}$/i);
    expect(result).not.toBe('#6b7280');
  });

  it('is case-insensitive (Concept equals concept)', () => {
    expect(entryTypeBodyColor('Concept', true)).toBe(entryTypeBodyColor('concept', true));
  });

  it('covers all known types in dark mode (returns non-fallback hex)', () => {
    const types = ['concept', 'entity', 'location', 'event', 'faction', 'artifact', 'species', 'culture', 'thread'];
    const fallback = '#6b7280';
    for (const type of types) {
      const result = entryTypeBodyColor(type, true);
      expect(result).not.toBe(fallback);
      expect(result).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('light theme: all known types return a valid hex different from dark value', () => {
    const types = ['concept', 'entity', 'location', 'event', 'faction', 'artifact', 'species', 'culture', 'thread'];
    for (const type of types) {
      const dark = entryTypeBodyColor(type, true);
      const light = entryTypeBodyColor(type, false);
      expect(light).toMatch(/^#[0-9a-f]{6}$/i);
      expect(light).not.toBe(dark);
    }
  });
});

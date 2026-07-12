import { describe, it, expect } from 'vitest';
import { resolveMedallion, firstGrapheme, MEDALLION_SIZES } from './medallion';

describe('firstGrapheme', () => {
  it('takes the first letter, uppercased', () => {
    expect(firstGrapheme('Aldric')).toBe('A');
    expect(firstGrapheme('gondor')).toBe('G');
  });

  it('does not split an emoji into surrogate halves', () => {
    // '🜂Ash'[0] is a lone high surrogate — renders as mojibake.
    expect(firstGrapheme('🜂Ash')).toBe('🜂');
    expect(firstGrapheme('👑 Queen')).toBe('👑');
  });

  it('trims leading whitespace before picking', () => {
    expect(firstGrapheme('   Vale')).toBe('V');
  });

  it("falls back to '?' on an empty or whitespace-only title", () => {
    expect(firstGrapheme('')).toBe('?');
    expect(firstGrapheme('   ')).toBe('?');
  });
});

describe('resolveMedallion', () => {
  it('prefers a cover over everything else', () => {
    const m = resolveMedallion({
      title: 'Aldric',
      entryType: 'entity',
      icon: '👑',
      coverThumbUrl: '/api/universes/u1/assets/a1/thumb?e=1&s=ff',
    });
    expect(m.kind).toBe('cover');
    expect(m.coverUrl).toBe('/api/universes/u1/assets/a1/thumb?e=1&s=ff');
  });

  it('falls back to the icon when there is no cover', () => {
    const m = resolveMedallion({ title: 'Aldric', entryType: 'entity', icon: '👑' });
    expect(m.kind).toBe('icon');
    expect(m.icon).toBe('👑');
  });

  it('falls back to the monogram when there is neither cover nor icon', () => {
    const m = resolveMedallion({ title: 'Aldric', entryType: 'entity' });
    expect(m.kind).toBe('monogram');
    expect(m.monogram).toBe('A');
  });

  it('treats empty-string cover and icon as absent (the API sends "" for no icon)', () => {
    const m = resolveMedallion({
      title: 'Aldric',
      entryType: 'entity',
      icon: '',
      coverThumbUrl: '',
    });
    expect(m.kind).toBe('monogram');
  });

  it('hues the disc by entry type', () => {
    expect(resolveMedallion({ title: 'X', entryType: 'location' }).hue).toBe('#f59e0b');
    expect(resolveMedallion({ title: 'X', entryType: 'faction' }).hue).toBe('#a855f7');
    // Unknown type → neutral, never a crash.
    expect(resolveMedallion({ title: 'X', entryType: 'wyrd' }).hue).toBe('#6b7280');
  });

  it('builds the gradient disc and hairline ring from that hue', () => {
    const m = resolveMedallion({ title: 'X', entryType: 'location' });
    expect(m.discBackground).toBe(
      'radial-gradient(circle at 35% 30%, #f59e0b33, #f59e0b12)',
    );
    expect(m.ringColor).toBe('#f59e0b55');
  });

  it('exposes the three sizes from the spec', () => {
    expect(MEDALLION_SIZES).toEqual({ sm: 36, md: 44, lg: 52 });
  });
});

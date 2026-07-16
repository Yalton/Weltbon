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

  it('leaves a single-emoji title intact (.toUpperCase() is a no-op on it)', () => {
    expect(firstGrapheme('🜂')).toBe('🜂');
  });

  it('keeps a base+combining-accent together as one grapheme', () => {
    // Decomposed 'e' + U+0301 COMBINING ACUTE, written as escapes so the source
    // encoding can't silently precompose it. Code-point slicing would drop the
    // accent and yield a bare 'E'; Segmenter keeps the cluster whole.
    const m = firstGrapheme('évry');
    expect([...m]).toHaveLength(2); // base + combining mark, not truncated
    expect(m).toBe('É');
    expect(m.normalize('NFC')).toBe('É'); // É
  });

  it('trims leading whitespace before picking', () => {
    expect(firstGrapheme('   Vale')).toBe('V');
  });

  it("falls back to '?' on an empty or whitespace-only title", () => {
    expect(firstGrapheme('')).toBe('?');
    expect(firstGrapheme('   ')).toBe('?');
  });

  it('falls back to code-point slicing when Intl.Segmenter is unavailable (older browsers)', () => {
    const original = (Intl as { Segmenter?: unknown }).Segmenter;
    delete (Intl as { Segmenter?: unknown }).Segmenter;
    try {
      expect(firstGrapheme('Aldric')).toBe('A');
      expect(firstGrapheme('🜂Ash')).toBe('🜂'); // surrogate pair still safe
    } finally {
      (Intl as { Segmenter?: unknown }).Segmenter = original;
    }
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

  it('resolves a cover on its own, with no icon present', () => {
    const m = resolveMedallion({
      title: 'Aldric',
      entryType: 'entity',
      coverThumbUrl: '/api/universes/u1/assets/a1/thumb?e=1&s=ff',
    });
    expect(m.kind).toBe('cover');
    expect(m.icon).toBeNull();
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

  it('treats null cover and icon as absent (null is what the API sends for no cover)', () => {
    const m = resolveMedallion({
      title: 'Aldric',
      entryType: 'entity',
      icon: null,
      coverThumbUrl: null,
    });
    expect(m.kind).toBe('monogram');
    expect(m.coverUrl).toBeNull();
    expect(m.icon).toBeNull();
  });

  it('hues the disc by entry type', () => {
    expect(resolveMedallion({ title: 'X', entryType: 'location' }).hue).toBe('#f59e0b');
    expect(resolveMedallion({ title: 'X', entryType: 'faction' }).hue).toBe('#a855f7');
    // Unknown type → neutral, never a crash.
    expect(resolveMedallion({ title: 'X', entryType: 'wyrd' }).hue).toBe('#6b7280');
  });

  it('builds the gradient disc and hairline ring from that hue (HTML renderer)', () => {
    const m = resolveMedallion({ title: 'X', entryType: 'location' });
    expect(m.html.discBackground).toBe(
      'radial-gradient(circle at 35% 30%, #f59e0b33, #f59e0b12)',
    );
    expect(m.html.ringColor).toBe('#f59e0b55');
  });

  it('exposes a flat disc fill for the SVG renderer, which cannot take a gradient', () => {
    const m = resolveMedallion({ title: 'X', entryType: 'location' });
    expect(m.svg.discFill).toBe('#f59e0b');
    expect(m.svg.discFillOpacity).toBe(0.18);
  });

  it('exposes the three sizes from the spec', () => {
    expect(MEDALLION_SIZES).toEqual({ sm: 36, md: 44, lg: 52 });
  });
});

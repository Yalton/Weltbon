import { describe, it, expect } from 'vitest';
import { asciiSlug, buildSlugMap, exportFilename } from '../src/services/export/slug.js';

describe('asciiSlug', () => {
  it('lowercases and hyphenates a normal title', () => {
    expect(asciiSlug('The Sundering: A Definitive Account')).toBe('the-sundering-a-definitive-account');
  });

  it('strips combining diacritics via NFKD normalization', () => {
    expect(asciiSlug('Café')).toBe('cafe');
  });

  it('returns "untitled" for input that normalizes to empty', () => {
    expect(asciiSlug('---')).toBe('untitled');
    expect(asciiSlug('')).toBe('untitled');
  });

  it('collapses runs of non-alphanumerics into single hyphens and trims', () => {
    expect(asciiSlug('  foo!!! bar??? ')).toBe('foo-bar');
  });
});

describe('buildSlugMap', () => {
  it('assigns base slug to first entry and -2 suffix to a duplicate within the same category', () => {
    const map = buildSlugMap([
      { id: 'a', title: 'Foo', categoryId: 'cat-1' },
      { id: 'b', title: 'Foo', categoryId: 'cat-1' },
    ]);
    expect(map.get('a')).toBe('foo');
    expect(map.get('b')).toBe('foo-2');
  });

  it('assigns -3 to the third duplicate within the same category', () => {
    const map = buildSlugMap([
      { id: 'a', title: 'Foo', categoryId: 'cat-1' },
      { id: 'b', title: 'Foo', categoryId: 'cat-1' },
      { id: 'c', title: 'Foo', categoryId: 'cat-1' },
    ]);
    expect(map.get('c')).toBe('foo-3');
  });

  it('buckets independently per categoryId so identical titles in different categories both get base', () => {
    const map = buildSlugMap([
      { id: 'a', title: 'Foo', categoryId: 'cat-1' },
      { id: 'b', title: 'Foo', categoryId: 'cat-2' },
    ]);
    expect(map.get('a')).toBe('foo');
    expect(map.get('b')).toBe('foo');
  });

  it('treats categoryId=null as the "uncategorized" bucket', () => {
    const map = buildSlugMap([
      { id: 'a', title: 'Foo', categoryId: null },
      { id: 'b', title: 'Foo', categoryId: null },
    ]);
    expect(map.get('a')).toBe('foo');
    expect(map.get('b')).toBe('foo-2');
  });
});

describe('exportFilename', () => {
  it('produces {slug}-{YYYY-MM-DD}.{ext} for a normal universe name', () => {
    expect(exportFilename('Post Sundering', 'zip')).toMatch(/^post-sundering-\d{4}-\d{2}-\d{2}\.zip$/);
  });

  it('falls back to "universe" when the universe name normalizes to empty', () => {
    expect(exportFilename('', 'pdf')).toMatch(/^universe-\d{4}-\d{2}-\d{2}\.pdf$/);
  });

  it('uses the requested extension verbatim', () => {
    expect(exportFilename('My World', 'docx')).toMatch(/\.docx$/);
    expect(exportFilename('My World', 'json')).toMatch(/\.json$/);
  });
});

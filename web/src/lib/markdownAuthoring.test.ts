import { describe, expect, it } from 'vitest';
import {
  collectMarkdownHeadings,
  parseMarkdownFrontmatter,
  replaceSupportedFrontmatterTags,
} from './markdownAuthoring';

describe('markdown authoring dialect helpers', () => {
  it('extracts document-start frontmatter tags in flow syntax', () => {
    const markdown = '---\ntitle: A story\ntags: [one, two]\ncustom: keep\n---\n# Heading\n';
    expect(parseMarkdownFrontmatter(markdown)).toEqual({
      raw: '---\ntitle: A story\ntags: [one, two]\ncustom: keep\n---',
      tags: ['one', 'two'],
      diagnostics: [],
    });
  });

  it('extracts list tags and replaces only the supported tags field', () => {
    const markdown = '---\ntitle: A story\ntags:\n  - one\n  - two\ncustom: keep\n---\nBody';
    expect(parseMarkdownFrontmatter(markdown).tags).toEqual(['one', 'two']);
    expect(replaceSupportedFrontmatterTags(markdown, ['new', 'tag'])).toBe(
      '---\ntitle: A story\ntags: [new, tag]\ncustom: keep\n---\nBody',
    );
  });

  it('adds tags with a valid fence separator when frontmatter has no tags', () => {
    expect(replaceSupportedFrontmatterTags('---\ntitle: A\n---\nBody', ['x'])).toBe(
      '---\ntitle: A\ntags: [x]\n---\nBody',
    );
    expect(replaceSupportedFrontmatterTags('---\n---\nBody', ['x'])).toBe('---\ntags: [x]\n---\nBody');
  });

  it('keeps malformed, duplicate, and complex tag fields byte-for-byte', () => {
    for (const markdown of [
      '---\ntags: ["unterminated]\n---\nBody',
      '---\ntags: ["a"b"]\n---\nBody',
      '---\ntags:\n  - "unterminated\n---\nBody',
      '---\ntags:\n  - "a"b"\n---\nBody',
      '---\ntags: [one]\ntags: [two]\n---\nBody',
      '---\ntags: [[nested]]\n---\nBody',
    ]) {
      expect(parseMarkdownFrontmatter(markdown).diagnostics).not.toEqual([]);
      expect(replaceSupportedFrontmatterTags(markdown, ['new'])).toBe(markdown);
    }
  });

  it('quotes inserted tag values that are not safe plain YAML scalars', () => {
    expect(replaceSupportedFrontmatterTags('---\ntags: [one]\n---\nBody', ['a,b', 'x]y'])).toBe(
      '---\ntags: ["a,b", "x]y"]\n---\nBody',
    );
  });

  it('preserves unknown frontmatter and all markdown syntax when changing tags', () => {
    const markdown =
      '---\ncustom: "x: y"\ntags: [one]\nunknown:\n  nested: true\n---\n> [!note]\n> [[Entry]] ![[asset]] ![alt](asset://abc)\n';
    expect(replaceSupportedFrontmatterTags(markdown, ['two'])).toBe(
      '---\ncustom: "x: y"\ntags: [two]\nunknown:\n  nested: true\n---\n> [!note]\n> [[Entry]] ![[asset]] ![alt](asset://abc)\n',
    );
  });

  it('falls back losslessly for malformed or non-leading frontmatter', () => {
    const malformed = '---\ntags: [one\n---\n# Body';
    expect(parseMarkdownFrontmatter(malformed).raw).toBe(malformed);
    expect(parseMarkdownFrontmatter(malformed).tags).toEqual([]);
    expect(replaceSupportedFrontmatterTags(malformed, ['two'])).toBe(malformed);

    const nonLeading = '\n---\ntags: [one]\n---\nBody';
    expect(parseMarkdownFrontmatter(nonLeading).raw).toBeNull();
    expect(replaceSupportedFrontmatterTags(nonLeading, ['two'])).toBe(nonLeading);
  });

  it('collects headings while ignoring fenced code and frontmatter', () => {
    const markdown = '---\ntitle: x\n---\n# One\n## Two {#custom}\n```md\n# Not a heading\n```\n';
    expect(collectMarkdownHeadings(markdown)).toEqual([
      { level: 1, text: 'One', slug: 'one' },
      { level: 2, text: 'Two', slug: 'custom' },
    ]);
  });
});

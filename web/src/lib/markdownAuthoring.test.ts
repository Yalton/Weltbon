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

  it('parses serializer-emitted quoted commas, quotes, and Unicode tags', () => {
    const markdown = '---\ntags: ["a, b", "say \\\"hi\\\"", "café"]\n---\nBody';

    expect(parseMarkdownFrontmatter(markdown)).toMatchObject({
      tags: ['a, b', 'say "hi"', 'café'],
      diagnostics: [],
    });
  });

  it('fails closed when an unknown frontmatter value has an unterminated quote', () => {
    const markdown = '---\ntitle: "unterminated\ntags: [one]\n---\nBody';

    expect(parseMarkdownFrontmatter(markdown).diagnostics).not.toEqual([]);
    expect(replaceSupportedFrontmatterTags(markdown, ['two'])).toBe(markdown);
  });

  it('accepts quoted text inside an unknown literal block scalar and still patches tags', () => {
    const markdown = '---\ndescription: |\n  The author\'s "quoted" text.\ntags: [one]\n---\nBody';

    expect(parseMarkdownFrontmatter(markdown).diagnostics).toEqual([]);
    expect(replaceSupportedFrontmatterTags(markdown, ['two'])).toBe(
      '---\ndescription: |\n  The author\'s "quoted" text.\ntags: [two]\n---\nBody',
    );
  });

  it('fails closed for unresolved unknown YAML aliases', () => {
    const markdown = '---\nunknown: *missing\ntags: [one]\n---\nBody';

    expect(parseMarkdownFrontmatter(markdown).diagnostics).not.toEqual([]);
    expect(replaceSupportedFrontmatterTags(markdown, ['two'])).toBe(markdown);
  });

  it('fails closed when a tag item is a flow mapping', () => {
    const markdown = '---\ntags: [a: b]\n---\nBody';

    expect(parseMarkdownFrontmatter(markdown).diagnostics).not.toEqual([]);
    expect(replaceSupportedFrontmatterTags(markdown, ['two'])).toBe(markdown);
  });

  it('fails closed when a tag item is an alias, even when the alias resolves', () => {
    const markdown = '---\nsource: &tag one\ntags: [*tag]\n---\nBody';

    expect(parseMarkdownFrontmatter(markdown).diagnostics).not.toEqual([]);
    expect(replaceSupportedFrontmatterTags(markdown, ['two'])).toBe(markdown);
  });

  it('fails closed when the tags sequence is anchored or explicitly tagged', () => {
    for (const markdown of [
      '---\ntags: &t [one]\nunknown: *t\n---\nBody',
      '---\ntags: !!seq [one]\n---\nBody',
    ]) {
      expect(parseMarkdownFrontmatter(markdown).diagnostics).not.toEqual([]);
      expect(replaceSupportedFrontmatterTags(markdown, ['two'])).toBe(markdown);
    }
  });

  it('fails closed when the tags key is quoted or indented', () => {
    for (const markdown of [
      '---\n"tags": [one]\n---\nBody',
      '---\n  tags: [one]\n---\nBody',
    ]) {
      expect(parseMarkdownFrontmatter(markdown).diagnostics).not.toEqual([]);
      expect(replaceSupportedFrontmatterTags(markdown, ['two'])).toBe(markdown);
    }
  });

  it('fails closed when a tag item is a literal or folded multiline scalar', () => {
    for (const markdown of [
      '---\ntags:\n  - |\n    literal\n    value\n---\nBody',
      '---\ntags:\n  - >\n    folded\n    value\n---\nBody',
    ]) {
      expect(parseMarkdownFrontmatter(markdown).diagnostics).not.toEqual([]);
      expect(replaceSupportedFrontmatterTags(markdown, ['two'])).toBe(markdown);
    }
  });

  it('fails closed when a block tags header has an inline comment', () => {
    const markdown = '---\ntags: # note\n  - one\n---\nBody';

    expect(parseMarkdownFrontmatter(markdown).diagnostics).not.toEqual([]);
    expect(replaceSupportedFrontmatterTags(markdown, ['two'])).toBe(markdown);
  });

  it('fails closed for explicit tags keys without canonical same-line syntax', () => {
    const markdown = '---\n? tags\n: [one]\n---\nBody';

    expect(parseMarkdownFrontmatter(markdown).diagnostics).not.toEqual([]);
    expect(replaceSupportedFrontmatterTags(markdown, ['two'])).toBe(markdown);
  });

  it('fails closed when comments occur inside a block tags list', () => {
    for (const markdown of [
      '---\ntags:\n  - one # note\n---\nBody',
      '---\ntags:\n  # note\n  - one\n---\nBody',
    ]) {
      expect(parseMarkdownFrontmatter(markdown).diagnostics).not.toEqual([]);
      expect(replaceSupportedFrontmatterTags(markdown, ['two'])).toBe(markdown);
    }
  });

  it('fails closed for wrapped flow tag sequences', () => {
    const markdown = '---\ntags: [one,\n  two]\n---\nBody';

    expect(parseMarkdownFrontmatter(markdown).diagnostics).not.toEqual([]);
    expect(replaceSupportedFrontmatterTags(markdown, ['three'])).toBe(markdown);
  });

  it('fails closed for plain multiline tag scalars', () => {
    const markdown = '---\ntags:\n  - one\n    continuation\n---\nBody';

    expect(parseMarkdownFrontmatter(markdown).diagnostics).not.toEqual([]);
    expect(replaceSupportedFrontmatterTags(markdown, ['two'])).toBe(markdown);
  });

  it('diagnoses prefixes where frontmatter cannot be safely prepended', () => {
    for (const markdown of ['\nBody', '\r\nBody', '--- heading\nBody']) {
      expect(parseMarkdownFrontmatter(markdown).diagnostics).not.toEqual([]);
      expect(replaceSupportedFrontmatterTags(markdown, ['one'])).toBe(markdown);
    }
  });

  it('requires the exact canonical tags: key syntax', () => {
    for (const markdown of [
      '---\ntags : [one]\n---\nBody',
      '---\ntags\t: [one]\n---\nBody',
    ]) {
      expect(parseMarkdownFrontmatter(markdown).diagnostics).not.toEqual([]);
      expect(replaceSupportedFrontmatterTags(markdown, ['two'])).toBe(markdown);
    }
  });

  it('does not create tags in a non-mapping frontmatter root', () => {
    const markdown = '---\n- retained\n---\nBody';

    expect(parseMarkdownFrontmatter(markdown).diagnostics).not.toEqual([]);
    expect(replaceSupportedFrontmatterTags(markdown, ['two'])).toBe(markdown);
  });

  it('quotes a hyphen-only tag so YAML keeps it a string', () => {
    const updated = replaceSupportedFrontmatterTags('---\ntitle: Story\n---\nBody', ['-']);

    expect(updated).toBe('---\ntitle: Story\ntags: ["-"]\n---\nBody');
    expect(parseMarkdownFrontmatter(updated).tags).toEqual(['-']);
  });

  it('parses single-quoted tags containing commas and double quotes', () => {
    const markdown = '---\ntags: [\'say "hi, friend"\', \'plain\']\n---\nBody';

    expect(parseMarkdownFrontmatter(markdown)).toMatchObject({
      tags: ['say "hi, friend"', 'plain'],
      diagnostics: [],
    });
  });

  it('quotes YAML-implicit tag scalars and keeps them strings after serialization', () => {
    const updated = replaceSupportedFrontmatterTags('---\ntitle: Story\n---\nBody', [
      'true', 'null', '123', '2024-01-01', 'safe-tag',
    ]);

    expect(updated).toBe(
      '---\ntitle: Story\ntags: ["true", "null", "123", "2024-01-01", safe-tag]\n---\nBody',
    );
    expect(parseMarkdownFrontmatter(updated).tags).toEqual([
      'true', 'null', '123', '2024-01-01', 'safe-tag',
    ]);
  });

  it('creates a leading frontmatter block while preserving an existing body and line endings', () => {
    expect(replaceSupportedFrontmatterTags('Body\r\n', ['café'])).toBe(
      '---\r\ntags: ["café"]\r\n---\r\nBody\r\n',
    );
  });

  it('keeps an explicit empty tags field after removing the final chip', () => {
    expect(replaceSupportedFrontmatterTags('---\r\ntitle: Story\r\ntags:\r\n  - one\r\ncustom: keep\r\n---\r\nBody', [])).toBe(
      '---\r\ntitle: Story\r\ntags: []\r\ncustom: keep\r\n---\r\nBody',
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

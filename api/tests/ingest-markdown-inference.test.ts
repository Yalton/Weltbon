/**
 * Unit tests for api/src/services/ingest-markdown.ts inference helpers.
 * Each test block names the decision-document clause (D-XX) it pins.
 *
 * Fixture files are read from api/tests/fixtures/ingest/vault-basic/
 * via readFileSync for integration with the fixture vault.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  parseFrontmatter,
  inferTitle,
  inferType,
  inferTags,
  inferCategory,
  normalizeFilename,
  isHiddenPath,
  isMarkdownFile,
  FILENAME_PREFIX_TYPES,
  IRREGULAR_PLURALS,
} from '../src/services/ingest-markdown.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VAULT = join(__dirname, 'fixtures/ingest/vault-basic');

function readFixture(relPath: string): string {
  return readFileSync(join(VAULT, relPath), 'utf-8');
}

// ---------------------------------------------------------------------------
// describe('parseFrontmatter') — D-13/D-13a
// ---------------------------------------------------------------------------
describe('parseFrontmatter', () => {
  it('D-13: returns empty data and raw text when no frontmatter delimiters', () => {
    const content = readFixture('no-h1-or-frontmatter.md');
    const result = parseFrontmatter(content);
    expect(result.data).toEqual({});
    expect(result.body).toBe(content);
  });

  it('D-13: extracts frontmatter and returns body without ---...--- block', () => {
    const content = readFixture('note-with-frontmatter.md');
    const result = parseFrontmatter(content);
    expect(result.data.title).toBe('Custom Title');
    expect(result.data.type).toBe('location');
    expect(Array.isArray(result.data.tags)).toBe(true);
    // body should NOT contain the frontmatter block
    expect(result.body).not.toContain('---');
    expect(result.body).toContain('# Different H1');
  });

  it('D-13a: converts YAML date scalar to ISO 8601 string (not Date object)', () => {
    const content = readFixture('yaml-dates.md');
    const result = parseFrontmatter(content);
    // gray-matter returns Date objects by default; parseFrontmatter converts them
    expect(typeof result.data.created).toBe('string');
    expect(result.data.created).toBe('2024-01-15T00:00:00.000Z');
    expect(typeof result.data.updated).toBe('string');
    expect(result.data.updated).toBe('2024-06-30T00:00:00.000Z');
  });

  it('D-13: handles missing closing --- gracefully (no throw)', () => {
    const malformed = `---\ntitle: Oops\n\nBody without closing fence.`;
    expect(() => parseFrontmatter(malformed)).not.toThrow();
    // gray-matter treats this as no-frontmatter when there is no closing ---
    const result = parseFrontmatter(malformed);
    expect(result).toBeDefined();
    expect(result.body).toBeDefined();
  });

  it('D-13: handles BOM-prefixed input', () => {
    const bomContent = '﻿---\ntitle: BOM Test\n---\nBody here.';
    const result = parseFrontmatter(bomContent);
    expect(result.data.title).toBe('BOM Test');
    expect(result.body.trim()).toBe('Body here.');
  });
});

// ---------------------------------------------------------------------------
// describe('inferTitle') — D-10/D-10a
// ---------------------------------------------------------------------------
describe('inferTitle', () => {
  it('D-10 step 1: returns frontmatter title when present and non-empty', () => {
    const content = readFixture('note-with-frontmatter.md');
    const { data, body } = parseFrontmatter(content);
    expect(inferTitle(data, body, 'note-with-frontmatter.md')).toBe('Custom Title');
  });

  it('D-10 step 2: returns first H1 when frontmatter title is absent', () => {
    const content = readFixture('Plain Heading Note.md');
    const { data, body } = parseFrontmatter(content);
    expect(inferTitle(data, body, 'Plain Heading Note.md')).toBe('The Real Title');
  });

  it('D-10 step 2: returns first H1 when there are multiple H1s', () => {
    const { data, body } = parseFrontmatter('# First H1\n\nBody text.\n\n# Second H1\n');
    expect(inferTitle(data, body, 'multiple-h1.md')).toBe('First H1');
  });

  it('D-10 step 3: returns normalized filename when neither frontmatter nor H1 present', () => {
    const content = readFixture('no-h1-or-frontmatter.md');
    const { data, body } = parseFrontmatter(content);
    expect(inferTitle(data, body, 'no-h1-or-frontmatter.md')).toBe('No h1 or frontmatter');
  });

  it('D-10a: normalization replaces _ and - with spaces, capitalizes only first letter', () => {
    const { data, body } = parseFrontmatter('Just a body.');
    expect(inferTitle(data, body, 'my-cool-entry.md')).toBe('My cool entry');
    expect(inferTitle(data, body, 'my_cool_entry.md')).toBe('My cool entry');
  });

  it('D-10a: strips .md extension when normalizing filename', () => {
    const { data, body } = parseFrontmatter('Just a body.');
    expect(inferTitle(data, body, 'loc_minas_tirith.md')).toBe('Loc minas tirith');
  });

  it('D-10 step 1: empty frontmatter title falls through to H1', () => {
    const content = '---\ntitle: ""\n---\n# Real H1\n';
    const { data, body } = parseFrontmatter(content);
    expect(inferTitle(data, body, 'test.md')).toBe('Real H1');
  });

  it('D-10 step 1: whitespace-only frontmatter title falls through to H1', () => {
    const content = '---\ntitle: "   "\n---\n# Real H1\n';
    const { data, body } = parseFrontmatter(content);
    expect(inferTitle(data, body, 'test.md')).toBe('Real H1');
  });
});

// ---------------------------------------------------------------------------
// describe('inferType') — D-11/D-11a
// ---------------------------------------------------------------------------
describe('inferType', () => {
  const VALID_TYPES = ['character', 'location', 'concept', 'event', 'faction', 'item', 'organization'];

  it('D-11 step 1: returns frontmatter type when present and in validTypes', () => {
    const content = readFixture('note-with-frontmatter.md');
    const { data } = parseFrontmatter(content);
    expect(inferType(data, 'note-with-frontmatter.md', VALID_TYPES)).toBe('location');
  });

  it('D-11 step 1: frontmatter type case-folds to match (Character -> character)', () => {
    const { data } = parseFrontmatter('---\ntype: Character\n---\n');
    expect(inferType(data, 'test.md', VALID_TYPES)).toBe('character');
  });

  it('D-11: falls through to step 2 when frontmatter type not in validTypes', () => {
    const { data } = parseFrontmatter('---\ntype: dragon\n---\n');
    // "dragon" not in VALID_TYPES; should fall through to folder/filename heuristics
    const result = inferType(data, 'locations/dragon.md', VALID_TYPES);
    expect(result).toBe('location'); // folder "locations" -> "location"
  });

  it('D-11 step 2: singularizes folder names with irregular plurals (characters -> character)', () => {
    const { data } = parseFrontmatter('');
    expect(inferType(data, 'characters/aragorn.md', VALID_TYPES)).toBe('character');
  });

  it('D-11 step 2: walks up path segments deepest-to-shallowest (heroes -> hero not found, characters -> character found)', () => {
    const content = readFixture('characters/heroes/aragorn.md');
    const { data } = parseFrontmatter(content);
    const result = inferType(data, 'characters/heroes/aragorn.md', VALID_TYPES);
    expect(result).toBe('character');
  });

  it('D-11 step 3: filename prefix loc_ -> location', () => {
    const content = readFixture('loc_minas_tirith.md');
    const { data } = parseFrontmatter(content);
    expect(inferType(data, 'loc_minas_tirith.md', VALID_TYPES)).toBe('location');
  });

  it('D-11 step 3: FILENAME_PREFIX_TYPES covers all prefix mappings', () => {
    expect(FILENAME_PREFIX_TYPES['loc_']).toBe('location');
    expect(FILENAME_PREFIX_TYPES['char_']).toBe('character');
    expect(FILENAME_PREFIX_TYPES['evt_']).toBe('event');
    expect(FILENAME_PREFIX_TYPES['org_']).toBe('organization');
    expect(FILENAME_PREFIX_TYPES['fac_']).toBe('faction');
    expect(FILENAME_PREFIX_TYPES['item_']).toBe('item');
    expect(FILENAME_PREFIX_TYPES['con_']).toBe('concept');
  });

  it('D-11 step 4: returns concept when nothing matched and concept is in validTypes', () => {
    const { data } = parseFrontmatter('');
    expect(inferType(data, 'some-random-note.md', VALID_TYPES)).toBe('concept');
  });

  it('D-11 step 4: returns validTypes[0] when nothing matched and concept NOT in validTypes', () => {
    const { data } = parseFrontmatter('');
    const typesWithoutConcept = ['character', 'location', 'event'];
    expect(inferType(data, 'some-random-note.md', typesWithoutConcept)).toBe('character');
  });
});

// ---------------------------------------------------------------------------
// describe('inferTags') — D-12/D-12a/D-17b
// ---------------------------------------------------------------------------
describe('inferTags', () => {
  it('D-12: merges frontmatter tags with inline body tags, lowercase deduped sorted', () => {
    const { data, body } = parseFrontmatter('---\ntags:\n  - Foo\n  - BAR\n---\nBody text with #baz in it.\n');
    const tags = inferTags(data, body);
    expect(tags).toEqual(['bar', 'baz', 'foo']);
  });

  it('D-12: accepts frontmatter tags as comma-separated string (Obsidian convention)', () => {
    const { data, body } = parseFrontmatter('---\ntags: "foo, bar"\n---\nBody with #baz.\n');
    const tags = inferTags(data, body);
    expect(tags).toContain('foo');
    expect(tags).toContain('bar');
    expect(tags).toContain('baz');
  });

  it('D-12: accepts frontmatter tags as YAML array', () => {
    const content = readFixture('note-with-frontmatter.md');
    const { data, body } = parseFrontmatter(content);
    const tags = inferTags(data, body);
    expect(tags).toContain('foo');
    expect(tags).toContain('bar');
  });

  it('D-17b: skips #tag inside fenced code blocks (remark AST tokenizer, NOT raw regex)', () => {
    const content = readFixture('inline-tag-in-code.md');
    const { data, body } = parseFrontmatter(content);
    const tags = inferTags(data, body);
    expect(tags).toContain('real-tag');
    expect(tags).not.toContain('tag-in-code');
    expect(tags).not.toContain('also-in-code');
  });

  it('D-17b: skips #tag inside inline `code` spans', () => {
    const { data, body } = parseFrontmatter('No frontmatter.\n\nThis has `#inline-code-tag` that must not be extracted.\n\nBut #body-tag is valid.\n');
    const tags = inferTags(data, body);
    expect(tags).not.toContain('inline-code-tag');
    expect(tags).toContain('body-tag');
  });

  it('D-12: regex pattern allows [a-z0-9_-]+ after the # (case-insensitive input)', () => {
    const { data, body } = parseFrontmatter('#tag1 #tag-two #tag_three #TAG4');
    const tags = inferTags(data, body);
    expect(tags).toContain('tag1');
    expect(tags).toContain('tag-two');
    expect(tags).toContain('tag_three');
    expect(tags).toContain('tag4');
  });

  it('D-12: deduplicates case-insensitively (#Foo and #foo collapse to foo)', () => {
    const { data, body } = parseFrontmatter('---\ntags: [Foo]\n---\n#foo #FOO body text\n');
    const tags = inferTags(data, body);
    expect(tags.filter(t => t === 'foo').length).toBe(1);
  });

  it('D-12a: body string is returned unchanged (inline #tags left in body)', () => {
    const originalBody = 'This has #real-tag in it.\n';
    const { data, body } = parseFrontmatter(originalBody);
    inferTags(data, body);
    // body is not mutated - inline tags stay in the body text
    expect(body).toContain('#real-tag');
  });
});

// ---------------------------------------------------------------------------
// describe('inferCategory') — D-07
// ---------------------------------------------------------------------------
describe('inferCategory', () => {
  it('D-07: returns deepest folder name for deeply nested path', () => {
    expect(inferCategory('characters/heroes/aragorn.md')).toBe('heroes');
  });

  it('D-07: returns null for files at root', () => {
    expect(inferCategory('note.md')).toBeNull();
  });

  it('D-07: returns null for empty string path', () => {
    expect(inferCategory('')).toBeNull();
  });

  it('D-07: returns single folder name for one-level deep path', () => {
    expect(inferCategory('locations/rivendell.md')).toBe('locations');
  });

  it('D-07: preserves case (does NOT lowercase)', () => {
    expect(inferCategory('MyFolder/note.md')).toBe('MyFolder');
  });
});

// ---------------------------------------------------------------------------
// describe('isHiddenPath / isMarkdownFile')
// ---------------------------------------------------------------------------
describe('isHiddenPath / isMarkdownFile', () => {
  it('isHiddenPath: .obsidian/workspace.json -> true (D-08a)', () => {
    expect(isHiddenPath('.obsidian/workspace.json')).toBe(true);
  });

  it('isHiddenPath: .trash/old.md -> true (D-08a)', () => {
    expect(isHiddenPath('.trash/old.md')).toBe(true);
  });

  it('isHiddenPath: characters/heroes/aragorn.md -> false', () => {
    expect(isHiddenPath('characters/heroes/aragorn.md')).toBe(false);
  });

  it('isHiddenPath: a/.b/c.md -> true (any segment starting with .)', () => {
    expect(isHiddenPath('a/.b/c.md')).toBe(true);
  });

  it('isMarkdownFile: foo.md -> true', () => {
    expect(isMarkdownFile('foo.md')).toBe(true);
  });

  it('isMarkdownFile: foo.MD -> true (case-insensitive)', () => {
    expect(isMarkdownFile('foo.MD')).toBe(true);
  });

  it('isMarkdownFile: foo.txt -> false', () => {
    expect(isMarkdownFile('foo.txt')).toBe(false);
  });

  it('isMarkdownFile: foo (no extension) -> false', () => {
    expect(isMarkdownFile('foo')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Additional: IRREGULAR_PLURALS export — D-11 step 2
// ---------------------------------------------------------------------------
describe('IRREGULAR_PLURALS', () => {
  it('D-11: exports IRREGULAR_PLURALS with all required irregular plural mappings', () => {
    expect(IRREGULAR_PLURALS['heroes']).toBe('hero');
    expect(IRREGULAR_PLURALS['characters']).toBe('character');
    expect(IRREGULAR_PLURALS['locations']).toBe('location');
    expect(IRREGULAR_PLURALS['events']).toBe('event');
    expect(IRREGULAR_PLURALS['items']).toBe('item');
    expect(IRREGULAR_PLURALS['factions']).toBe('faction');
    expect(IRREGULAR_PLURALS['organizations']).toBe('organization');
    expect(IRREGULAR_PLURALS['concepts']).toBe('concept');
  });
});

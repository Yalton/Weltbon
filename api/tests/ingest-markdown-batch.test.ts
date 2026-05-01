/**
 * Tests for api/src/services/ingest-markdown.ts — scanWikilinks + parseBatch
 *
 * Covers:
 *   D-01  case-insensitive title matching
 *   D-02  alias syntax [[Target|Display]]
 *   D-03  heading-anchor strip [[Target#heading]]
 *   D-04  .md extension [[Target.md]]
 *   D-05  duplicate-title first-match + warnings
 *   D-06  unresolved link preserved with warning
 *   D-07a category-is-new flag
 *   D-17b code-block exclusion via walkBodyExcludingCode
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  scanWikilinks,
  parseBatch,
  type ParseBatchContext,
  type FileInput,
} from '../src/services/ingest-markdown.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VAULT = join(__dirname, 'fixtures/ingest/vault-wikilinks');

function readFixture(name: string): string {
  return readFileSync(join(VAULT, name), 'utf-8');
}

function fileInput(name: string): FileInput {
  return { path: name, content: readFixture(name) };
}

const DEFAULT_CTX: ParseBatchContext = {
  universeId: 'test-universe',
  validTypes: ['character', 'location', 'event', 'concept', 'hero'],
  existingEntries: [],
  existingCategories: [],
};

// ---------------------------------------------------------------------------
// describe('scanWikilinks') — D-17 / D-17b
// ---------------------------------------------------------------------------
describe('scanWikilinks', () => {
  it('returns [] on body with no wikilinks', () => {
    const result = scanWikilinks('No wikilinks here, just plain text.');
    expect(result).toEqual([]);
  });

  it('finds a single [[Beta]] and returns correct shape', () => {
    const result = scanWikilinks('See [[Beta]] for details.');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ target: 'Beta', label: 'Beta', raw: '[[Beta]]' });
  });

  it('splits alias on first |: [[Target|Display Text]]', () => {
    const result = scanWikilinks('See [[Target|Display Text]] here.');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ target: 'Target', label: 'Display Text', raw: '[[Target|Display Text]]' });
  });

  it('strips heading anchor: [[Target#heading]] → target="Target"', () => {
    const result = scanWikilinks('See [[Target#heading]] for details.');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ target: 'Target', label: 'Target' });
  });

  it('strips .md extension (lowercase): [[Target.md]] → target="Target"', () => {
    const result = scanWikilinks('See [[Target.md]].');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ target: 'Target' });
  });

  it('strips .md extension (uppercase): [[Target.MD]] → target="Target"', () => {
    const result = scanWikilinks('See [[Target.MD]].');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ target: 'Target' });
  });

  it('handles combined: [[Target.md#heading|Display]] → target="Target", label="Display"', () => {
    const result = scanWikilinks('See [[Target.md#heading|Display]].');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ target: 'Target', label: 'Display' });
  });

  it('skips wikilinks inside fenced code blocks (D-17b) — reads code-block-link.md', () => {
    const body = readFixture('code-block-link.md');
    const result = scanWikilinks(body);
    // Only [[Beta]] outside the code block should be found
    const targets = result.map(l => l.target);
    expect(targets).toContain('Beta');
    expect(targets).not.toContain('InCode');
  });

  it('skips wikilinks inside inline backtick code (D-17b) — reads code-block-link.md', () => {
    const body = readFixture('code-block-link.md');
    const result = scanWikilinks(body);
    const targets = result.map(l => l.target);
    expect(targets).not.toContain('InlineCode');
  });

  it('trims whitespace inside brackets: [[ Target ]] → target="Target"', () => {
    const result = scanWikilinks('See [[ Target ]].');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ target: 'Target', label: 'Target' });
  });

  it('ignores empty/malformed brackets: [[]] and [[ ]]', () => {
    const result = scanWikilinks('Empty [[]] and whitespace-only [[ ]].');
    expect(result).toHaveLength(0);
  });

  it('finds multiple links in the same body', () => {
    const result = scanWikilinks('First [[Alpha]] then [[Beta]] then [[Gamma]].');
    expect(result).toHaveLength(3);
    expect(result.map(l => l.target)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });
});

// ---------------------------------------------------------------------------
// describe('parseBatch') — D-01..D-07a / D-17b
// ---------------------------------------------------------------------------
describe('parseBatch', () => {
  it('D-01: same-batch case-sensitive resolution (alpha links to Beta and gamma)', () => {
    const files = [fileInput('alpha.md'), fileInput('beta.md'), fileInput('gamma.md')];
    const preview = parseBatch(files, DEFAULT_CTX);

    const alphaEntry = preview.entries.find(e => e.filename === 'alpha.md');
    expect(alphaEntry).toBeDefined();

    const betaLink = alphaEntry!.linksOut.find(l => l.target === 'Beta');
    expect(betaLink).toBeDefined();
    expect(betaLink!.resolved).toBe(true);
    expect(betaLink!.target_path).toBe('beta.md');

    const gammaLink = alphaEntry!.linksOut.find(l => l.target === 'gamma');
    expect(gammaLink).toBeDefined();
    expect(gammaLink!.resolved).toBe(true);
    expect(gammaLink!.target_path).toBe('gamma.md');
  });

  it('D-01: case-insensitive batch resolution — [[aragorn]] resolves to file with title "Aragorn"', () => {
    const aragornFile: FileInput = { path: 'aragorn.md', content: '# Aragorn\n\nA ranger.' };
    const refFile: FileInput = { path: 'ref.md', content: '# Ref\n\nSee [[aragorn]] for details.' };
    const preview = parseBatch([aragornFile, refFile], DEFAULT_CTX);

    const refEntry = preview.entries.find(e => e.filename === 'ref.md');
    expect(refEntry).toBeDefined();
    const link = refEntry!.linksOut.find(l => l.target === 'aragorn');
    expect(link).toBeDefined();
    expect(link!.resolved).toBe(true);
    expect(link!.target_path).toBe('aragorn.md');
  });

  it('D-02: alias preservation — aliased.md linksOut has label="the second one"', () => {
    const files = [fileInput('aliased.md'), fileInput('beta.md')];
    const preview = parseBatch(files, DEFAULT_CTX);

    const aliasedEntry = preview.entries.find(e => e.filename === 'aliased.md');
    expect(aliasedEntry).toBeDefined();
    const link = aliasedEntry!.linksOut[0];
    expect(link.target).toBe('Beta');
    expect(link.label).toBe('the second one');
    expect(link.resolved).toBe(true);
    expect(link.target_path).toBe('beta.md');
  });

  it('D-03: heading-strip — heading-anchor.md resolves to Beta with no warning', () => {
    const files = [fileInput('heading-anchor.md'), fileInput('beta.md')];
    const preview = parseBatch(files, DEFAULT_CTX);

    const entry = preview.entries.find(e => e.filename === 'heading-anchor.md');
    expect(entry).toBeDefined();
    const link = entry!.linksOut[0];
    expect(link.target).toBe('Beta');
    expect(link.resolved).toBe(true);
    expect(link.warning).toBeUndefined();
  });

  it('D-04: .md extension — dot-md-ext.md resolves Beta.md and Gamma.MD', () => {
    const files = [fileInput('dot-md-ext.md'), fileInput('beta.md'), fileInput('gamma.md')];
    const preview = parseBatch(files, DEFAULT_CTX);

    const entry = preview.entries.find(e => e.filename === 'dot-md-ext.md');
    expect(entry).toBeDefined();
    expect(entry!.linksOut).toHaveLength(2);
    expect(entry!.linksOut.every(l => l.resolved)).toBe(true);
    const betaLink = entry!.linksOut.find(l => l.target === 'Beta');
    const gammaLink = entry!.linksOut.find(l => l.target === 'Gamma');
    expect(betaLink!.target_path).toBe('beta.md');
    expect(gammaLink!.target_path).toBe('gamma.md');
  });

  it('D-05: duplicate-title — dup-a and dup-b both have titleCollision=true', () => {
    const files = [fileInput('dup-a.md'), fileInput('dup-b.md')];
    const preview = parseBatch(files, DEFAULT_CTX);

    const dupA = preview.entries.find(e => e.filename === 'dup-a.md');
    const dupB = preview.entries.find(e => e.filename === 'dup-b.md');
    expect(dupA!.titleCollision).toBe(true);
    expect(dupB!.titleCollision).toBe(true);
  });

  it('D-05: duplicate-title — [[Shared]] resolves to dup-a (first-match wins)', () => {
    const sharedRefFile: FileInput = {
      path: 'shared-ref.md',
      content: '# Shared Ref\n\nSee [[Shared]] for details.',
    };
    // dup-a passed BEFORE dup-b in input order
    const files = [fileInput('dup-a.md'), fileInput('dup-b.md'), sharedRefFile];
    const preview = parseBatch(files, DEFAULT_CTX);

    const refEntry = preview.entries.find(e => e.filename === 'shared-ref.md');
    expect(refEntry).toBeDefined();
    const link = refEntry!.linksOut.find(l => l.target === 'Shared');
    expect(link!.target_path).toBe('dup-a.md');
    expect(link!.resolved).toBe(true);
  });

  it("D-05: duplicate-title — warnings[] contains entries for both dup files", () => {
    const files = [fileInput('dup-a.md'), fileInput('dup-b.md')];
    const preview = parseBatch(files, DEFAULT_CTX);

    const collisionWarnings = preview.warnings.filter(w =>
      w.message.includes("Duplicate title 'Shared'")
    );
    expect(collisionWarnings.length).toBeGreaterThanOrEqual(2);
  });

  it('D-06: unresolved link — resolved=false + warning text', () => {
    const files = [fileInput('unresolved.md')];
    const preview = parseBatch(files, DEFAULT_CTX);

    const entry = preview.entries.find(e => e.filename === 'unresolved.md');
    expect(entry).toBeDefined();
    const link = entry!.linksOut.find(l => l.target === 'Nonexistent Target');
    expect(link!.resolved).toBe(false);
    expect(link!.warning).toMatch(/not found in batch or existing universe/i);
    expect(preview.summary.unresolved_wikilinks).toBe(1);
  });

  it('existing-universe resolution — [[cross universe note]] resolves via ctx.existingEntries', () => {
    const bodyFile: FileInput = {
      path: 'cross-ref.md',
      content: '# Cross Ref\n\nSee [[cross universe note]] for details.',
    };
    const ctx: ParseBatchContext = {
      ...DEFAULT_CTX,
      existingEntries: [{ id: 'e-77', title: 'Cross Universe Note' }],
    };
    const preview = parseBatch([bodyFile], ctx);

    const entry = preview.entries.find(e => e.filename === 'cross-ref.md');
    expect(entry).toBeDefined();
    const link = entry!.linksOut.find(l => l.target === 'cross universe note');
    expect(link!.resolved).toBe(true);
    expect(link!.target_id).toBe('e-77');
    expect(link!.target_path).toBeUndefined();
  });

  it('D-17b: code-block exclusion at batch scope — InCode and InlineCode not in linksOut', () => {
    const files = [fileInput('code-block-link.md'), fileInput('beta.md')];
    const preview = parseBatch(files, DEFAULT_CTX);

    const entry = preview.entries.find(e => e.filename === 'code-block-link.md');
    expect(entry).toBeDefined();
    // Exactly one link: Beta
    expect(entry!.linksOut).toHaveLength(1);
    expect(entry!.linksOut[0].target).toBe('Beta');

    // InCode and InlineCode must not appear anywhere in linksOut or warnings
    const allTargets = entry!.linksOut.map(l => l.target);
    expect(allTargets).not.toContain('InCode');
    expect(allTargets).not.toContain('InlineCode');

    const warningMessages = preview.warnings.map(w => w.message);
    expect(warningMessages.join(' ')).not.toContain('InCode');
    expect(warningMessages.join(' ')).not.toContain('InlineCode');
  });

  it('D-07a: categoryIsNew=false when category already exists in universe', () => {
    const heroFile: FileInput = {
      path: 'characters/heroes/aragorn.md',
      content: '# Aragorn\n\nA ranger.',
    };
    const ctx: ParseBatchContext = {
      ...DEFAULT_CTX,
      existingCategories: ['heroes'],
    };
    const preview = parseBatch([heroFile], ctx);

    const entry = preview.entries.find(e => e.filename === 'aragorn.md');
    expect(entry).toBeDefined();
    expect(entry!.categoryIsNew).toBe(false);
  });

  it('D-07a: categoryIsNew=true when category not in universe', () => {
    const heroFile: FileInput = {
      path: 'characters/heroes/aragorn.md',
      content: '# Aragorn\n\nA ranger.',
    };
    const ctx: ParseBatchContext = {
      ...DEFAULT_CTX,
      existingCategories: [],
    };
    const preview = parseBatch([heroFile], ctx);

    const entry = preview.entries.find(e => e.filename === 'aragorn.md');
    expect(entry).toBeDefined();
    expect(entry!.categoryIsNew).toBe(true);
  });

  it('summary counts: markdown_files_parsed and non_markdown_files_skipped', () => {
    const files: FileInput[] = [
      { path: 'note.md', content: '# Note\n' },
      { path: 'image.png', content: '' },
      { path: 'document.pdf', content: '' },
      { path: 'another.md', content: '# Another\n' },
    ];
    const preview = parseBatch(files, DEFAULT_CTX);
    expect(preview.summary.markdown_files_parsed).toBe(2);
    expect(preview.summary.non_markdown_files_skipped).toBe(2);
  });

  it('summary counts: hidden_paths_filtered', () => {
    const files: FileInput[] = [
      { path: 'note.md', content: '# Note\n' },
      { path: '.obsidian/config.json', content: '{}' },
      { path: '.trash/old.md', content: '# Old\n' },
    ];
    const preview = parseBatch(files, DEFAULT_CTX);
    expect(preview.summary.hidden_paths_filtered).toBe(2);
    expect(preview.summary.markdown_files_parsed).toBe(1);
  });

  it('determinism: same inputs produce deeply-equal output', () => {
    const files = [
      fileInput('alpha.md'),
      fileInput('beta.md'),
      fileInput('gamma.md'),
      fileInput('aliased.md'),
      fileInput('unresolved.md'),
    ];
    const first = parseBatch(files, DEFAULT_CTX);
    const second = parseBatch(files, DEFAULT_CTX);
    expect(first).toEqual(second);
  });

  it('T-11-04: warnings reference basename only, not absolute paths', () => {
    const files = [fileInput('dup-a.md'), fileInput('dup-b.md')];
    const preview = parseBatch(files, DEFAULT_CTX);

    for (const w of preview.warnings) {
      // file field should be basename or relative path, not an absolute path
      if (w.file) {
        expect(w.file).not.toMatch(/^\//);
        expect(w.file).not.toMatch(/^[A-Z]:\\/); // Windows absolute path guard
      }
    }
  });
});

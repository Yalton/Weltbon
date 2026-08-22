/**
 * DOCX-13 — `.markdown` is accepted by the client and was silently dropped
 * by the server.
 *
 * ImportUploadStep.tsx:62 tells the user "Only .md or .markdown files ... are
 * accepted" and its local isMarkdown() accepts both. isMarkdownFile() accepted
 * only `.md`, so a `.markdown` upload was counted into
 * non_markdown_files_skipped and produced zero entries — an empty preview with
 * no error.
 */
import { describe, it, expect } from 'vitest';
import { isMarkdownFile, parseBatch } from '../src/services/ingest-markdown.js';

const CTX = {
  universeId: '00000000-0000-4000-8000-000000000000',
  validTypes: ['note'],
  existingEntries: [],
  existingCategories: [],
  splitLevel: null,
} as never;

describe('isMarkdownFile extensions (DOCX-13)', () => {
  it('accepts .md', () => {
    expect(isMarkdownFile('vale.md')).toBe(true);
  });

  it('accepts .markdown', () => {
    expect(isMarkdownFile('vale.markdown')).toBe(true);
  });

  it('is case-insensitive on both', () => {
    expect(isMarkdownFile('VALE.MD')).toBe(true);
    expect(isMarkdownFile('VALE.MARKDOWN')).toBe(true);
  });

  it('still rejects a non-markdown extension', () => {
    expect(isMarkdownFile('vale.txt')).toBe(false);
    expect(isMarkdownFile('vale.mdx')).toBe(false);
  });

  it('produces an entry for a .markdown file instead of silently skipping it', () => {
    // The regression itself. Asserting the entry COUNT and the skip COUNT
    // together, because either alone can pass for the wrong reason: a zero
    // skip-count with zero entries would also mean "the file vanished".
    const preview = parseBatch(
      [{ path: 'vale.markdown', content: '# The Vale\n\nProse.' }],
      CTX,
    );
    expect(preview.entries).toHaveLength(1);
    expect(preview.entries[0].title).toBe('The Vale');
    expect(preview.summary.markdown_files_parsed).toBe(1);
    expect(preview.summary.non_markdown_files_skipped).toBe(0);
  });
});

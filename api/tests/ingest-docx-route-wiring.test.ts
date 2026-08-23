/**
 * Issue #35, Task 8 — route-wiring guardrail for the ingest.ts <-> ingest-docx
 * integration point.
 *
 * NO DB: this exercises `isDocxFile` / `docxToMarkdownPath` (exported from
 * routes/ingest.ts for exactly this reason) plus the real `convertDocx` and
 * `parseBatch`/`isMarkdownFile` modules the route wires together — the same
 * pieces the handler touches, without the HTTP/auth/DB layer around them.
 * Task 9 owns the full-stack integration test (DB-gated); this file is not
 * added to vitest.config.ts's DB_GATED_TESTS list, so it auto-joins the unit
 * lane per the project convention (see timeline-window-unit.test.ts).
 *
 * The test this file exists to make impossible to remove without noticing:
 * a converted .docx that is NOT rewritten to .md is silently discarded by
 * parseBatch (isMarkdownFile gates it) and the document vanishes from the
 * preview with zero errors — the same failure mode as the .markdown bug
 * fixed elsewhere on this branch (DOCX-13). Demonstrated by running both the
 * correct and the wrong path through the real parseBatch, per the "verify by
 * running" project convention — not asserted from reading the code.
 */
import { describe, it, expect } from 'vitest';
import { isDocxFile, docxToMarkdownPath } from '../src/routes/ingest.js';
import { convertDocx } from '../src/services/ingest-docx/index.js';
import { makeDocx, documentWith } from './helpers/docx-fixture.js';
import { isMarkdownFile, parseBatch, type FileInput } from '../src/services/ingest-markdown.js';

const HEADING_DOCUMENT_XML = documentWith(
  '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>Chapter One</w:t></w:r></w:p>' +
  '<w:p><w:r><w:t>Some body prose.</w:t></w:r></w:p>',
);

const BATCH_CTX = {
  universeId: '00000000-0000-0000-0000-000000000000',
  validTypes: ['concept'],
  existingEntries: [],
  existingCategories: [],
};

describe('ingest.ts docx wiring — isDocxFile / docxToMarkdownPath (Issue #35 Task 8)', () => {
  it('isDocxFile matches .docx case-insensitively and rejects .md/.markdown', () => {
    expect(isDocxFile('chapter.docx')).toBe(true);
    expect(isDocxFile('Chapter.DOCX')).toBe(true);
    expect(isDocxFile('chapter.md')).toBe(false);
    expect(isDocxFile('chapter.markdown')).toBe(false);
  });

  it('docxToMarkdownPath rewrites the extension so isMarkdownFile accepts the result', () => {
    const rewritten = docxToMarkdownPath('chapter.docx');
    expect(rewritten).toBe('chapter.md');
    expect(isMarkdownFile(rewritten)).toBe(true);
    // The pre-rewrite name must NOT pass — this is exactly what parseBatch
    // gates on, and is the mechanism the load-bearing rewrite exists to feed.
    expect(isMarkdownFile('chapter.docx')).toBe(false);
  });

  it('THE LOAD-BEARING CASE: a converted .docx survives parseBatch only when rewritten to .md', async () => {
    const buf = await makeDocx({ documentXml: HEADING_DOCUMENT_XML });
    const conversion = await convertDocx(buf, { promoteHeadings: false });
    expect(conversion.markdown).toContain('Chapter One');

    // Correct wiring: the route's actual rewrite function is used.
    const correctInputs: FileInput[] = [
      { path: docxToMarkdownPath('chapter.docx'), content: conversion.markdown },
    ];
    const goodPreview = parseBatch(correctInputs, BATCH_CTX);
    expect(goodPreview.summary.markdown_files_parsed).toBe(1);
    expect(goodPreview.summary.non_markdown_files_skipped).toBe(0);
    expect(goodPreview.entries).toHaveLength(1);
    expect(goodPreview.entries[0].title).toBe('Chapter One');

    // MUTATION UNDER TEST: what removing the rewrite (leaving the original
    // .docx extension in place) does to the SAME converted content. This is
    // what a regression that drops docxToMarkdownPath() looks like from the
    // preview's point of view — the entry disappears without any error.
    const brokenInputs: FileInput[] = [
      { path: 'chapter.docx', content: conversion.markdown },
    ];
    const brokenPreview = parseBatch(brokenInputs, BATCH_CTX);
    expect(brokenPreview.summary.markdown_files_parsed).toBe(0);
    expect(brokenPreview.summary.non_markdown_files_skipped).toBe(1);
    expect(brokenPreview.entries).toHaveLength(0);
  });
});

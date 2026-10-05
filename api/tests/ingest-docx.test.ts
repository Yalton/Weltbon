import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import yazl from 'yazl';
import {
  createTestDb,
  cleanDb,
  createTestUser,
  authHeader,
  type TestDbHandle,
} from './helpers.js';
import { universes, entries, links } from '../src/db/schema.js';
import { makeDocx, documentWith } from './helpers/docx-fixture.js';
import { DB_GATED_TESTS } from '../ci/integration-tiers.mjs';

/**
 * Item 8's unexpected-throw case. `convertDocx` is imported statically by
 * routes/ingest.ts, so there is no live object to `vi.spyOn`; the module is
 * wrapped instead and the wrapper consults a toggle. `...actual` is spread so
 * `DocxFormatError` keeps its identity — the route's `instanceof` branch is
 * what separates a 400 from the 500 this case is about, and a re-created class
 * would quietly reroute every format error through the 500 path and make the
 * rest of the file lie.
 */
const docxThrow = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock('../src/services/ingest-docx/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/ingest-docx/index.js')>();
  return {
    ...actual,
    convertDocx: (...args: Parameters<typeof actual.convertDocx>) => {
      if (docxThrow.error !== null) throw docxThrow.error;
      return actual.convertDocx(...args);
    },
  };
});


const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const heading = (text: string, level = 1) =>
  `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
const prose = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
/** A heading-shaped paragraph carrying NO Heading style: 16pt bold, DOCX-09's heuristic input. */
const boldBig = (text: string) =>
  `<w:p><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
const bodyText = (text: string) =>
  `<w:p><w:r><w:rPr><w:sz w:val="22"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;

interface PreviewBody {
  summary: {
    markdown_files_parsed: number;
    non_markdown_files_skipped: number;
    hidden_paths_filtered: number;
    duplicate_titles_in_batch: number;
    unresolved_wikilinks: number;
    docx_files_converted: number;
  };
  entries: Array<{
    filename: string;
    path: string;
    title: string;
    type: string;
    tags: string[];
    body: string;
    meta: Record<string, unknown>;
    linksOut: Array<{ target: string; resolved: boolean }>;
    titleCollision?: boolean;
  }>;
  warnings: Array<{ file: string; message: string }>;
  split: { eligible: boolean; detected: number | null; applied: number | null };
  docx: {
    files: Array<{
      uploadIndex: number;
      path: string;
      headings: { styled: number; unstyledCandidates: number; promoted: boolean };
      mediaCount: number;
    }>;
  };
  error?: string;
}

describe('POST /api/universes/:uid/ingest — .docx (#35)', () => {
  let handle: TestDbHandle;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  let token: string;
  let universeId: string;

  beforeAll(async () => {
    handle = await createTestDb();
    const { setTestDb } = await import('../src/db/client.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setTestDb(handle.db as any, handle.pool);
    app = (await import('../src/index.js')).createApp();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    docxThrow.error = null;
    await cleanDb(handle);
    const user = await createTestUser(handle, { email: 'docx@test.dev', password: 'password123' });
    const { issueAccessToken } = await import('../src/services/auth.js');
    token = await issueAccessToken(user.id);
    const [u] = await handle.db
      .insert(universes)
      .values({ userId: user.id, name: 'Docx U' })
      .returning();
    universeId = u.id;
  });

  /** POST a multipart preview request. `parts` are [fieldName, value] pairs, in order. */
  async function previewRes(parts: Array<[string, File | string]>): Promise<Response> {
    const fd = new FormData();
    for (const [name, value] of parts) {
      if (typeof value === 'string') fd.append(name, value);
      else fd.append(name, value, value.name);
    }
    return app.request(`/api/universes/${universeId}/ingest`, {
      method: 'POST',
      headers: authHeader(token),
      body: fd,
    });
  }

  async function preview(parts: Array<[string, File | string]>): Promise<PreviewBody> {
    const res = await previewRes(parts);
    expect(res.status).toBe(200);
    return (await res.json()) as PreviewBody;
  }

  const docxFile = async (name: string, bodyXml: string) =>
    new File([await makeDocx({ documentXml: documentWith(bodyXml) })], name, { type: DOCX_MIME });

  /** A part that is NOT a valid .docx. Used by the cap tests on purpose — see the header. */
  const invalidDocxFile = (name: string, bytes = 64) =>
    new File([Buffer.alloc(bytes, 0x41)], name, { type: DOCX_MIME });

  const titles = (body: PreviewBody) => body.entries.map((e) => e.title).sort();

  /** The `{ error }` body every non-200 on this route returns (T-11-04's neutral shape). */
  const errorOf = async (res: Response): Promise<string> =>
    ((await res.json()) as { error: string }).error;

  // ─── 1. Registration proved ───────────────────────────────────────────────

  it('is registered in DB_GATED_TESTS — an unregistered file is silently never run', () => {
    expect(DB_GATED_TESTS).toContain('tests/ingest-docx.test.ts');
  });

  // ─── 2. The rewrite, at the ROUTE layer (the single most important test) ───

  it('THE ROUTE PERFORMS THE REWRITE: a valid .docx becomes a parsed markdown file', async () => {
    const body = await preview([
      ['files', await docxFile('vale.docx', heading('The Vale') + prose('Cold and high.'))],
    ]);

    // Without docxToMarkdownPath in the handler, every one of these flips:
    // parseBatch's isMarkdownFile gate discards a FileInput still named .docx,
    // so entries would be empty, markdown_files_parsed 0 and
    // non_markdown_files_skipped 1 — a 200 with the document silently gone.
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.summary.markdown_files_parsed).toBe(1);
    expect(body.summary.non_markdown_files_skipped).toBe(0);
    expect(body.entries[0].title).toBe('The Vale');
    expect(body.entries[0].body).toContain('Cold and high.');
    expect(body.entries[0].path).toBe('vale.md');
    expect(body.summary.docx_files_converted).toBe(1);
  });

  // ─── 3. Case and mid-string names, through the route ──────────────────────

  it('Chapter.DOCX converts (the extension match is case-insensitive)', async () => {
    const body = await preview([
      ['files', await docxFile('Chapter.DOCX', heading('Chapter One') + prose('Begin.'))],
    ]);
    expect(body.summary.docx_files_converted).toBe(1);
    expect(body.summary.markdown_files_parsed).toBe(1);
    expect(body.entries[0].title).toBe('Chapter One');
    // The rewrite is anchored to the END of the name and preserves the stem's case.
    expect(body.entries[0].path).toBe('Chapter.md');
  });

  it('a.docx.md is markdown, not a Word document — .docx mid-string does not match', async () => {
    const body = await preview([
      ['files', new File(['# Plain\n\nJust markdown.'], 'a.docx.md', { type: 'text/markdown' })],
    ]);
    expect(body.summary.docx_files_converted).toBe(0);
    expect(body.summary.markdown_files_parsed).toBe(1);
    expect(body.entries[0].title).toBe('Plain');
  });

  it('notes.docx.txt is skipped as a non-markdown file, not converted', async () => {
    const body = await preview([
      ['files', new File(['not markdown'], 'notes.docx.txt', { type: 'text/plain' })],
    ]);
    expect(body.summary.docx_files_converted).toBe(0);
    expect(body.summary.non_markdown_files_skipped).toBe(1);
    expect(body.summary.markdown_files_parsed).toBe(0);
    expect(body.entries).toHaveLength(0);
    expect(body.docx.files).toHaveLength(0);
  });

  // ─── 4. The `docx` block's shape and provenance (DOCX-10) ─────────────────

  it('docx.files reports the ORIGINAL uploaded name, including its case', async () => {
    const withImage =
      heading('The Vale') +
      prose('Cold and high.') +
      '<w:p><w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r></w:p>';
    const body = await preview([['files', await docxFile('Chapter.DOCX', withImage)]]);

    expect(body.docx.files).toHaveLength(1);
    const row = body.docx.files[0];
    // NOT 'Chapter.md': DOCX-01 rewrites the path before parseBatch sees it,
    // and reporting the rewritten name would name a file the user never
    // uploaded — their only thread back to the Word document they chose.
    expect(row.path).toBe('Chapter.DOCX');
    expect(row.headings).toEqual({ styled: 1, unstyledCandidates: 0, promoted: false });
    expect(row.mediaCount).toBe(1);
    expect(body.summary.docx_files_converted).toBe(1);
  });

  // ─── 5. unstyledCandidates is the eligible count, through the route ───────

  it('a document mixing a styled heading with a bold 16pt paragraph reports 0 candidates', async () => {
    // One candidate alongside one styled heading does not meet either mixed
    // eligibility threshold, so the server must not offer a no-op selection.
    const body = await preview([
      [
        'files',
        await docxFile(
          'mixed.docx',
          heading('The Vale') + bodyText('Cold and high.') + boldBig('The Reach') +
            bodyText('Warm and low.'),
        ),
      ],
    ]);

    const row = body.docx.files[0];
    expect(row.headings.styled).toBe(1);
    expect(row.headings.unstyledCandidates).toBe(0);
    expect(row.headings.promoted).toBe(false);
    // And the offer is not made in the warnings either.
    expect(body.warnings.some((w) => /look/.test(w.message) && /Heading style/.test(w.message)))
      .toBe(false);
  });

  // ─── 6. Promotion is selected per upload index ───────────────────────────

  it.each([0, 2])('docx_promote_index=%i promotes only that same-named DOCX upload', async (selected) => {
    const bodyXml =
      boldBig('The Vale') + bodyText('Cold and high.') +
      boldBig('The Reach') + bodyText('Warm and low.');
    const bytes = await makeDocx({ documentXml: documentWith(bodyXml) });
    const body = await preview([
      ['files', new File([bytes], 'same.docx', { type: DOCX_MIME })],
      ['files', new File(['# Interlude'], 'interlude.md', { type: 'text/markdown' })],
      ['files', new File([bytes], 'same.docx', { type: DOCX_MIME })],
      ['docx_promote_index', String(selected)],
    ]);

    expect(body.docx.files.map((row) => ({
      uploadIndex: row.uploadIndex,
      path: row.path,
      promoted: row.headings.promoted,
    }))).toEqual([
      { uploadIndex: 0, path: 'same.docx', promoted: selected === 0 },
      { uploadIndex: 2, path: 'same.docx', promoted: selected === 2 },
    ]);
    expect(body.docx.files.map((row) => row.headings.unstyledCandidates)).toEqual([2, 2]);
  });

  it('accepts repeated distinct promotion indices and applies each independently', async () => {
    const bytes = await makeDocx({
      documentXml: documentWith(boldBig('The Vale') + bodyText('Cold and high.')),
    });
    const body = await preview([
      ['files', new File([bytes], 'same.docx', { type: DOCX_MIME })],
      ['files', new File(['# Interlude'], 'interlude.md', { type: 'text/markdown' })],
      ['files', new File([bytes], 'same.docx', { type: DOCX_MIME })],
      ['docx_promote_index', '0'],
      ['docx_promote_index', '2'],
    ]);

    expect(body.docx.files.map((row) => ({
      uploadIndex: row.uploadIndex,
      promoted: row.headings.promoted,
    }))).toEqual([
      { uploadIndex: 0, promoted: true },
      { uploadIndex: 2, promoted: true },
    ]);
  });

  // ─── 7. docx_promote_index validation ─────────────────────────────────────

  it.each([
    ['leading-zero', '01'],
    ['negative', '-1'],
    ['non-integer', '1.0'],
    ['empty', ''],
    ['File-valued', new File(['0'], 'index.txt')],
  ] as Array<[string, string | File]>)(
    'rejects a %s docx_promote_index with neutral copy',
    async (_label, value) => {
      const res = await previewRes([
        ['files', await docxFile('v.docx', boldBig('The Vale') + bodyText('Cold.'))],
        ['docx_promote_index', value],
      ]);
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toBe('Invalid docx_promote_index');
    },
  );

  it('rejects a duplicate selected index instead of silently deduplicating it', async () => {
    const res = await previewRes([
      ['files', await docxFile('v.docx', boldBig('The Vale') + bodyText('Cold.'))],
      ['docx_promote_index', '0'],
      ['docx_promote_index', '0'],
    ]);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('Invalid docx_promote_index');
  });

  it('rejects an out-of-range selected index', async () => {
    const res = await previewRes([
      ['files', await docxFile('v.docx', boldBig('The Vale') + bodyText('Cold.'))],
      ['docx_promote_index', '1'],
    ]);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('Invalid docx_promote_index');
  });

  it('rejects an index that targets Markdown', async () => {
    const res = await previewRes([
      ['files', new File(['# A'], 'a.md', { type: 'text/markdown' })],
      ['docx_promote_index', '0'],
    ]);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('Invalid docx_promote_index');
  });

  it('rejects an index that targets an ineligible DOCX', async () => {
    const res = await previewRes([
      ['files', await docxFile('styled.docx', heading('The Vale') + bodyText('Cold.'))],
      ['docx_promote_index', '0'],
    ]);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('Invalid docx_promote_index');
  });

  it('rejects legacy docx_promote_headings whenever it is present', async () => {
    const res = await previewRes([
      ['files', await docxFile('v.docx', boldBig('The Vale') + bodyText('Cold.'))],
      ['docx_promote_index', '0'],
      ['docx_promote_headings', 'true'],
    ]);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('Invalid docx_promote_index');
  });

  it('rejects legacy docx_promote_headings without a promotion-index field', async () => {
    const res = await previewRes([
      ['files', await docxFile('v.docx', boldBig('The Vale') + bodyText('Cold.'))],
      ['docx_promote_headings', 'true'],
    ]);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('Invalid docx_promote_index');
  });

  // ─── 8. Error taxonomy at the wire (DOCX-11) ──────────────────────────────

  it('bytes that are not a zip are a 400 with actionable text', async () => {
    const res = await previewRes([
      ['files', new File([Buffer.from('this is not a docx')], 'fake.docx', { type: DOCX_MIME })],
    ]);
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    // Never collapsed to "Invalid file": the user has to be able to tell
    // "this is not a Word document" from "this document is too big".
    expect(error).toBe('Not a valid .docx (unreadable archive)');
  });

  it('a .docx with no word/document.xml is a 400 that names the missing part', async () => {
    const bytes = await makeDocx({ stylesXml: '<w:styles/>' });
    const res = await previewRes([['files', new File([bytes], 'broken.docx', { type: DOCX_MIME })]]);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('word/document.xml');
  });

  it('a DOCTYPE in document.xml is a 400 — NOT a 413', async () => {
    const bytes = await makeDocx({
      documentXml:
        '<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY lol "lol">]>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:body><w:p><w:r><w:t>&lol;</w:t></w:r></w:p></w:body></w:document>',
    });
    const res = await previewRes([['files', new File([bytes], 'bomb.docx', { type: DOCX_MIME })]]);
    // The distinction is the whole point: 413 says "split the batch and retry",
    // which for a billion-laughs payload is advice to attack again in halves.
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(413);
    expect(await errorOf(res)).toBe('Not a valid .docx (unsupported XML construct)');
  });

  it('a table too large to render is a 400 at the wire, not a 500 (A1)', async () => {
    // THE case this whole fix exists for. A 1 678-byte .docx carrying 130 000
    // table rows used to parse in ~75 ms as ONE block — docx_block_count
    // charged only top-level blocks — and then died inside renderTable's
    // Math.max(...) spread with `RangeError: Maximum call stack size
    // exceeded`, which this route has no branch for. The user got
    // `Internal error` / 500 for an upload they could have been told about.
    //
    // Asserted at the WIRE rather than only at parse.ts because the status
    // code is the contract: DOCX-11 says a document we will not parse is a
    // 400, and a 500 also tells the operator something is broken here.
    // 130 000 rows, NOT a round 40 000: the V8 spread failure boundary varies
    // with stack depth (measured at 125,284 arguments at top level, 121,684 at
    // +200 frames, and 89,284 at +2,000), and this fixture exceeds every
    // observation. A smaller table can render successfully against the
    // unfixed code, so the row count is load-bearing.
    const cell = '<w:tc><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc>';
    const rows = `<w:tr>${cell}</w:tr>`.repeat(130_000);
    const bytes = await makeDocx({ documentXml: documentWith(`<w:tbl>${rows}</w:tbl>`) });
    // ~7.8 MB of document.xml compressing to ~23 KB (measured), which is the
    // point: no size cap can see this coming — not docx_size, not
    // docx_part_size, not docx_total_uncompressed — so the model-node cap is
    // the only thing that can refuse it.
    expect(bytes.length).toBeLessThan(64 * 1024);

    const res = await previewRes([
      ['files', new File([bytes], 'huge-table.docx', { type: DOCX_MIME })],
    ]);
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
    expect(await errorOf(res)).toBe(
      'Not a valid .docx (docx_block_count max 100000; simplify or split the document)',
    );
  });

  it('CONTROL: a large-but-legal table still converts to a 200', async () => {
    // Word's own hard limit is 32 767 rows. Without this half, the cap could
    // be tightened to the point of refusing real documents and the test above
    // would stay green.
    const cell = (t: string) => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
    const rows = Array.from({ length: 1_000 }, (_, i) =>
      `<w:tr>${cell(`Peak ${i}`)}${cell(`${i * 3} m`)}</w:tr>`).join('');
    const bytes = await makeDocx({
      documentXml: documentWith(heading('The Vale') + `<w:tbl>${rows}</w:tbl>`),
    });

    const body = await preview([
      ['files', new File([bytes], 'atlas.docx', { type: DOCX_MIME })],
    ]);
    expect(body.summary.docx_files_converted).toBe(1);
    expect(body.entries[0].body).toContain('| Peak 0 | 0 m |');
    expect(body.entries[0].body).toContain('| Peak 999 | 2997 m |');
  });

  it('an unexpected throw is a 500 whose body leaks nothing about it', async () => {
    const marker = 'INTERNAL-DETAIL-a1b2c3-should-not-reach-the-client';
    docxThrow.error = new TypeError(marker);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await previewRes([['files', await docxFile('v.docx', heading('The Vale'))]]);
      expect(res.status).toBe(500);
      const raw = await res.text();
      expect(JSON.parse(raw)).toEqual({ error: 'Internal error' });
      // T-11-04. Asserted against the RAW body, not the parsed error string:
      // a detail smuggled into some other key would still be a leak.
      expect(raw).not.toContain(marker);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // ─── 9. Caps, proved to run BEFORE conversion ─────────────────────────────

  it('a .docx over 25 MB is a 413 naming docx_size — and it is not even opened', async () => {
    // 26 MB of zeros: not a zip, so a size check running AFTER conversion
    // would return the 400 from `unreadable archive` instead. The 413 is the
    // proof of ordering (T-11-09: cap on File.size before arrayBuffer()).
    const file = new File([Buffer.alloc(26 * 1024 * 1024)], 'huge.docx', { type: DOCX_MIME });
    const res = await previewRes([['files', file]]);
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toContain('docx_size');
  });

  it('51 .docx parts is a 413 naming docx_count — counted before any conversion', async () => {
    const parts: Array<[string, File]> = Array.from({ length: 51 }, (_, i) => [
      'files',
      invalidDocxFile(`f${i}.docx`),
    ]);
    const res = await previewRes(parts);
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toContain('docx_count');
  });

  it('50 .docx parts is the CONTROL: under the cap, so the same invalid bytes 400 instead', async () => {
    // Without this control, the 51-part test above would also pass if the
    // route rejected every batch of .docx parts outright.
    const parts: Array<[string, File]> = Array.from({ length: 50 }, (_, i) => [
      'files',
      invalidDocxFile(`f${i}.docx`),
    ]);
    const res = await previewRes(parts);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe('Not a valid .docx (unreadable archive)');
  });

  it('returns 413 when individually legal DOCX files exhaust one aggregate work budget', async () => {
    // Each fixture retains 60,000 empty paragraph blocks, below the 100,000
    // per-file cap. Together they exceed the batch cap, so rejecting either
    // file on its own would not satisfy this regression.
    const units = '<w:p/>'.repeat(60_000);
    const first = await docxFile('first.docx', units);
    const second = await docxFile('second.docx', units);
    const sentinel = invalidDocxFile('sentinel.docx');

    const originalArrayBuffer = File.prototype.arrayBuffer;
    let sentinelReads = 0;
    const arrayBufferSpy = vi.spyOn(File.prototype, 'arrayBuffer').mockImplementation(
      function (this: File): Promise<ArrayBuffer> {
        if (this.name === sentinel.name) sentinelReads += 1;
        return originalArrayBuffer.call(this);
      },
    );
    try {
      const res = await previewRes([
        ['files', first],
        ['files', second],
        ['files', sentinel],
      ]);

      expect(res.status).toBe(413);
      expect(await errorOf(res)).toContain(
        'docx_batch_block_count (max 100000)',
      );
      expect(sentinelReads).toBe(0);
    } finally {
      arrayBufferSpy.mockRestore();
    }
  });

  // ─── 10. Mixed batch (DOCX-01's central claim) ────────────────────────────

  it('mixes .md, .markdown and .docx in one batch and resolves wikilinks across it BOTH ways', async () => {
    // The payoff of converting at the FileInput boundary: by the time
    // parseBatch runs, the three files are indistinguishable.
    const docx = await docxFile(
      'vale.docx',
      heading('The Vale') + prose('Cold and high, next to [[The Reach]].'),
    );
    const md = new File(['# The Reach\n\nNext to [[The Vale]].'], 'reach.md', {
      type: 'text/markdown',
    });
    const markdown = new File(['# Old Notes\n\nSee [[The Vale]] and [[The Reach]].'], 'old.markdown', {
      type: 'text/markdown',
    });

    const body = await preview([['files', docx], ['files', md], ['files', markdown]]);

    expect(body.summary.markdown_files_parsed).toBe(3);
    expect(body.summary.non_markdown_files_skipped).toBe(0);
    expect(body.summary.docx_files_converted).toBe(1);
    expect(titles(body)).toEqual(['Old Notes', 'The Reach', 'The Vale']);
    expect(body.summary.unresolved_wikilinks).toBe(0);

    // Direction 1 — markdown INTO the converted file. Only resolves because
    // the conversion produced an ordinary FileInput the resolver could see.
    const reach = body.entries.find((e) => e.title === 'The Reach')!;
    expect(reach.linksOut.map((l) => l.target)).toContain('The Vale');
    expect(reach.linksOut.every((l) => l.resolved)).toBe(true);
    const old = body.entries.find((e) => e.title === 'Old Notes')!;
    expect(old.linksOut.map((l) => l.target).sort()).toEqual(['The Reach', 'The Vale']);
    expect(old.linksOut.every((l) => l.resolved)).toBe(true);

    // Direction 2 — OUT of the converted file into a markdown one. This is
    // the half that is not obvious: DOCX-06 escapes `[` and `]`, so the
    // stored body really does read `\[\[The Reach\]\]` (asserted below), and
    // reading the converter alone would say the link is dead. It is not:
    // scanWikilinks walks mdast TEXT NODES, where remark has already undone
    // the backslash escapes, so the link is found and resolved. Verified by
    // running, not by reading — and pinned here because a future change on
    // either side (escaping, or moving the scan onto the raw string) would
    // silently sever every link an author typed in Word.
    const vale = body.entries.find((e) => e.title === 'The Vale')!;
    expect(vale.linksOut.map((l) => l.target)).toEqual(['The Reach']);
    expect(vale.linksOut[0].resolved).toBe(true);
    expect(vale.body).toContain('\\[\\[The Reach\\]\\]');
  });

  it('an UNRESOLVED wikilink typed in Word is counted, not silently dropped', async () => {
    // The control for the above: if escaped brackets were simply invisible to
    // the scanner, this would be 0 links and 0 unresolved — indistinguishable
    // from "resolved" if only the resolved case were tested.
    const body = await preview([
      ['files', await docxFile('vale.docx', heading('The Vale') + prose('Near [[Nowhere]].'))],
    ]);
    expect(body.entries[0].linksOut.map((l) => l.target)).toEqual(['Nowhere']);
    expect(body.entries[0].linksOut[0].resolved).toBe(false);
    expect(body.summary.unresolved_wikilinks).toBe(1);
  });

  // ─── 11. split_level on a docx-derived file (#37 × #35) ───────────────────

  it('auto-detects a split level in a converted .docx and applies it', async () => {
    const body = await preview([
      [
        'files',
        await docxFile(
          'setting.docx',
          heading('The Vale') + prose('Cold.') + heading('The Reach') + prose('Warm.'),
        ),
      ],
    ]);
    // The split pre-pass sees the CONVERTED markdown — it runs on `inputs`,
    // after the rewrite, which is the only reason a Word document can be
    // split at all.
    expect(body.split.eligible).toBe(true);
    expect(body.split.detected).toBe(1);
    expect(body.split.applied).toBe(1);
    expect(titles(body)).toEqual(['The Reach', 'The Vale']);
  });

  it('an explicit split_level overrides detection on a docx-derived file', async () => {
    const bodyXml =
      heading('Book One') + prose('Intro.') +
      heading('Chapter A', 2) + prose('Alpha.') +
      heading('Chapter B', 2) + prose('Beta.') +
      heading('Book Two') + prose('Outro.');

    const auto = await preview([['files', await docxFile('saga.docx', bodyXml)]]);
    expect(auto.split.detected).toBe(1);
    expect(auto.split.applied).toBe(1);
    expect(titles(auto)).toEqual(['Book One', 'Book Two']);

    const forced = await preview([
      ['files', await docxFile('saga.docx', bodyXml)],
      ['split_level', '2'],
    ]);
    // `detected` still reports what the document looks like; `applied`
    // reports what THIS preview used. Collapsing the two is the bug the
    // shape guards against.
    expect(forced.split.detected).toBe(1);
    expect(forced.split.applied).toBe(2);
    // Three, not two: everything ahead of the first level-2 boundary becomes a
    // preamble entry carrying the document's own title (#37's splitMarkdownFile
    // docTitle rule). Asserting ['Chapter A','Chapter B'] here would be
    // asserting that the "Book One" prose was silently discarded.
    expect(titles(forced)).toEqual(['Book One', 'Chapter A', 'Chapter B']);

    const none = await preview([
      ['files', await docxFile('saga.docx', bodyXml)],
      ['split_level', 'null'],
    ]);
    expect(none.split.detected).toBe(1);
    expect(none.split.applied).toBeNull();
    expect(none.entries).toHaveLength(1);
  });

  // ─── 12. .docx inside a .zip is out of scope in v1 (DOCX-08) ──────────────

  it('a .docx inside a .zip is skipped like any other non-markdown entry', async () => {
    const docxBytes = await makeDocx({
      documentXml: documentWith(heading('The Vale') + prose('Cold.')),
    });
    const zipBytes = await makeZip([
      { name: 'chapter.docx', content: docxBytes },
      { name: 'notes.md', content: Buffer.from('# Notes\n\nPlain markdown.') },
    ]);

    const body = await preview([['zip', new File([zipBytes], 'vault.zip', { type: 'application/zip' })]]);

    // Not an error, and not a conversion: a .docx is itself a zip, so
    // converting inside unpackZip would open a nested-decompression
    // amplification path its cumulative cap does not model (T-11-01).
    expect(body.summary.docx_files_converted).toBe(0);
    expect(body.docx.files).toHaveLength(0);
    expect(body.summary.non_markdown_files_skipped).toBe(1);
    // The sibling markdown file still imports — the .docx is skipped, not the batch.
    expect(body.summary.markdown_files_parsed).toBe(1);
    expect(titles(body)).toEqual(['Notes']);
  });

  it('explains why .docx entries inside a zip were skipped, as ONE aggregated warning', async () => {
    // DOCX-08 excludes .docx from zips because a .docx is itself a zip, and
    // opening one inside unpackZip would be a nested-decompression path its
    // cumulative cap does not model. Silent skipping reads as a broken
    // feature, so the preview has to say what happened and what to do
    // instead — as one warning for the batch, not one per file, matching how
    // every other warning in this taxonomy aggregates.
    const zipBytes = await makeZip([
      { name: 'chapter-one.docx', content: Buffer.from('not really a docx') },
      { name: 'chapter-two.docx', content: Buffer.from('also not a docx') },
      { name: 'notes.md', content: Buffer.from('# Notes') },
    ]);

    const body = await preview([['zip', new File([zipBytes], 'vault.zip', { type: 'application/zip' })]]);

    const docxSkipWarnings = body.warnings.filter(
      (w) => w.message.includes('.docx') && /upload/i.test(w.message),
    );
    expect(docxSkipWarnings).toHaveLength(1);
    expect(docxSkipWarnings[0]?.message).toContain('2 .docx file(s)');
    expect(body.summary.non_markdown_files_skipped).toBe(2);
  });

  // ─── 13. Exactly-one-of is unchanged by .docx ─────────────────────────────

  it('files[] containing a .docx AND a zip together is still a 400', async () => {
    const zipBytes = await makeZip([{ name: 'notes.md', content: Buffer.from('# Notes') }]);
    const res = await previewRes([
      ['files', await docxFile('vale.docx', heading('The Vale'))],
      ['zip', new File([zipBytes], 'vault.zip', { type: 'application/zip' })],
    ]);
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain('either `files[]` parts or a single `zip` part');
  });

  // ─── 14. Warnings routing (DOCX-10's two-sources-of-truth rule) ───────────

  it('conversion warnings land in warnings[] against the ORIGINAL .docx name, and only there', async () => {
    // No headings anywhere → the converter's `no-headings` warning.
    const body = await preview([['files', await docxFile('Vale.DOCX', prose('Just prose, no headings.'))]]);

    const mine = body.warnings.filter((w) => w.file === 'Vale.DOCX');
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.some((w) => /No headings were found/.test(w.message))).toBe(true);

    // Never against the rewritten name — the user never uploaded 'Vale.md'.
    expect(body.warnings.some((w) => w.file === 'Vale.md')).toBe(false);
    expect(body.warnings.some((w) => w.file === 'vale.md')).toBe(false);

    // And NOT duplicated inside the docx block: two sources of truth for the
    // same text is exactly what DOCX-10 forbids.
    expect(JSON.stringify(body.docx)).not.toContain('No headings were found');
    expect(Object.keys(body.docx.files[0])).toEqual([
      'uploadIndex', 'path', 'headings', 'mediaCount',
    ]);
  });

  // ─── 15. Commit round trip (the issue's acceptance criterion) ─────────────

  it('a .docx-derived preview commits and persists like any other', async () => {
    // A mixed batch on purpose: the commit route is untouched by #35, so the
    // acceptance criterion is that it cannot tell the two entries apart —
    // including the link the Word document contributed.
    const previewBody = await preview([
      [
        'files',
        await docxFile('vale.docx', heading('The Vale') + prose('Cold, next to [[The Reach]].')),
      ],
      ['files', new File(['# The Reach\n\nNext to [[The Vale]].'], 'reach.md', {
        type: 'text/markdown',
      })],
    ]);

    const commitRes = await app.request(`/api/universes/${universeId}/ingest/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader(token) },
      body: JSON.stringify({
        entries: previewBody.entries.map((e) => ({
          filename: e.filename,
          path: e.path,
          title: e.title,
          entryType: e.type,
          tags: e.tags,
          category: null,
          body: e.body,
          meta: e.meta,
          linksOut: e.linksOut,
          decision: { disposition: 'accept' },
        })),
      }),
    });

    expect(commitRes.status).toBe(200);
    const { entryIds, linksCreated } = await commitRes.json();
    expect(entryIds).toHaveLength(2);
    // The Word document's own wikilink survives all the way into the links
    // table — the escaping never made it unreadable (see the mixed-batch test).
    expect(linksCreated).toBe(2);

    const rows = await handle.db.select().from(entries);
    expect(rows.map((r) => r.title).sort()).toEqual(['The Reach', 'The Vale']);
    const vale = rows.find((r) => r.title === 'The Vale')!;
    expect(vale.body).toContain('Cold, next to');
    // `entries` has no path column — the preview's rewritten `vale.md` is a
    // commit-time key, not a stored field (asserted on the preview above).
    const persisted = await handle.db.select({ n: sql<number>`count(*)::int` }).from(links);
    expect(persisted[0].n).toBe(2);
  });

  it('the preview itself writes no rows', async () => {
    const before = await handle.db.select({ n: sql<number>`count(*)::int` }).from(entries);
    await preview([['files', await docxFile('vale.docx', heading('The Vale') + prose('x'))]]);
    const after = await handle.db.select({ n: sql<number>`count(*)::int` }).from(entries);
    expect(after[0].n).toBe(before[0].n);
  });

  // ─── 17. docx.files order is UPLOAD order, not completion order ───────────

  it('docx.files[].path follows upload order for parts of wildly different sizes', async () => {
    // Wildly different sizes on purpose: conversion completion order tracks
    // decompression + parse cost, so a `push` inside the Promise.all map
    // records whichever finished first. With these three, that is reliably
    // NOT the upload order — which is what makes this an ordering test rather
    // than a coincidence.
    const big = await docxFile('big.docx', repeatBlocks(6000));
    const tiny = await docxFile('tiny.docx', heading('Tiny') + prose('x'));
    const mid = await docxFile('mid.docx', repeatBlocks(800));

    const body = await preview([['files', big], ['files', tiny], ['files', mid]]);

    expect(body.summary.docx_files_converted).toBe(3);
    expect(body.docx.files.map((f) => f.path)).toEqual(['big.docx', 'tiny.docx', 'mid.docx']);
  });

  // ─── 18. The two decided-by-default behaviours ────────────────────────────

  it('a hidden .docx is filtered as hidden and never counted as converted', async () => {
    const bytes = await makeDocx({
      documentXml: documentWith(heading('Secret') + prose('Hidden.')),
    });
    const body = await preview([
      ['files', new File([bytes], '.trash/chapter.docx', { type: DOCX_MIME })],
      ['files', new File([bytes], 'chapter.docx', { type: DOCX_MIME })],
    ]);

    // Skip-before-convert: counting a hidden file as converted would report a
    // conversion that contributed zero entries and zero warnings.
    expect(body.summary.docx_files_converted).toBe(1);
    expect(body.docx.files.map((f) => f.path)).toEqual(['chapter.docx']);
    // Left unrewritten, so parseBatch's hidden filter (which runs BEFORE its
    // non-markdown filter) is what removes it — misreporting it as
    // non_markdown_files_skipped would name the wrong reason.
    expect(body.summary.hidden_paths_filtered).toBe(1);
    expect(body.summary.non_markdown_files_skipped).toBe(0);
    expect(body.summary.markdown_files_parsed).toBe(1);
  });

  it('chapter.docx and chapter.md in one batch both survive, both flagged as colliding', async () => {
    const docx = await docxFile('chapter.docx', heading('Chapter One') + prose('From Word.'));
    const md = new File(['# Chapter One\n\nFrom markdown.'], 'chapter.md', {
      type: 'text/markdown',
    });
    const body = await preview([['files', docx], ['files', md]]);

    // Deliberate, not accidental: collision resolution is the review UI's job,
    // so neither file is dropped and both are marked.
    expect(body.entries).toHaveLength(2);
    expect(body.summary.duplicate_titles_in_batch).toBe(1);
    expect(body.entries.every((e) => e.titleCollision === true)).toBe(true);
    expect(body.entries.every((e) => e.path === 'chapter.md')).toBe(true);
    // The docx side's provenance survives the collision untouched.
    expect(body.docx.files.map((f) => f.path)).toEqual(['chapter.docx']);
  });
});

/** N heading+prose pairs — a document large enough to be slow to convert. */
function repeatBlocks(n: number): string {
  let out = '';
  for (let i = 0; i < n; i += 1) {
    out += heading(`Section ${i}`) + prose(`Body paragraph number ${i} with a little text in it.`);
  }
  return out;
}

/** A plain .zip, built with the same yazl the .docx fixtures use. */
function makeZip(files: Array<{ name: string; content: Buffer }>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const f of files) zip.addBuffer(f.content, f.name);
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

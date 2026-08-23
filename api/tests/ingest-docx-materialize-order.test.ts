/**
 * Issue #35, Task 8 fix round 1 — pins the ordering fix in
 * `materializeFileParts` (routes/ingest.ts): `docxConversions` (and therefore
 * `docx.files[]` and the appended warnings) must come back in UPLOAD order,
 * not `Promise.all` completion order.
 *
 * Code review's live-route repro showed a 328-byte file finishing conversion
 * before a 57 KB file queued ahead of it, because the original code
 * `push()`ed into `docxConversions` from inside the `Promise.all` map. This
 * file reproduces that shape deterministically by mocking `convertDocx` with
 * a delay that tracks input buffer size — real XML-parsing cost also scales
 * with document size, so this is the same shape without depending on real
 * wall-clock timing (which would make the test flaky rather than reliably
 * red/green).
 *
 * Kept in its own file, separate from ingest-docx-route-wiring.test.ts,
 * because vi.mock rewrites the whole module for every test in the file that
 * loads it — the other file needs the REAL convertDocx for its conversion
 * tests.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/services/ingest-docx/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/ingest-docx/index.js')>();
  return {
    ...actual,
    convertDocx: vi.fn(async (buffer: Buffer) => {
      // Larger buffer = slower "conversion", deterministically, via setTimeout
      // rather than real CPU-bound XML parsing — this is what makes the test
      // reliable instead of a race.
      const delayMs = Math.min(buffer.length / 200, 40);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        markdown: `# ${buffer.length}`,
        warnings: [],
        media: [],
        headings: { styled: 1, unstyledCandidates: 0, promoted: false },
      };
    }),
  };
});

// Imported AFTER vi.mock so materializeFileParts's internal call to
// convertDocx resolves to the mock above.
const { materializeFileParts } = await import('../src/routes/ingest.js');

function docxFile(name: string, byteLength: number): File {
  return new File([new Uint8Array(byteLength)], name);
}

describe('materializeFileParts — docx ordering survives uneven completion times (Issue #35 Task 8 fix round 1)', () => {
  it('returns docxConversions in UPLOAD order for wildly different file sizes, not completion order', async () => {
    // Deliberately queued largest-first, matching the review's repro shape:
    // if a later, smaller part in this array finishes converting first (it
    // will, under the mock's size-scaled delay), a naive `push()` inside the
    // Promise.all map would record IT first instead.
    const files = [
      docxFile('aaa-slow.docx', 57669),
      docxFile('mmm-medium.docx', 5000),
      docxFile('zzz-fast.docx', 328),
    ];

    const result = await materializeFileParts(files, { promoteDocxHeadings: false });

    expect(result.docxConversions.map((c) => c.path)).toEqual([
      'aaa-slow.docx',
      'mmm-medium.docx',
      'zzz-fast.docx',
    ]);
    // Same invariant must hold for the FileInput[] handed to parseBatch.
    expect(result.inputs.map((i) => i.path)).toEqual([
      'aaa-slow.md',
      'mmm-medium.md',
      'zzz-fast.md',
    ]);
  });
});

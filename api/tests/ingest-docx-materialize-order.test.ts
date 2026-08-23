/**
 * Issue #74, Task 2 — DOCX parts are materialised sequentially in upload order
 * so one shared parser budget has deterministic ownership when it is exhausted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const conversionControl = vi.hoisted(() => ({
  starts: [] as number[],
  releaseFirst: null as (() => void) | null,
}));

vi.mock('../src/services/ingest-docx/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/ingest-docx/index.js')>();
  return {
    ...actual,
    convertDocx: vi.fn(async (buffer: Buffer) => {
      conversionControl.starts.push(buffer.length);
      if (conversionControl.starts.length === 1) {
        await new Promise<void>((resolve) => {
          conversionControl.releaseFirst = resolve;
        });
      }
      return {
        markdown: `# ${buffer.length}`,
        warnings: [],
        media: [],
        headings: { styled: 1, unstyledCandidates: 0, promoted: false },
      };
    }),
  };
});

const { materializeFileParts } = await import('../src/routes/ingest.js');

describe('materializeFileParts — deterministic DOCX work ordering', () => {
  beforeEach(() => {
    conversionControl.starts = [];
    conversionControl.releaseFirst = null;
  });

  it('starts DOCX conversions sequentially and preserves mixed upload positions', async () => {
    const bigDocx = new Uint8Array(6_000);
    const smallDocx = new Uint8Array(328);
    expect(bigDocx.byteLength).toBeGreaterThan(smallDocx.byteLength * 2);

    const files = [
      new File(['# Intro'], 'intro.md', { type: 'text/markdown' }),
      new File([bigDocx], 'big.docx'),
      new File([smallDocx], '.hidden.docx'),
      new File([smallDocx], 'small.docx'),
      new File(['# Outro'], 'outro.markdown', { type: 'text/markdown' }),
    ];

    const materializing = materializeFileParts(files, { promoteDocxIndices: new Set() });

    await vi.waitFor(() => {
      expect(conversionControl.starts).toEqual([bigDocx.byteLength]);
    });
    conversionControl.releaseFirst?.();
    await vi.waitFor(() => {
      expect(conversionControl.starts).toEqual([
        bigDocx.byteLength,
        smallDocx.byteLength,
      ]);
    });

    const result = await materializing;
    expect(result.inputs.map((input) => input.path)).toEqual([
      'intro.md',
      'big.md',
      '.hidden.docx',
      'small.md',
      'outro.markdown',
    ]);
    expect(result.docxConversions.map((row) => row.path)).toEqual([
      'big.docx',
      'small.docx',
    ]);
    expect(result.docxConversions.map((row) => row.uploadIndex)).toEqual([1, 3]);
  });
});

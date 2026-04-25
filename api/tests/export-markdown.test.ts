import { describe, it, expect } from 'vitest';
import { buildMarkdownZip } from '../src/services/export/markdown.js';
import type { ExportPayload } from '../src/services/export/payload.js';

// Smoke test for plan 04-02 Task 1 RED → GREEN. Real integration coverage
// (yauzl unzip, frontmatter parsing, link resolution) lands in Task 2 below.
describe('EXP-02 buildMarkdownZip: smoke', () => {
  it('returns a web ReadableStream<Uint8Array> for an empty payload', async () => {
    const payload: ExportPayload = {
      universe: {
        id: '00000000-0000-0000-0000-000000000000',
        name: 'Empty World',
        description: '',
        entryTypes: ['concept'],
      },
      categories: [],
      entries: [],
      links: [],
      openIssues: [],
      fullIssues: [],
      graphPositions: [],
      entrySlugMap: new Map(),
    };
    const stream = buildMarkdownZip(payload);
    expect(stream).toBeDefined();
    expect(typeof (stream as ReadableStream).getReader).toBe('function');

    // Drain the stream so archiver finalizes cleanly under the test runner.
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    let total = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
    }
    // Empty universe still ships an _index.md inside a ZIP container — bytes > 0.
    expect(total).toBeGreaterThan(0);
  });
});

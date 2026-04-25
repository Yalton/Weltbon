import { describe, it, expect, vi } from 'vitest';
import type { ExportPayload } from '../src/services/export/payload.js';

/**
 * Plan 04-03 Task 2 unit-level coverage. Mocks puppeteer-core entirely so
 * these tests run on every machine without a Chromium binary.
 *
 * The contract being verified: renderUniversePdf wraps puppeteer's
 * page.createPDFStream() in a ReadableStream whose start() reads bytes,
 * forwards them to the controller, and ONLY closes the browser inside its
 * own finally block — i.e. AFTER the consumer finishes draining the
 * stream (RESEARCH Pattern 3, the stream-truncation guard).
 *
 * Naive try/finally around `await page.createPDFStream()` would close the
 * browser before the consumer reads, truncating the PDF mid-stream; the
 * test asserts the close happens AFTER the read loop finishes.
 */

function buildMinimalPayload(): ExportPayload {
  return {
    universe: {
      id: 'u1',
      name: 'Render Test',
      description: '',
      entryTypes: ['entity'],
    },
    categories: [],
    entries: [],
    links: [],
    openIssues: [],
    fullIssues: [],
    graphPositions: [],
    entrySlugMap: new Map(),
  };
}

describe('Plan 04-03 Task 2: renderUniversePdf — browser-close-on-stream-end', () => {
  it('closes the browser ONLY after the returned stream is fully read', async () => {
    let closeCalled = false;
    let bytesYielded = 0;
    let closeCalledBeforeStreamEnd = false;

    // The puppeteer fake yields three chunks; if browser.close() ran before
    // the third chunk we'd record it via the flag below.
    const fakePdfStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x25, 0x50, 0x44, 0x46])); // "%PDF"
        controller.enqueue(new Uint8Array([0x0a, 0x0a]));
        controller.enqueue(new Uint8Array([0x25, 0x25, 0x45, 0x4f, 0x46])); // "%%EOF"
        controller.close();
      },
    });

    const fakePage = {
      setContent: vi.fn(async () => {}),
      evaluateHandle: vi.fn(async () => ({})),
      createPDFStream: vi.fn(async () => fakePdfStream),
    };

    const fakeBrowser = {
      newPage: vi.fn(async () => fakePage),
      close: vi.fn(async () => {
        closeCalled = true;
      }),
    };

    vi.doMock('puppeteer-core', () => ({
      default: {
        launch: vi.fn(async () => fakeBrowser),
      },
    }));

    const { renderUniversePdf } = await import(
      '../src/services/export/pdf/render.js'
    );

    const stream = await renderUniversePdf(buildMinimalPayload());
    expect(closeCalled).toBe(false); // browser must NOT have closed yet

    const reader = stream.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // record whether close ran prematurely while bytes are still coming
      if (closeCalled && !closeCalledBeforeStreamEnd) {
        closeCalledBeforeStreamEnd = true;
      }
      bytesYielded += value.length;
    }

    expect(closeCalledBeforeStreamEnd).toBe(false); // never closed mid-stream
    expect(closeCalled).toBe(true); // closed AFTER full read
    expect(bytesYielded).toBeGreaterThan(0);
    expect(fakeBrowser.close).toHaveBeenCalledTimes(1);

    vi.doUnmock('puppeteer-core');
    vi.resetModules();
  });

  it('closes the browser when setContent throws (no orphan)', async () => {
    let closeCalled = false;

    const fakePage = {
      setContent: vi.fn(async () => {
        throw new Error('setContent boom');
      }),
      evaluateHandle: vi.fn(async () => ({})),
      createPDFStream: vi.fn(async () => new ReadableStream<Uint8Array>()),
    };

    const fakeBrowser = {
      newPage: vi.fn(async () => fakePage),
      close: vi.fn(async () => {
        closeCalled = true;
      }),
    };

    vi.doMock('puppeteer-core', () => ({
      default: {
        launch: vi.fn(async () => fakeBrowser),
      },
    }));

    const { renderUniversePdf } = await import(
      '../src/services/export/pdf/render.js'
    );

    await expect(renderUniversePdf(buildMinimalPayload())).rejects.toThrow(
      /setContent boom/,
    );
    expect(closeCalled).toBe(true);

    vi.doUnmock('puppeteer-core');
    vi.resetModules();
  });

  it('passes --allow-file-access-from-files and CHROMIUM_PATH to puppeteer.launch', async () => {
    const launchSpy = vi.fn(async () => ({
      newPage: async () => ({
        setContent: async () => {},
        evaluateHandle: async () => ({}),
        createPDFStream: async () =>
          new ReadableStream<Uint8Array>({
            start(c) {
              c.close();
            },
          }),
      }),
      close: async () => {},
    }));

    vi.doMock('puppeteer-core', () => ({
      default: { launch: launchSpy },
    }));

    const prev = process.env.CHROMIUM_PATH;
    process.env.CHROMIUM_PATH = '/fake/chromium';

    const { renderUniversePdf } = await import(
      '../src/services/export/pdf/render.js'
    );

    const stream = await renderUniversePdf(buildMinimalPayload());
    // drain so close runs
    const r = stream.getReader();
    while (!(await r.read()).done) {
      /* drain */
    }

    expect(launchSpy).toHaveBeenCalledTimes(1);
    const opts = launchSpy.mock.calls[0]![0] as {
      executablePath?: string;
      args?: string[];
    };
    expect(opts.executablePath).toBe('/fake/chromium');
    expect(opts.args).toContain('--no-sandbox');
    expect(opts.args).toContain('--disable-dev-shm-usage');
    expect(opts.args).toContain('--allow-file-access-from-files');

    if (prev === undefined) delete process.env.CHROMIUM_PATH;
    else process.env.CHROMIUM_PATH = prev;
    vi.doUnmock('puppeteer-core');
    vi.resetModules();
  });
});

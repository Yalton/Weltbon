import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// Each test must reset modules + the puppeteer mock so the dynamic
// `import('.../render.js')` picks up that test's specific mock.
beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.doUnmock('puppeteer-core');
  vi.resetModules();
});

describe('Plan 04-03 Task 2: renderUniversePdf — browser-close-on-stream-end', () => {
  it('closes the browser ONLY after the returned stream is fully read', async () => {
    let closeCalled = false;
    let bytesYielded = 0;
    let chunksConsumed = 0;
    let closeCalledBeforeAnyConsumerRead = false;

    // The puppeteer fake yields chunks WITH async deferral so the start()
    // loop has to await between chunks — observation point: when we read
    // chunk 1, closeCalled MUST still be false because chunks 2 + 3 are
    // yet to be delivered.
    let pullN = 0;
    const fakePdfStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((r) => setTimeout(r, 1));
        pullN++;
        if (pullN === 1) {
          controller.enqueue(new Uint8Array([0x25, 0x50, 0x44, 0x46])); // "%PDF"
        } else if (pullN === 2) {
          controller.enqueue(new Uint8Array([0x0a, 0x0a]));
        } else if (pullN === 3) {
          controller.enqueue(new Uint8Array([0x25, 0x25, 0x45, 0x4f, 0x46])); // "%%EOF"
        } else {
          controller.close();
        }
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

    const reader = stream.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (chunksConsumed === 0 && closeCalled) {
        closeCalledBeforeAnyConsumerRead = true;
      }
      chunksConsumed++;
      bytesYielded += value.length;
    }

    expect(closeCalledBeforeAnyConsumerRead).toBe(false);
    expect(closeCalled).toBe(true);
    expect(chunksConsumed).toBe(3);
    expect(bytesYielded).toBeGreaterThan(0);
    expect(fakeBrowser.close).toHaveBeenCalledTimes(1);
  });

  it('closes the browser when setContent throws (no orphan)', async () => {
    let closeCalled = false;

    const fakePage = {
      setContent: vi.fn(async () => {
        throw new Error('setContent boom');
      }),
      evaluateHandle: vi.fn(async () => ({})),
      createPDFStream: vi.fn(
        async () =>
          new ReadableStream<Uint8Array>({
            start(c) {
              c.close();
            },
          }),
      ),
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
  });

  it('passes --allow-file-access-from-files and CHROMIUM_PATH to puppeteer.launch', async () => {
    const launchSpy = vi.fn(
      async (_opts: { executablePath?: string; args?: string[] }) => ({
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
      }),
    );

    vi.doMock('puppeteer-core', () => ({
      default: { launch: launchSpy },
    }));

    const prev = process.env.CHROMIUM_PATH;
    process.env.CHROMIUM_PATH = '/fake/chromium';

    try {
      const { renderUniversePdf } = await import(
        '../src/services/export/pdf/render.js'
      );

      const stream = await renderUniversePdf(buildMinimalPayload());
      const r = stream.getReader();
      while (!(await r.read()).done) {
        /* drain */
      }

      expect(launchSpy).toHaveBeenCalledTimes(1);
      const opts = launchSpy.mock.calls[0][0];
      expect(opts.executablePath).toBe('/fake/chromium');
      expect(opts.args).toContain('--no-sandbox');
      expect(opts.args).toContain('--disable-dev-shm-usage');
      expect(opts.args).toContain('--allow-file-access-from-files');
    } finally {
      if (prev === undefined) delete process.env.CHROMIUM_PATH;
      else process.env.CHROMIUM_PATH = prev;
    }
  });
});

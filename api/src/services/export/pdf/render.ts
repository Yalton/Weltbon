import puppeteer from 'puppeteer-core';
import { renderUniverseHtml, footerTemplate } from './template.js';
import type { ExportPayload } from '../payload.js';

/**
 * PDF exporter — Plan 04-03 Task 2.
 *
 * Launches a fresh puppeteer-core browser per request against system
 * Chromium (`process.env.CHROMIUM_PATH`), feeds the rendered HTML into
 * `page.setContent` with `waitUntil: 'networkidle0'`, calls
 * `page.evaluateHandle('document.fonts.ready')` as a belt-and-suspenders
 * font-load gate (RESEARCH Pitfall 4), then streams `page.createPDFStream()`
 * back to the caller.
 *
 * The critical correctness pattern: `browser.close()` MUST run AFTER the
 * consumer finishes reading the stream, otherwise puppeteer truncates the
 * PDF mid-byte (RESEARCH Pitfall 1 / Pattern 3). To enforce this we wrap
 * puppeteer's stream in a custom ReadableStream whose `start(controller)`
 * runs the read loop and closes the browser inside ITS finally block.
 *
 * Launch args:
 *   --no-sandbox: required when running as root in some Docker images;
 *     CONTEXT.md flags this as environment-dependent. Self-host single-
 *     user with apt-installed Chromium is the assumed case.
 *   --disable-dev-shm-usage: avoids /dev/shm exhaustion in containers.
 *   --allow-file-access-from-files: lets `setContent`'s about:blank-like
 *     origin load Noto Color Emoji via `file://` (RESEARCH Pitfall 3).
 */
export async function renderUniversePdf(
  payload: ExportPayload,
): Promise<ReadableStream<Uint8Array>> {
  const html = await renderUniverseHtml(payload);

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROMIUM_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--allow-file-access-from-files',
    ],
  });

  let pdfStream: ReadableStream<Uint8Array>;
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    // Belt-and-suspenders: wait for web fonts to fully load before snapshotting.
    // setContent + waitUntil 'networkidle0' covers most cases, but documented
    // races still slip through occasionally (Pitfall 4).
    await page.evaluateHandle('document.fonts.ready');

    pdfStream = await page.createPDFStream({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: footerTemplate(payload.universe.name),
      margin: { top: '20mm', bottom: '25mm', left: '20mm', right: '20mm' },
    });
  } catch (err) {
    // Failure during page setup → close the browser before re-throwing so
    // we never leak a Chromium process on the error path.
    await browser.close();
    throw err;
  }

  // RESEARCH Pattern 3: wrap the puppeteer stream so browser.close() runs
  // ONLY after the consumer has finished draining bytes. A naive
  // try { return pdfStream; } finally { await browser.close(); } closes the
  // browser as soon as the function returns, before the HTTP response has
  // read the bytes — Chromium tears down its render pipeline and the PDF
  // arrives truncated.
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = pdfStream.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      } finally {
        await browser.close();
      }
    },
  });
}

import puppeteer from 'puppeteer-core';
import { renderUniverseHtml, footerTemplate } from './template.js';
import type { ExportPayload } from '../payload.js';

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
    // 'load', not 'networkidle0': puppeteer 25 dropped the network-idle options
    // from setContent. Every subresource here is a data: URI or a local file://
    // font, so the load event already covers images; fonts are awaited below.
    await page.setContent(html, { waitUntil: 'load' });
    // Belt-and-suspenders: wait for web fonts to fully load before snapshotting.
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
    await browser.close();
    throw err;
  }

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

import { describe, it, expect } from 'vitest';
import yauzl from 'yauzl';
import { makeDocx, documentWith, MINIMAL_DOCUMENT_XML } from './helpers/docx-fixture.js';

/** Read every entry name out of a zip buffer, for asserting fixture shape. */
function entryNames(buf: Buffer): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('no zipfile'));
      const names: string[] = [];
      zip.on('entry', (e) => { names.push(e.fileName); zip.readEntry(); });
      zip.on('end', () => resolve(names));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

describe('makeDocx fixture helper', () => {
  it('produces a zip whose first bytes are the PK magic', async () => {
    const buf = await makeDocx({ documentXml: MINIMAL_DOCUMENT_XML });
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });

  it('writes only the parts it was given', async () => {
    const buf = await makeDocx({ documentXml: MINIMAL_DOCUMENT_XML });
    expect(await entryNames(buf)).toEqual(['word/document.xml']);
  });

  it('omits word/document.xml when it was not supplied', async () => {
    const buf = await makeDocx({ stylesXml: '<w:styles/>' });
    expect(await entryNames(buf)).toEqual(['word/styles.xml']);
  });

  it('adds extraEntries verbatim, including duplicates of an allowlisted name', async () => {
    // Load-bearing for the entry-confusion test in Task 3: the helper must be
    // able to build an archive a real writer never would.
    const buf = await makeDocx({
      documentXml: MINIMAL_DOCUMENT_XML,
      extraEntries: [{ name: 'word/document.xml', content: '<w:document/>' }],
    });
    expect(await entryNames(buf)).toEqual(['word/document.xml', 'word/document.xml']);
  });

  it('documentWith wraps body XML in a namespaced envelope', () => {
    const xml = documentWith('<w:p/>');
    expect(xml).toContain('wordprocessingml/2006/main');
    expect(xml).toContain('<w:body><w:p/></w:body>');
  });
});

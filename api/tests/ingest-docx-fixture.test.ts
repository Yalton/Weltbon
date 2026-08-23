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

/**
 * Like entryNames, but for archives containing a literal ".." entry name.
 * yauzl's default decodeStrings:true path runs its own validateFileName() and
 * aborts the WHOLE read on such a name (the same reason unpack.ts itself
 * passes decodeStrings:false) — so a traversal-name fixture must be read back
 * this way, not with the plain entryNames() above.
 */
function readAllEntries(buf: Buffer): Promise<Array<{ name: string; content: Buffer }>> {
  return new Promise((resolve, reject) => {
    const out: Array<{ name: string; content: Buffer }> = [];
    yauzl.fromBuffer(buf, { lazyEntries: true, decodeStrings: false }, (err, zipfile) => {
      if (err || !zipfile) { reject(err ?? new Error('no zipfile')); return; }
      zipfile.on('error', reject);
      zipfile.on('end', () => resolve(out));
      zipfile.on('entry', (entry: yauzl.Entry) => {
        const name = (entry.fileName as unknown as Buffer).toString('utf8');
        if (/\/$/.test(name)) { zipfile.readEntry(); return; }
        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) { reject(streamErr ?? new Error('no stream')); return; }
          const chunks: Buffer[] = [];
          readStream.on('data', (c) => chunks.push(c as Buffer));
          readStream.on('error', reject);
          readStream.on('end', () => {
            out.push({ name, content: Buffer.concat(chunks) });
            zipfile.readEntry();
          });
        });
      });
      zipfile.readEntry();
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

/**
 * Issue #35 review round 1 — self-check for the traversal-name rewrite added
 * to makeDocx's `add()` helper.
 *
 * The original approach (mutate yazl's live Entry.utf8FileName between
 * addBuffer() and end(), reasoning that yazl's zlib.deflateRaw compression
 * callback is always async) was found to be unsafe: whenever an entry uses
 * `{ compress: false }` (a normal yazl option), yazl's pumpEntries() writes
 * the local file header SYNCHRONOUSLY inside addBuffer(), before any
 * post-call mutation can land — producing an archive whose local header and
 * central directory silently disagree about the entry's name. Separately, if
 * the mutation were skipped entirely, the placeholder name (e.g.
 * `word/XX/word/document.xml`) would survive untouched and the unpack.ts
 * traversal-defense test would pass while no traversal-shaped name ever
 * existed in the archive — a green test asserting nothing.
 *
 * makeDocx now instead serializes the finished archive with a same-length
 * placeholder, then rewrites the name bytes in both the central-directory
 * record and the local file header it points to (`rewriteEntryName` in
 * docx-fixture.ts), throwing if no matching record is found. These tests
 * read the finished archive back with yauzl directly (not through
 * unpack.ts, which would just file this entry under otherEntries) so a
 * regression here is caught in this file rather than masquerading as a
 * passing security test elsewhere.
 */
describe('makeDocx — traversal-name rewrite', () => {
  it('writes the literal ".." name into the archive, not the placeholder', async () => {
    const buf = await makeDocx({
      documentXml: MINIMAL_DOCUMENT_XML,
      extraEntries: [{ name: 'word/../word/document.xml', content: '<w:document>EVIL</w:document>' }],
    });

    const entries = await readAllEntries(buf);
    const names = entries.map((e) => e.name);

    expect(names).toContain('word/../word/document.xml');
    expect(names).not.toContain('word/XX/word/document.xml');
  });

  it('keeps the local file header and central directory in agreement', async () => {
    // If the local header still said `word/XX/word/document.xml` while the
    // central directory said the real name (or vice versa), the entry would
    // either fail to decompress or decompress to the wrong content — yauzl
    // reads entry data via the offset recorded in the CENTRAL directory, so a
    // real mismatch surfaces as a stream error or garbage bytes, not a clean,
    // correct read.
    const buf = await makeDocx({
      documentXml: MINIMAL_DOCUMENT_XML,
      extraEntries: [{ name: 'word/../word/document.xml', content: '<w:document>EVIL</w:document>' }],
    });

    const entries = await readAllEntries(buf);
    const evil = entries.find((e) => e.name === 'word/../word/document.xml');

    expect(evil).toBeDefined();
    expect(evil!.content.toString('utf8')).toBe('<w:document>EVIL</w:document>');
  });

  it('leaves ordinary (non-traversal) entries untouched', async () => {
    const buf = await makeDocx({ documentXml: MINIMAL_DOCUMENT_XML, stylesXml: '<w:styles/>' });
    const entries = await readAllEntries(buf);
    const names = entries.map((e) => e.name);
    expect(names).toContain('word/document.xml');
    expect(names).toContain('word/styles.xml');
  });
});

/**
 * Issue #35 (DOCX-06) — archive-layer hardening for .docx.
 *
 * Everything here is a zip-level attack. No XML parsing is exercised, which is
 * the point of keeping unpack.ts separate from parse.ts: a malicious archive
 * needs no valid document, and a malicious document needs no archive.
 *
 * Threat anchors: T-35-01 (bomb), T-35-03 (entry confusion),
 * T-35-05 (media never decompressed).
 */
import { describe, it, expect } from 'vitest';
import { unpackDocx, DocxFormatError, DOCX_ALLOWLIST } from '../src/services/ingest-docx/unpack.js';
import { DOCX_LIMITS } from '../src/services/ingest-docx/limits.js';
import { BatchLimitError } from '../src/services/ingest-zip.js';
import { makeDocx, MINIMAL_DOCUMENT_XML } from './helpers/docx-fixture.js';

describe('unpackDocx — happy path', () => {
  it('returns word/document.xml as a string', async () => {
    const buf = await makeDocx({ documentXml: MINIMAL_DOCUMENT_XML });
    const parts = await unpackDocx(buf, DOCX_LIMITS);
    expect(parts.document).toContain('<w:t>Hello</w:t>');
  });

  it('returns null for allowlisted parts that are absent', async () => {
    const buf = await makeDocx({ documentXml: MINIMAL_DOCUMENT_XML });
    const parts = await unpackDocx(buf, DOCX_LIMITS);
    expect(parts.styles).toBeNull();
    expect(parts.numbering).toBeNull();
    expect(parts.footnotes).toBeNull();
  });

  it('reads every allowlisted part when present', async () => {
    const buf = await makeDocx({
      documentXml: MINIMAL_DOCUMENT_XML,
      stylesXml: '<w:styles/>',
      numberingXml: '<w:numbering/>',
      footnotesXml: '<w:footnotes/>',
      relsXml: '<Relationships/>',
      corePropsXml: '<cp:coreProperties/>',
      contentTypesXml: '<Types/>',
    });
    const parts = await unpackDocx(buf, DOCX_LIMITS);
    expect(parts.styles).toBe('<w:styles/>');
    expect(parts.numbering).toBe('<w:numbering/>');
    expect(parts.footnotes).toBe('<w:footnotes/>');
    expect(parts.rels).toBe('<Relationships/>');
    expect(parts.coreProps).toBe('<cp:coreProperties/>');
    expect(parts.contentTypes).toBe('<Types/>');
  });
});

describe('unpackDocx — the allowlist (T-35-05)', () => {
  it('never decompresses media, but records it in otherEntries', async () => {
    // The load-bearing assertion of DOCX-07. A 5 MB "image" that would be
    // trivially detectable if it had been read: we assert the metadata is
    // present AND that no part field carries its bytes.
    const imageBytes = Buffer.alloc(5 * 1024 * 1024, 0x41);
    const buf = await makeDocx({
      documentXml: MINIMAL_DOCUMENT_XML,
      extraEntries: [{ name: 'word/media/image1.png', content: imageBytes }],
    });

    const parts = await unpackDocx(buf, DOCX_LIMITS);

    const media = parts.otherEntries.find((e) => e.name === 'word/media/image1.png');
    expect(media).toBeDefined();
    expect(media!.declaredBytes).toBe(5 * 1024 * 1024);

    // No allowlisted slot may contain the image bytes.
    const allText = [parts.document, parts.styles, parts.numbering, parts.footnotes,
                     parts.rels, parts.coreProps, parts.contentTypes].join('');
    expect(allText).not.toContain('AAAA');
  });

  it('leaves a nested archive inert', async () => {
    // A .docx inside a .docx. It is not on the allowlist, so it is never
    // opened — the nested-decompression path simply does not exist.
    const nested = await makeDocx({ documentXml: MINIMAL_DOCUMENT_XML });
    const buf = await makeDocx({
      documentXml: MINIMAL_DOCUMENT_XML,
      extraEntries: [{ name: 'word/embeddings/inner.docx', content: nested }],
    });
    const parts = await unpackDocx(buf, DOCX_LIMITS);
    expect(parts.otherEntries.map((e) => e.name)).toContain('word/embeddings/inner.docx');
    expect(parts.document).toContain('Hello');
  });

  it('does not match an allowlisted name reached via a traversal path', async () => {
    // Exact-match IS the traversal defense: there is no normalisation to get
    // wrong, so this entry is simply not on the list.
    const buf = await makeDocx({
      documentXml: MINIMAL_DOCUMENT_XML,
      extraEntries: [{ name: 'word/../word/document.xml', content: '<w:document>EVIL</w:document>' }],
    });
    const parts = await unpackDocx(buf, DOCX_LIMITS);
    expect(parts.document).not.toContain('EVIL');
    expect(parts.document).toContain('Hello');
  });

  it('exposes the allowlist and it contains no media path', () => {
    expect(DOCX_ALLOWLIST).toContain('word/document.xml');
    expect(DOCX_ALLOWLIST.some((n) => n.startsWith('word/media/'))).toBe(false);
  });
});

describe('unpackDocx — caps (T-35-01)', () => {
  it('rejects an archive with too many entries, by name', async () => {
    const extras = Array.from({ length: 600 }, (_, i) => ({
      name: `word/media/pad${i}.bin`,
      content: 'x',
    }));
    const buf = await makeDocx({ documentXml: MINIMAL_DOCUMENT_XML, extraEntries: extras });

    const err = await unpackDocx(buf, DOCX_LIMITS).catch((e) => e);
    expect(err).toBeInstanceOf(BatchLimitError);
    expect(err.limit).toBe('docx_entry_count');
  });

  it('aborts a bomb in an ALLOWLISTED part before it fully expands', async () => {
    // 64 MB of zeros in document.xml compresses to a few KB. The cap must fire
    // from the running chunk total, not from a completed read.
    const bomb = 'a'.repeat(70 * 1024 * 1024);
    const buf = await makeDocx({ documentXml: bomb });

    const started = process.hrtime.bigint();
    const err = await unpackDocx(buf, DOCX_LIMITS).catch((e) => e);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(err).toBeInstanceOf(BatchLimitError);
    expect(['docx_part_size', 'docx_total_uncompressed']).toContain(err.limit);
    // Comparing to a bound rather than asserting absence of a bad state: a
    // completed 70 MB expansion is far slower than this.
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('enforces the per-part cap against a lying central-directory header', async () => {
    // Defense in depth, mirroring unpackZip's live check. Even if a crafted
    // header under-declares the size, the running byte count must catch it.
    const buf = await makeDocx({ documentXml: 'b'.repeat(40 * 1024 * 1024) });
    const err = await unpackDocx(buf, { ...DOCX_LIMITS, docxTotalUncompressed: 1024 * 1024 * 1024 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BatchLimitError);
    expect(err.limit).toBe('docx_part_size');
  });

  it('enforces the cumulative cap across several allowlisted parts', async () => {
    const chunk = 'c'.repeat(20 * 1024 * 1024);
    const buf = await makeDocx({
      documentXml: chunk, stylesXml: chunk, numberingXml: chunk, footnotesXml: chunk,
    });
    const err = await unpackDocx(buf, DOCX_LIMITS).catch((e) => e);
    expect(err).toBeInstanceOf(BatchLimitError);
    expect(err.limit).toBe('docx_total_uncompressed');
  });
});

describe('unpackDocx — malformed archives (DOCX-11)', () => {
  it('rejects bytes that are not a zip', async () => {
    const err = await unpackDocx(Buffer.from('not a zip at all'), DOCX_LIMITS).catch((e) => e);
    expect(err).toBeInstanceOf(DocxFormatError);
  });

  it('rejects an archive with no word/document.xml, naming the missing part', async () => {
    const buf = await makeDocx({ stylesXml: '<w:styles/>' });
    const err = await unpackDocx(buf, DOCX_LIMITS).catch((e) => e);
    expect(err).toBeInstanceOf(DocxFormatError);
    expect(err.message).toContain('word/document.xml');
  });

  it('rejects a duplicated allowlisted part (T-35-03)', async () => {
    // Entry confusion: two document.xml entries make this reader and any
    // downstream one disagree about what the document says.
    const buf = await makeDocx({
      documentXml: MINIMAL_DOCUMENT_XML,
      extraEntries: [{ name: 'word/document.xml', content: '<w:document>EVIL</w:document>' }],
    });
    const err = await unpackDocx(buf, DOCX_LIMITS).catch((e) => e);
    expect(err).toBeInstanceOf(DocxFormatError);
    expect(err.message).toContain('duplicate');
  });

  it('does not leak a filesystem path or stack trace in its message (T-11-04)', async () => {
    const err = await unpackDocx(Buffer.from('nope'), DOCX_LIMITS).catch((e) => e);
    expect(err.message).not.toContain('/');
    expect(err.message).not.toContain('node_modules');
  });
});

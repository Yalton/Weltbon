/**
 * Issue #35 — build .docx buffers in memory for tests.
 *
 * yazl, not archiver: yazl is already this repo's zip-fixture builder
 * (tests/fixtures/ingest/zip/build-zips.ts) and is a devDependency, whereas
 * archiver is a runtime dependency used by export streaming.
 *
 * In memory rather than on disk: the existing zip fixtures are generated files
 * under tests/fixtures/ because one of them is a 200 MB bomb that is slow to
 * rebuild. Everything here is kilobytes, so a Buffer avoids the
 * ensureFixtures()/spawnSync dance entirely.
 *
 * `extraEntries` exists for the security tests — it is the only way to build an
 * archive a real writer would never produce (duplicate parts, oversized media,
 * a nested archive).
 */
import yazl from 'yazl';

export interface DocxFixtureParts {
  /** word/document.xml. Omit to leave it out entirely (missing-part test). */
  documentXml?: string;
  stylesXml?: string;
  numberingXml?: string;
  footnotesXml?: string;
  relsXml?: string;
  corePropsXml?: string;
  contentTypesXml?: string;
  /** Anything else, including deliberately hostile entries. */
  extraEntries?: Array<{ name: string; content: Buffer | string }>;
}

/** A valid minimal document.xml with one paragraph reading "Hello". */
export const MINIMAL_DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Hello</w:t></w:r></w:p>
  </w:body>
</w:document>`;

/** Wrap paragraph-level XML in a document/body envelope. */
export function documentWith(bodyXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:document
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
  <w:body>${bodyXml}</w:body>
</w:document>`;
}

export function makeDocx(parts: DocxFixtureParts): Promise<Buffer> {
  const zip = new yazl.ZipFile();

  const add = (name: string, content: string | Buffer | undefined) => {
    if (content === undefined) return;
    zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), name);
  };

  add('word/document.xml', parts.documentXml);
  add('word/styles.xml', parts.stylesXml);
  add('word/numbering.xml', parts.numberingXml);
  add('word/footnotes.xml', parts.footnotesXml);
  add('word/_rels/document.xml.rels', parts.relsXml);
  add('docProps/core.xml', parts.corePropsXml);
  add('[Content_Types].xml', parts.contentTypesXml);

  for (const extra of parts.extraEntries ?? []) {
    add(extra.name, extra.content);
  }

  zip.end();

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

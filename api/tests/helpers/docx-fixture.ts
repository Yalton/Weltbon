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

const EOCDR_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

/**
 * Rewrites one entry's name, in place, in BOTH the central-directory record
 * and the local file header it points to. `placeholder` and `real` MUST be
 * the same byte length: that is what keeps every other offset in the archive
 * valid, so no other entry needs to move.
 *
 * This exists because yazl's own addBuffer() refuses to WRITE a metadataPath
 * with a literal ".." segment (validateMetadataPath) — exactly the
 * traversal-shaped name the unpack.ts exact-match test needs inside the
 * archive. We write a same-length placeholder instead, then patch the
 * finished, already-serialized zip bytes.
 *
 * An earlier version of this mutated yazl's live Entry object
 * (`entries[i].utf8FileName = ...`) between addBuffer() and end(), reasoning
 * that yazl's zlib.deflateRaw compression callback is always async so the
 * mutation would land first. Review found that assumption is false whenever
 * an entry uses `{ compress: false }` (a normal yazl option): yazl's
 * pumpEntries() then writes the local file header SYNCHRONOUSLY inside
 * addBuffer(), before any post-call mutation can run, producing an archive
 * where the local header and central directory silently disagree about the
 * entry's name — and, separately, a placeholder name that never got swapped
 * at all would leave the traversal test green while asserting nothing.
 * Operating on the finished buffer removes both failure modes: there is
 * nothing left to race, and a placeholder that never matches throws instead
 * of silently no-op'ing.
 *
 * Throws if no central-directory record named `placeholder` is found. A
 * silent no-op there would be exactly the bug this function replaces: a
 * traversal-defense test that passes while no traversal-shaped name exists
 * anywhere in the archive.
 */
function rewriteEntryName(zipBuffer: Buffer, placeholder: string, real: string): Buffer {
  const placeholderBytes = Buffer.from(placeholder, 'utf8');
  const realBytes = Buffer.from(real, 'utf8');
  if (placeholderBytes.length !== realBytes.length) {
    throw new Error(
      `rewriteEntryName: "${placeholder}" and "${real}" differ in byte length; every ` +
      'other offset in the archive depends on the swap being length-neutral.'
    );
  }

  // No fixture here ever sets an archive comment, so the EOCDR is the last
  // 22 bytes — but we scan backwards for its signature rather than assume
  // that, so this stays correct if that ever changes.
  let eocdrOffset = -1;
  for (let i = zipBuffer.length - 22; i >= 0; i--) {
    if (zipBuffer.readUInt32LE(i) === EOCDR_SIGNATURE) {
      eocdrOffset = i;
      break;
    }
  }
  if (eocdrOffset === -1) {
    throw new Error('rewriteEntryName: no end-of-central-directory record found');
  }

  const totalRecords = zipBuffer.readUInt16LE(eocdrOffset + 10);
  const centralDirectoryOffset = zipBuffer.readUInt32LE(eocdrOffset + 16);

  let cursor = centralDirectoryOffset;
  let found = false;

  for (let i = 0; i < totalRecords; i++) {
    if (zipBuffer.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('rewriteEntryName: central directory record signature mismatch');
    }

    const fileNameLength = zipBuffer.readUInt16LE(cursor + 28);
    const extraFieldLength = zipBuffer.readUInt16LE(cursor + 30);
    const fileCommentLength = zipBuffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const name = zipBuffer.subarray(nameStart, nameStart + fileNameLength).toString('utf8');

    if (name === placeholder) {
      zipBuffer.set(realBytes, nameStart);

      if (zipBuffer.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
        throw new Error('rewriteEntryName: local file header signature mismatch');
      }
      const localNameLength = zipBuffer.readUInt16LE(localHeaderOffset + 26);
      if (localNameLength !== fileNameLength) {
        throw new Error('rewriteEntryName: local/central file name length mismatch');
      }
      zipBuffer.set(realBytes, localHeaderOffset + 30);

      found = true;
      break;
    }

    cursor = nameStart + fileNameLength + extraFieldLength + fileCommentLength;
  }

  if (!found) {
    throw new Error(`rewriteEntryName: no central directory record named "${placeholder}"`);
  }

  return zipBuffer;
}

export function makeDocx(parts: DocxFixtureParts): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  const traversalRewrites: Array<{ placeholder: string; real: string }> = [];

  const add = (name: string, content: string | Buffer | undefined) => {
    if (content === undefined) return;

    // A name ending in "/" is a DIRECTORY entry. yazl's addBuffer() refuses
    // one (validateMetadataPath rejects a trailing slash), so it has to go
    // through addEmptyDirectory — and directory entries are needed as
    // fixtures in their own right, because unpack.ts skips them and therefore
    // has to be shown charging them against docx_entry_count first.
    if (name.endsWith('/')) {
      zip.addEmptyDirectory(name);
      return;
    }

    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');

    const segments = name.split('/');
    if (segments.includes('..')) {
      // See rewriteEntryName's docstring for why this is a post-serialization
      // patch rather than a live-object splice.
      const placeholder = segments.map((s) => (s === '..' ? 'XX' : s)).join('/');
      zip.addBuffer(buf, placeholder);
      traversalRewrites.push({ placeholder, real: name });
      return;
    }

    zip.addBuffer(buf, name);
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
    zip.outputStream.on('end', () => {
      let out = Buffer.concat(chunks);
      for (const { placeholder, real } of traversalRewrites) {
        out = rewriteEntryName(out, placeholder, real);
      }
      resolve(out);
    });
  });
}

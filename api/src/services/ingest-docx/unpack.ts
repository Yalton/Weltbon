/**
 * Issue #35 (DOCX-06) — allowlisted, capped OOXML part reader.
 *
 * GOVERNING PRINCIPLE: never decompress what we do not need. The central
 * directory is enumerated in full, but only the eight names in DOCX_ALLOWLIST
 * are ever opened. Everything else — all of word/media/*, comments.xml,
 * embedded objects, padding entries, nested archives — is recorded as
 * {name, declaredBytes} and left compressed.
 *
 * That is why a .docx containing a zip bomb in an image, or a nested .docx, is
 * inert here rather than merely capped: the code path that would expand it does
 * not exist. It is also where the DOCX-07 media manifest comes from without
 * expanding a byte.
 *
 * EXACT-MATCH IS THE TRAVERSAL DEFENSE. `word/../word/document.xml` does not
 * equal `word/document.xml`, so there is no path normalisation step that could
 * be got wrong. Do not "improve" this into a normalise-then-compare.
 *
 * Cap enforcement mirrors ingest-zip.ts's proven shape (D-15b): per-chunk
 * accumulation with a mid-stream abort, never a check after a whole entry has
 * been decompressed. The declared header size is used only as a cheap early
 * reject; the running count is authoritative, because the header is
 * attacker-controlled.
 */
import yauzl from 'yauzl';
import { Buffer } from 'node:buffer';
import { BatchLimitError } from '../ingest-zip.js';
import type { DocxLimits } from './limits.js';

/** The only entries that are ever decompressed. Exact names, case-sensitive. */
export const DOCX_ALLOWLIST = [
  'word/document.xml',
  'word/styles.xml',
  'word/numbering.xml',
  'word/footnotes.xml',
  'word/endnotes.xml',
  'word/_rels/document.xml.rels',
  'docProps/core.xml',
  '[Content_Types].xml',
] as const;

export interface DocxEntryMeta {
  name: string;
  declaredBytes: number;
}

export interface DocxParts {
  document: string;
  styles: string | null;
  numbering: string | null;
  footnotes: string | null;
  endnotes: string | null;
  rels: string | null;
  coreProps: string | null;
  contentTypes: string | null;
  /** Enumerated but NEVER decompressed (DOCX-07 media manifest source). */
  otherEntries: DocxEntryMeta[];
}

/**
 * The document is not something we will parse (DOCX-11: 400, not 413).
 *
 * `detail` is operator-safe by construction — it is composed from our own
 * allowlist names and fixed strings, never from archive contents (T-11-04).
 */
export class DocxFormatError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'DocxFormatError';
  }
}

function openZip(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    // decodeStrings: false. This is not just a workaround for yauzl's
    // default decode path aborting the WHOLE zipfile the moment any one
    // entry name fails its validateFileName() (which would make yauzl's
    // internal check the traversal defense instead of our allowlist — a
    // hostile archive with one such name anywhere, even in an entry we would
    // otherwise just record and ignore, would abort enumeration entirely,
    // including the DOCX-07 media manifest). It also closes two concrete
    // allowlist bypasses present in yauzl's default decode path:
    //
    //   1. Backslash normalisation: getFileNameLowLevel() runs
    //      fileName.replace(/\\/g, "/") before validation, so an entry
    //      literally named `word\document.xml` is reported to callers as
    //      `word/document.xml` and would be decompressed as if it were the
    //      real part.
    //   2. Info-ZIP Unicode Path extra field (0x7075): yauzl substitutes
    //      that field's name whenever its CRC matches the entry's CRC32. An
    //      entry whose real name is `word/media/image1.png` but which
    //      carries a 0x7075 field naming `word/document.xml` would be
    //      reported as the latter — under decodeStrings:true that media
    //      entry gets decompressed, a direct T-35-05 violation.
    //
    // We decode fileName ourselves, below, from the raw bytes only, and let
    // exact Set membership on that raw-decoded name be the only gate.
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: false }, (err, zipfile) => {
      if (err || !zipfile) {
        // Deliberately not echoing yauzl's message: it can embed offsets and
        // internal detail. A fixed string keeps T-11-04 simple to hold.
        reject(new DocxFormatError('Not a valid .docx (unreadable archive)'));
        return;
      }
      resolve(zipfile);
    });
  });
}

const ALLOWED = new Set<string>(DOCX_ALLOWLIST);

export async function unpackDocx(buffer: Buffer, limits: DocxLimits): Promise<DocxParts> {
  const zipfile = await openZip(buffer);

  const collected = new Map<string, string>();
  const otherEntries: DocxEntryMeta[] = [];
  let entryCount = 0;
  let cumulative = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try { zipfile.close(); } catch { /* ignore */ }
      fn();
    };

    zipfile.on('error', () => settle(() => reject(new DocxFormatError('Not a valid .docx (unreadable archive)'))));
    zipfile.on('end', () => settle(resolve));

    zipfile.on('entry', (entry: yauzl.Entry) => {
      // decodeStrings:false (see openZip) leaves fileName as raw bytes, not a
      // decoded string, despite what the @types declaration claims. OOXML
      // part names are always ASCII, so a plain utf8 decode is exact and
      // — unlike yauzl's own decode path — never runs yauzl's path validation.
      const fileName = (entry.fileName as unknown as Buffer).toString('utf8');

      if (/\/$/.test(fileName)) { zipfile.readEntry(); return; }

      entryCount += 1;
      if (entryCount > limits.docxEntryCount) {
        settle(() => reject(new BatchLimitError('docx_entry_count', limits.docxEntryCount)));
        return;
      }

      const declared = typeof entry.uncompressedSize === 'number' ? entry.uncompressedSize : 0;

      if (!ALLOWED.has(fileName)) {
        // Recorded, never opened. This is the whole defense.
        otherEntries.push({ name: fileName, declaredBytes: declared });
        zipfile.readEntry();
        return;
      }

      // T-35-03: two entries claiming the same allowlisted name make this
      // reader and a downstream one disagree about the document's contents.
      if (collected.has(fileName)) {
        settle(() => reject(new DocxFormatError('Not a valid .docx (duplicate part)')));
        return;
      }

      // Cheap early reject off the header. Not authoritative — see below.
      if (declared > limits.docxPartSize) {
        settle(() => reject(new BatchLimitError('docx_part_size', limits.docxPartSize)));
        return;
      }

      zipfile.openReadStream(entry, (streamErr, readStream) => {
        if (streamErr || !readStream) {
          settle(() => reject(new DocxFormatError('Not a valid .docx (unreadable part)')));
          return;
        }

        const chunks: Buffer[] = [];
        let partBytes = 0;

        readStream.on('data', (raw) => {
          if (settled) return;
          const chunk = raw as Buffer;
          partBytes += chunk.length;
          cumulative += chunk.length;

          // Authoritative check: the header is attacker-controlled, the
          // running total is not.
          if (partBytes > limits.docxPartSize) {
            readStream.destroy();
            settle(() => reject(new BatchLimitError('docx_part_size', limits.docxPartSize)));
            return;
          }
          if (cumulative > limits.docxTotalUncompressed) {
            readStream.destroy();
            settle(() => reject(new BatchLimitError('docx_total_uncompressed', limits.docxTotalUncompressed)));
            return;
          }
          chunks.push(chunk);
        });

        readStream.on('error', () => settle(() => reject(new DocxFormatError('Not a valid .docx (unreadable part)'))));

        readStream.on('end', () => {
          if (settled) return;
          collected.set(fileName, Buffer.concat(chunks).toString('utf8'));
          zipfile.readEntry();
        });
      });
    });

    zipfile.readEntry();
  });

  const document = collected.get('word/document.xml');
  if (document === undefined) {
    throw new DocxFormatError('Not a valid .docx (missing word/document.xml)');
  }

  return {
    document,
    styles: collected.get('word/styles.xml') ?? null,
    numbering: collected.get('word/numbering.xml') ?? null,
    footnotes: collected.get('word/footnotes.xml') ?? null,
    endnotes: collected.get('word/endnotes.xml') ?? null,
    rels: collected.get('word/_rels/document.xml.rels') ?? null,
    coreProps: collected.get('docProps/core.xml') ?? null,
    contentTypes: collected.get('[Content_Types].xml') ?? null,
    otherEntries,
  };
}

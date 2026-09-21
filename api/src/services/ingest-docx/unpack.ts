import yauzl from 'yauzl';
import { Buffer } from 'node:buffer';
import { BatchLimitError } from '../ingest-zip.js';
import type { DocxLimits } from './limits.js';

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
  otherEntries: DocxEntryMeta[];
}

export class DocxFormatError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'DocxFormatError';
  }
}

function openZip(buffer: Buffer): Promise<yauzl.ZipFile<Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: false }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(new DocxFormatError('Not a valid .docx (unreadable archive)'));
        return;
      }
      resolve(zipfile);
    });
  });
}

const ALLOWED = new Set<string>(DOCX_ALLOWLIST);

// Accept only exact DOCX part names to reject traversal and alias bypasses; enforce caps while streams decompress.
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

    zipfile.on('entry', (entry: yauzl.Entry<Buffer>) => {
      const fileName = entry.fileName.toString('utf8');

      entryCount += 1;
      if (entryCount > limits.docxEntryCount) {
        settle(() => reject(new BatchLimitError('docx_entry_count', limits.docxEntryCount)));
        return;
      }

      if (/\/$/.test(fileName)) { zipfile.readEntry(); return; }

      const declared = typeof entry.uncompressedSize === 'number' ? entry.uncompressedSize : 0;

      if (!ALLOWED.has(fileName)) {
        otherEntries.push({ name: fileName, declaredBytes: declared });
        zipfile.readEntry();
        return;
      }

      if (collected.has(fileName)) {
        settle(() => reject(new DocxFormatError('Not a valid .docx (duplicate part)')));
        return;
      }

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

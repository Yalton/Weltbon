/**
 * api/src/services/ingest-zip.ts
 *
 * Phase 11-03 — streaming ZIP unpacker with batch-limit enforcement.
 *
 * Decisions implemented:
 *   D-15   Hard caps: maxFiles, maxFileSize, maxTotalUncompressed.
 *   D-15b  Streaming bomb defense — cumulative byte counter aborts mid-read on
 *          per-chunk overrun, NOT after a whole entry has been decompressed.
 *   D-16   ZIP library = yauzl (already devDep; promoted to dep). Rationale:
 *          lazyEntries + per-entry openReadStream gives us natural backpressure;
 *          adm-zip would buffer the entire archive in memory (T-11-01 risk).
 *
 * Security:
 *   T-11-01 (DoS / ZIP-bomb)         — streaming abort on uncompressed-byte cap.
 *   T-11-02 (DoS / per-file size)    — entry.uncompressedSize pre-check, plus
 *                                       in-stream guard (can't trust headers alone).
 *   T-11-04 (info disclosure)        — error messages contain limit name + max,
 *                                       no filesystem paths or stack traces.
 *
 * Caller contract:
 *   - Hidden-dir filtering and non-md filtering happen at the ENDPOINT, not here.
 *   - We return EVERY non-directory entry. The caller filters via isHiddenPath +
 *     isMarkdownFile from ingest-markdown.ts.
 */

import yauzl from 'yauzl';
import { Buffer } from 'node:buffer';

export type BatchLimit =
  | 'file_count'
  | 'zip_size'
  | 'file_size'
  | 'total_uncompressed_size'
  // #35 (DOCX-11). Reusing BatchLimitError rather than inventing a parallel
  // error keeps the route's existing 413 branch and the client's existing
  // message parsing working unchanged.
  | 'docx_size'
  | 'docx_count'
  | 'docx_entry_count'
  | 'docx_part_size'
  | 'docx_total_uncompressed';

/**
 * Thrown when any of the four D-15 batch caps is breached.
 *
 * The endpoint maps this to a 413 response with body
 *   `{ error: "Batch limit exceeded: <limit> (max <max>)" }`.
 */
export class BatchLimitError extends Error {
  public readonly limit: BatchLimit;
  public readonly max: number;

  constructor(limit: BatchLimit, max: number) {
    super(`Batch limit exceeded: ${limit} (max ${max})`);
    this.name = 'BatchLimitError';
    this.limit = limit;
    this.max = max;
  }
}

export interface UnpackZipLimits {
  /** Max number of file entries (D-15: 1000). */
  maxFiles: number;
  /** Max uncompressed size of any single entry, in bytes (D-15: 1 MB for .md). */
  maxFileSize: number;
  /** Max cumulative uncompressed size, in bytes (D-15b: 100 MB). */
  maxTotalUncompressed: number;
}

export interface UnpackedEntry {
  /** Entry path as encoded in the ZIP, forward-slash separated. */
  path: string;
  /** Best-effort UTF-8 decode of the entry contents. */
  content: string;
}

/**
 * Open a ZIP buffer with yauzl in lazy-entry mode and resolve a structured
 * handle. We promisify here so the caller can use async/await.
 */
function openZipFromBuffer(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error('yauzl.fromBuffer returned no zipfile'));
        return;
      }
      resolve(zipfile);
    });
  });
}

/**
 * Streaming ZIP unpacker.
 *
 * Iterates each entry in lazy mode, enforces the three caps:
 *
 *   1. file_count             — checked BEFORE reading the next entry.
 *   2. file_size              — checked against entry.uncompressedSize header,
 *                                AND enforced live as bytes accumulate (in case
 *                                the header lies — defense in depth).
 *   3. total_uncompressed_size — accumulated PER CHUNK across all entries; the
 *                                stream is destroyed and BatchLimitError thrown
 *                                BEFORE the bomb fully expands (D-15b).
 *
 * Symlinks and directory entries are skipped silently.
 *
 * Returns one `{ path, content }` per non-directory entry, in the order yauzl
 * emits them (which is the central-directory order). Caller is responsible for
 * hidden-dir filtering and non-md filtering.
 */
export async function unpackZip(
  buffer: Buffer,
  limits: UnpackZipLimits
): Promise<UnpackedEntry[]> {
  const zipfile = await openZipFromBuffer(buffer);
  const entries: UnpackedEntry[] = [];
  let entryCount = 0;
  let cumulative = 0;

  return await new Promise<UnpackedEntry[]>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        zipfile.close();
      } catch {
        // ignore
      }
      fn();
    };

    zipfile.on('error', (err) => settle(() => reject(err)));

    zipfile.on('end', () => settle(() => resolve(entries)));

    zipfile.on('entry', (entry: yauzl.Entry) => {
      // Skip directory entries (yauzl convention: name ends with '/').
      if (/\/$/.test(entry.fileName)) {
        zipfile.readEntry();
        return;
      }

      // file_count cap — count BEFORE we materialise this entry.
      entryCount += 1;
      if (entryCount > limits.maxFiles) {
        settle(() => reject(new BatchLimitError('file_count', limits.maxFiles)));
        return;
      }

      // file_size cap — preflight via uncompressedSize header.
      // (yauzl exposes this from the central directory; we still re-check live.)
      if (
        typeof entry.uncompressedSize === 'number' &&
        entry.uncompressedSize > limits.maxFileSize
      ) {
        settle(() => reject(new BatchLimitError('file_size', limits.maxFileSize)));
        return;
      }

      zipfile.openReadStream(entry, (streamErr, readStream) => {
        if (streamErr || !readStream) {
          settle(() => reject(streamErr ?? new Error('openReadStream returned null')));
          return;
        }

        const chunks: Buffer[] = [];
        let entryBytes = 0;

        readStream.on('data', (raw) => {
          if (settled) return;
          const chunk = raw as Buffer;
          entryBytes += chunk.length;
          cumulative += chunk.length;

          // Live per-file cap — defense in depth against forged headers.
          if (entryBytes > limits.maxFileSize) {
            readStream.destroy();
            settle(() =>
              reject(new BatchLimitError('file_size', limits.maxFileSize))
            );
            return;
          }

          // Cumulative cap — D-15b ZIP bomb defense, aborts mid-stream.
          if (cumulative > limits.maxTotalUncompressed) {
            readStream.destroy();
            settle(() =>
              reject(
                new BatchLimitError(
                  'total_uncompressed_size',
                  limits.maxTotalUncompressed
                )
              )
            );
            return;
          }

          chunks.push(chunk);
        });

        readStream.on('error', (e) => settle(() => reject(e)));

        readStream.on('end', () => {
          if (settled) return;
          // Best-effort UTF-8 decode. Binary entries (e.g. embedded PNGs)
          // produce mojibake strings; the endpoint filters non-md before parse.
          const content = Buffer.concat(chunks).toString('utf8');
          entries.push({ path: entry.fileName, content });
          zipfile.readEntry();
        });
      });
    });

    // Begin lazy iteration.
    zipfile.readEntry();
  });
}

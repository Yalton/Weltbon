/**
 * Issue #35 (DOCX-06) — the caps that bound DOCX conversion.
 *
 * One module because the route enforces `docxSize` and `docxCount` before it
 * ever opens a file, while unpack.ts enforces the rest during decompression.
 * Two copies of these numbers would drift, and the drift would be invisible:
 * the route would accept a file the unpacker then rejects, turning a clean 413
 * into a confusing one.
 *
 * The values are deliberately generous against real documents and tight against
 * hostile ones. A 300-page manuscript with no images is a few hundred KB of
 * `document.xml`; 32 MB for a single part is far past anything a writer emits.
 */
export interface DocxLimits {
  /** Compressed .docx size, checked on File.size BEFORE arrayBuffer (T-11-09). */
  docxSize: number;
  /** Number of .docx parts in one batch. Conversion is CPU-bound; MAX_FILES does not bound it. */
  docxCount: number;
  /** Central-directory entry count, checked before decompressing anything. */
  docxEntryCount: number;
  /** Uncompressed bytes of any single allowlisted part, enforced live per chunk. */
  docxPartSize: number;
  /** Uncompressed bytes summed across allowlisted parts, enforced live per chunk. */
  docxTotalUncompressed: number;
  /** XML element nesting depth. */
  docxXmlDepth: number;
  /** Document-model blocks. Bounds CPU on valid-but-pathological input (T-35-04). */
  docxBlockCount: number;
}

export const DOCX_LIMITS: DocxLimits = {
  docxSize: 25 * 1024 * 1024,
  docxCount: 50,
  docxEntryCount: 512,
  docxPartSize: 32 * 1024 * 1024,
  docxTotalUncompressed: 64 * 1024 * 1024,
  docxXmlDepth: 256,
  docxBlockCount: 100_000,
};

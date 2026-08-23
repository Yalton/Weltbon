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
  /**
   * Retained document-model nodes. Bounds CPU and memory on
   * valid-but-pathological input (T-35-04).
   *
   * The unit is NOT "published top-level block", which is all it charged when
   * this shipped and which left the two nesting structures uncounted: one
   * `w:tbl` cost one unit however many `w:tr`/`w:tc` it held, and one `w:p`
   * cost one however many runs. parse.ts now charges a published block, a
   * table row, a table cell, and an emitted run — see charge() there for what
   * a 1 678-byte .docx did with the old accounting.
   *
   * The name is kept as-is on purpose: `docx_block_count` is the wire name in
   * the 413/400 error text and in the spec's caps table, and renaming it would
   * break both for a comment's benefit.
   */
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

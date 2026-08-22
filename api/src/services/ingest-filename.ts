/**
 * api/src/services/ingest-filename.ts
 *
 * `normalizeFilename` in its own module, dependency-free, so that neither
 * `ingest-markdown.ts` nor `ingest-split.ts` needs to import the other just
 * to reach it. See #37 fix-round-2.
 */

// ---------------------------------------------------------------------------
// normalizeFilename — D-10a
// ---------------------------------------------------------------------------

/**
 * Normalize a filename for use as a title fallback (D-10 step 3).
 *
 * Rules (D-10a):
 *   1. Strip `.md` extension (case-insensitive).
 *   2. Replace runs of `_` and `-` with a single space.
 *   3. Trim leading/trailing whitespace.
 *   4. Capitalize the first character only; middle words preserve their
 *      original case to avoid mangling acronyms.
 *
 * @param filename  Bare filename (basename), e.g. "my-cool-entry.md".
 * @returns         Human-readable title, e.g. "My cool entry".
 */
export function normalizeFilename(filename: string): string {
  const base = filename.replace(/\.md$/i, '');
  const s = base.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Slug + filename helpers shared by all four exporters (json/markdown/pdf/docx).
 *
 * Locked path: 30-line custom implementation, NOT github-slugger. The
 * dependency is installed for future heading-anchor needs in the markdown /
 * docx exporters; for filenames we want full control over collision suffixing.
 */

// Combining diacritical marks block: U+0300 – U+036F. We use explicit unicode
// escapes (rather than a literal character-class range) so the regex survives
// editor / pipe encoding gymnastics intact.
const COMBINING_DIACRITICS = /[̀-ͯ]/g;

/**
 * Convert a free-form title into an ASCII lowercase hyphenated slug.
 *
 * - NFKD normalization decomposes accented characters so a single regex pass
 *   strips combining diacritics (Café → cafe).
 * - Any run of non-[a-z0-9] becomes a single hyphen.
 * - Leading/trailing hyphens are trimmed.
 * - If the result is empty (input was punctuation-only), returns "untitled"
 *   so consumers always get a usable filename component.
 */
export function asciiSlug(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(COMBINING_DIACRITICS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

/**
 * Build a map of entryId → unique filename slug.
 *
 * Buckets entries by categoryId (null → "uncategorized") so two entries
 * with identical titles in DIFFERENT categories both get the base slug — the
 * markdown exporter writes them under different folders, so no on-disk
 * collision occurs. Within a bucket the second entry gets `-2`, the third
 * `-3`, etc.
 *
 * Iteration order matters: the FIRST entry in each bucket gets the base
 * slug. Callers wanting stable diffs should pass entries in a deterministic
 * order (e.g. by createdAt).
 */
export function buildSlugMap(
  entries: { id: string; title: string; categoryId: string | null }[],
): Map<string, string> {
  const buckets = new Map<string, Map<string, number>>();
  const result = new Map<string, string>();
  for (const e of entries) {
    const catKey = e.categoryId ?? 'uncategorized';
    const base = asciiSlug(e.title);
    let bucket = buckets.get(catKey);
    if (!bucket) {
      bucket = new Map();
      buckets.set(catKey, bucket);
    }
    const count = (bucket.get(base) ?? 0) + 1;
    bucket.set(base, count);
    result.set(e.id, count === 1 ? base : `${base}-${count}`);
  }
  return result;
}

/**
 * Compose a filename like `post-sundering-2026-04-23.zip`.
 *
 * The date stamp lets users keep successive exports of the same universe in
 * the same Downloads folder without manual renaming (CONTEXT.md decision).
 * If the universe name slugifies to empty, falls back to "universe" (NOT
 * "untitled" — distinct fallback so the filename reads like a usable label).
 */
export function exportFilename(
  universeName: string,
  ext: 'json' | 'zip' | 'pdf' | 'docx',
): string {
  const slug = asciiSlug(universeName);
  const base = slug === 'untitled' ? 'universe' : slug;
  const date = new Date().toISOString().slice(0, 10);
  return `${base}-${date}.${ext}`;
}

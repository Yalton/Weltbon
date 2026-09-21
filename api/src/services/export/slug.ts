
// escapes (rather than a literal character-class range) so the regex survives
const COMBINING_DIACRITICS = /[̀-ͯ]/g;

export function asciiSlug(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(COMBINING_DIACRITICS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

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

export function exportFilename(
  universeName: string,
  ext: 'json' | 'zip' | 'pdf' | 'docx',
): string {
  const slug = asciiSlug(universeName);
  const base = slug === 'untitled' ? 'universe' : slug;
  const date = new Date().toISOString().slice(0, 10);
  return `${base}-${date}.${ext}`;
}

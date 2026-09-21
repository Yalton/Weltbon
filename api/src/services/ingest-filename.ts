
// ---------------------------------------------------------------------------
// normalizeFilename — D-10a
// ---------------------------------------------------------------------------

export function normalizeFilename(filename: string): string {
  const base = filename.replace(/\.md$/i, '');
  const s = base.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

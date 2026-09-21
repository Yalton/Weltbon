/**
 *
 * This is a security boundary, not a formatting helper. Its input is raw text
 * a user typed into the "Base URL" field, and its output becomes an `href` in
 * the user's own authenticated page. Three properties matter, in order:
 *
 * 1. SCHEME. `new URL('javascript:alert(1)')` parses perfectly well and yields
 *    protocol `javascript:`. Nothing about successful parsing implies a safe
 *    scheme, so the allow-list is checked on the PARSED protocol (not on the
 *    raw string, which `\njavascript:` or `JaVaScRiPt:` would slip past).
 * 2. AUTHORITY. The link is built from `origin`, so credentials in the
 *    authority are dropped: `https://evil.com@good.com/` points at good.com,
 *    and rendering the raw text as the href would have shown the user a
 *    plausible-looking address for a request going somewhere else.
 * 3. PATH. Only `pathname` is carried over — query and fragment are dropped
 *    rather than concatenated, since `?x=1` + `/settings/tokens` would produce
 *    a path inside the query string.
 *
 * Returns null for anything that fails those checks. The caller must render
 * NO anchor for null — not a disabled one, not the raw text.
 */
export function tokenMintUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  // fragment along. The trailing-slash strip keeps a bare origin (whose
  const base = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  return `${base}/settings/tokens`;
}

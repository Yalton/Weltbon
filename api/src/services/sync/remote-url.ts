/**
 * Plan D (D-04): validation for a user-supplied sync remote base URL.
 *
 * This is the FIRST outbound HTTP in the API, so the server now fetches a URL
 * the user chose, with a decrypted PAT attached. Three invariants hold on every
 * deployment because they cost nothing and their absence is exploitable:
 * http/https only, no credentials in the URL, no query/fragment.
 *
 * Address filtering is DELIBERATELY opt-in (SYNC_BLOCK_PRIVATE_HOSTS). A
 * self-hoster's legitimate remote genuinely is http://192.168.1.50:3000, and the
 * spec's whole framing is "my friends can't reach my home server" — a blanket
 * private-IP block would break the primary use case to defend a multi-tenant
 * deployment that most installs are not.
 *
 * KNOWN LIMIT, stated rather than implied: this checks the HOSTNAME as written.
 * A DNS name that resolves to a private address passes even with the flag on.
 * Closing that needs resolve-then-pin-the-socket, which Node's fetch does not
 * expose; prod is expected to also have an egress firewall (design spec D-04).
 */

export class InvalidRemoteUrlError extends Error {
  readonly code = 'invalid-remote-url';
  constructor(reason: string) {
    super(`Invalid remote URL: ${reason}`);
    this.name = 'InvalidRemoteUrlError';
  }
}

/**
 * Read at CALL time, not module load, so a test (or a deployment that sets it
 * late) is honored — the same lazily-read idiom as maxFileBytes() in assets.ts.
 */
export function privateHostBlockEnabled(): boolean {
  const v = process.env.SYNC_BLOCK_PRIVATE_HOSTS;
  return v === '1' || v === 'true';
}

/** Literal loopback / private / link-local addresses, v4 and v6. */
export function isPrivateHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '::') return true;
  if (/^f[cd][0-9a-f]*:/.test(h)) return true;   // fc00::/7 unique-local
  if (h.startsWith('fe80:')) return true;        // link-local
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;       // cloud metadata lives here
  return false;
}

/**
 * Validate and canonicalize a remote base URL. Returns `origin + path` with any
 * trailing slashes removed, so callers can concatenate `/api/sync/...` without
 * producing a double slash.
 */
export function normalizeRemoteUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new InvalidRemoteUrlError('not a valid absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidRemoteUrlError(`unsupported scheme "${url.protocol}" — use http or https`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new InvalidRemoteUrlError('credentials in the URL are not allowed — the PAT travels in a header');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new InvalidRemoteUrlError('query strings and fragments are not allowed on a base URL');
  }
  if (privateHostBlockEnabled() && isPrivateHostname(url.hostname)) {
    throw new InvalidRemoteUrlError('private and link-local addresses are blocked on this instance');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

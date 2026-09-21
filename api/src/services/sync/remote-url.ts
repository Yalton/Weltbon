
export class InvalidRemoteUrlError extends Error {
  readonly code = 'invalid-remote-url';
  constructor(reason: string) {
    super(`Invalid remote URL: ${reason}`);
    this.name = 'InvalidRemoteUrlError';
  }
}

export function privateHostBlockEnabled(): boolean {
  const v = process.env.SYNC_BLOCK_PRIVATE_HOSTS;
  return v === '1' || v === 'true';
}

export function isPrivateHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '::') return true;
  if (/^f[cd][0-9a-f]*:/.test(h)) return true;   // fc00::/7 unique-local
  if (h.startsWith('fe80:')) return true;        // link-local

  const mappedDotted = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDotted) return isPrivateHostname(mappedDotted[1]);
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const a = (hi >>> 8) & 0xff;
    const b = hi & 0xff;
    const c = (lo >>> 8) & 0xff;
    const d = lo & 0xff;
    return isPrivateHostname(`${a}.${b}.${c}.${d}`);
  }

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

// This URL receives a decrypted PAT. Private-host blocking is optional and cannot prevent DNS rebinding.
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

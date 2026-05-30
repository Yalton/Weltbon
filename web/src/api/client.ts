let accessToken: string | null = null;
let refreshInflight: Promise<string | null> | null = null;

/**
 * Phase 29 share-mode seam — module-level plaintext share token.
 *
 * When non-null, every `api()` call is routed to the `/api/share/*` prefix
 * with a `share-token` header IN PLACE OF the `Authorization: Bearer`
 * header. The credential domains never overlap on the same request
 * (T-29-28 — strict union). The seam ALSO translates `/universes/<uid>`
 * prefixes off the path so hooks like `useEntries` (which call
 * `/universes/${uid}/entries`) emit `/api/share/entries` automatically,
 * keeping every existing hook usable in share mode with zero hook-level
 * changes.
 *
 * Lifecycle is bounded by `ShareLayout` (mount → `setShareToken(token)`,
 * unmount → `clearShareToken()`) so leaving the share subtree guarantees no
 * leak into a later authenticated session in the same tab (T-29-27).
 */
let shareTokenPlaintext: string | null = null;

export function setAccessToken(token: string | null) { accessToken = token; }
export function getAccessToken(): string | null { return accessToken; }
export function clearAccessToken() { accessToken = null; }

export function setShareToken(token: string | null) { shareTokenPlaintext = token; }
export function getShareToken(): string | null { return shareTokenPlaintext; }
export function clearShareToken() { shareTokenPlaintext = null; }

export class UnauthenticatedError extends Error {
  constructor() { super('Not authenticated'); this.name = 'UnauthenticatedError'; }
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function attemptRefresh(): Promise<string | null> {
  refreshInflight ??= (async () => {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { accessToken: string };
    return body.accessToken;
  })().finally(() => { refreshInflight = null; });
  return refreshInflight;
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const doFetch = (token: string | null): Promise<Response> => {
    // When the body is FormData, the browser sets
    // `multipart/form-data; boundary=...` automatically — overriding it
    // with `application/json` here would strip the boundary parameter and
    // make the server unable to parse the body. JSON callsites (string /
    // undefined body) keep the existing default.
    const isFormData = init.body instanceof FormData;
    const baseHeaders: Record<string, string> = isFormData
      ? {}
      : { 'Content-Type': 'application/json' };

    // Phase 29 share-mode branch (T-29-28 strict union — never both auth
    // headers on the same request). The path translation strips a leading
    // `/universes/<uid>` segment if present so authenticated-style hooks
    // (e.g. `/universes/${uid}/entries`) emit the share-namespace shape
    // `/api/share/entries`. Paths that do NOT begin with `/universes/<uid>`
    // (e.g. `/auth/me`, `/llm-keys`) pass through unchanged — they would
    // hit `/api/share/<path>` which Plan 04 does not declare, so Hono 404s
    // them (acceptable per T-29-29 — they are not in the visitor's
    // expected fetch surface).
    if (shareTokenPlaintext) {
      const translatedPath = path.replace(/^\/universes\/[^/]+/, '');
      return fetch(`/api/share${translatedPath}`, {
        ...init,
        // No cookies on share requests — visitor is unauthenticated and
        // must not transmit any leftover auth cookies cross-namespace.
        credentials: 'omit',
        headers: {
          ...baseHeaders,
          ...(init.headers ?? {}),
          'share-token': shareTokenPlaintext,
        },
      });
    }

    return fetch(`/api${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        ...baseHeaders,
        ...(init.headers ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  };

  let res = await doFetch(accessToken);
  // Only attempt silent refresh for protected (non-/auth) endpoints AND
  // never in share mode (the visitor has no refresh cookie; a share-token
  // is either valid or not). /auth/login, /auth/register, /auth/refresh,
  // /auth/logout, and /auth/me each have their own expected semantics —
  // a 401 from /auth/login means "wrong credentials" (should surface to
  // the user), a 401 from /auth/refresh means "refresh cookie invalid"
  // (already the refresh attempt — don't recurse). Guarding here prevents
  // infinite refresh loops and spurious refresh calls on failed logins.
  // Defense-in-depth: also skip the refresh path for any request whose URL is
  // under /share/ — a visitor has no refresh cookie, and the token is either
  // valid or not. This guards the edge case where shareTokenPlaintext was null
  // at call-site check time but the URL is still a share path.
  if (
    res.status === 401 &&
    !path.startsWith('/auth/') &&
    !shareTokenPlaintext &&
    !window.location.pathname.startsWith('/share/')
  ) {
    const fresh = await attemptRefresh();
    if (!fresh) {
      accessToken = null;
      throw new UnauthenticatedError();
    }
    accessToken = fresh;
    res = await doFetch(accessToken);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && body !== null && 'error' in body
        ? String((body as Record<string, unknown>).error)
        : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, body, msg);
  }
  return body as T;
}

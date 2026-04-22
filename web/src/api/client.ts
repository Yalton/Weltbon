let accessToken: string | null = null;
let refreshInflight: Promise<string | null> | null = null;

export function setAccessToken(token: string | null) { accessToken = token; }
export function getAccessToken(): string | null { return accessToken; }
export function clearAccessToken() { accessToken = null; }

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
  const doFetch = (token: string | null): Promise<Response> =>
    fetch(`/api${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

  let res = await doFetch(accessToken);
  // Only attempt silent refresh for protected (non-/auth) endpoints.
  // /auth/login, /auth/register, /auth/refresh, /auth/logout, and /auth/me
  // each have their own expected semantics — a 401 from /auth/login means
  // "wrong credentials" (should surface to the user), a 401 from
  // /auth/refresh means "refresh cookie invalid" (already the refresh
  // attempt — don't recurse). Guarding here prevents infinite refresh
  // loops and spurious refresh calls on failed logins.
  if (res.status === 401 && !path.startsWith('/auth/')) {
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

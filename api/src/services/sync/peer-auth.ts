/**
 * OB-02. Exchange a user's credentials on a PEER instance for a PAT minted
 * there, so the desktop user never has to leave the app to mint one by hand
 * (the "F-05 wall" named in web/src/components/SyncRemoteForm.tsx:27).
 *
 * This module deliberately does NOT touch the database or the encryption key.
 * It returns a plaintext PAT to its caller, which is responsible for
 * encrypting and storing it. Keeping the split here means the password's
 * lifetime is this function's stack frame and nothing wider.
 *
 * The password must never reach a log line, an error message, or a response
 * body. Every throw site below constructs its message from constants only.
 *
 * Peer contract (verified against src/routes/auth.ts and src/routes/tokens.ts
 * on this same server, since a peer is another Weltbon instance running the
 * same API):
 *   POST /api/auth/login  { email, password } -> 200 { accessToken, user }
 *   POST /api/auth/tokens { label }, Authorization: Bearer <accessToken>
 *                          -> 200 { id, label, bodySuffix, createdAt, plaintext }
 * Note the login JWT field is `accessToken` (not `token`), the mint request
 * field is `label` (not `name`), the mint success status is 200 (not 201),
 * and the minted PAT comes back as `plaintext` (not `token`).
 */

export type PeerAuthCode =
  | 'peer_credentials_rejected'
  | 'peer_unreachable'
  | 'peer_not_weltbon';

/**
 * WHY `peer_credentials_rejected` IS 422 AND NOT 401 (fix wave, finding I6).
 *
 * The peer rejecting the user's email/password is not "you are unauthenticated
 * with THIS server" — the caller's own JWT was valid, or `requireJwtAuth`
 * would never have let the request reach here. Returning 401 conflates the two,
 * and the SPA's fetch wrapper acts on that conflation: web/src/api/client.ts
 * retries any non-`/auth/` 401 through `attemptRefresh()`, and when the refresh
 * cookie has expired it clears the access token and throws
 * `UnauthenticatedError`. A typo'd PEER password would therefore rotate the
 * user's LOCAL session, re-send their peer credentials a second time, and could
 * sign them out of the desktop app entirely — a "Not authenticated" screen where
 * the design spec's error table demands "Email or password wasn't accepted by
 * that instance", "never a generic failure".
 *
 * 422 says what actually happened: the request was well-formed and
 * authenticated, but a value inside it was not accepted by the upstream this
 * route depends on. The route's OWN missing-JWT 401 is untouched.
 */
export class PeerAuthError extends Error {
  constructor(
    message: string,
    readonly code: PeerAuthCode,
    readonly status: 400 | 422 | 502,
  ) {
    super(message);
    this.name = 'PeerAuthError';
  }
}

async function readJson(res: Response): Promise<unknown> {
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    throw new PeerAuthError(
      'that address answered, but not as a Weltbon instance',
      'peer_not_weltbon',
      502,
    );
  }
  try {
    return await res.json();
  } catch {
    throw new PeerAuthError(
      'that address answered with a malformed response',
      'peer_not_weltbon',
      502,
    );
  }
}

export async function mintPatFromCredentials(args: {
  baseUrl: string;
  email: string;
  password: string;
  label: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const doFetch = args.fetchImpl ?? fetch;

  const send = async (path: string, init: RequestInit): Promise<Response> => {
    try {
      return await doFetch(`${args.baseUrl}${path}`, init);
    } catch {
      // Deliberately does not include the caught error: a transport error can
      // carry the request in its message on some runtimes, and the request
      // body here holds the password.
      throw new PeerAuthError(
        'could not reach a Weltbon instance at that address',
        'peer_unreachable',
        502,
      );
    }
  };

  const loginRes = await send('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: args.email, password: args.password }),
  });

  if (loginRes.status === 401) {
    throw new PeerAuthError(
      'that instance did not accept the email and password',
      'peer_credentials_rejected',
      422,
    );
  }
  if (!loginRes.ok) {
    throw new PeerAuthError(
      'that instance refused the sign-in',
      'peer_not_weltbon',
      502,
    );
  }

  const loginBody = await readJson(loginRes) as { accessToken?: unknown };
  if (typeof loginBody.accessToken !== 'string' || loginBody.accessToken === '') {
    throw new PeerAuthError(
      'that address answered, but not as a Weltbon instance',
      'peer_not_weltbon',
      502,
    );
  }
  const jwt = loginBody.accessToken;

  const tokenRes = await send('/api/auth/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ label: args.label }),
  });

  if (!tokenRes.ok) {
    throw new PeerAuthError(
      'signed in, but that instance would not issue an access token',
      'peer_not_weltbon',
      502,
    );
  }

  const tokenBody = await readJson(tokenRes) as { plaintext?: unknown };
  if (typeof tokenBody.plaintext !== 'string' || tokenBody.plaintext === '') {
    throw new PeerAuthError(
      'signed in, but that instance returned no usable access token',
      'peer_not_weltbon',
      502,
    );
  }
  return tokenBody.plaintext;
}

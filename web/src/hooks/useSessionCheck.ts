import { useEffect, useState } from 'react';
import { useAuthStore } from '../store/auth';
import { api, setAccessToken, attemptRefresh } from '../api/client';

interface MeResponse {
  id: string;
  email: string;
  displayName: string;
  isAdmin?: boolean;
}

export type SessionState = 'checking' | 'ok' | 'anonymous';

/**
 * Resolves whether the visitor has a session: an in-memory user, or a refresh
 * cookie that can be silently exchanged for one. Shared by ProtectedRoute and
 * the public home route so a returning user never sees the landing page.
 */
export function useSessionCheck(): SessionState {
  const user = useAuthStore((s) => s.user);
  const signedOut = useAuthStore((s) => s.signedOut);
  const setSession = useAuthStore((s) => s.setSession);
  const markSignedOut = useAuthStore((s) => s.markSignedOut);
  const [state, setState] = useState<SessionState>(user ? 'ok' : signedOut ? 'anonymous' : 'checking');

  useEffect(() => {
    if (user) { setState('ok'); return; }
    if (signedOut) { setState('anonymous'); return; }
    let cancelled = false;
    (async () => {
      try {
        // Step 1 -- attempt silent refresh through the SHARED deduped helper.
        // This used to be a raw fetch('/api/auth/refresh'). The comment then
        // explained that api()'s 401-retry branch is guarded away from /auth/*
        // skipped `refreshInflight`, the in-flight dedupe that exists precisely to
        // make concurrent refreshes safe. React.StrictMode double-invokes this
        // single-use rotating token. attemptRefresh() collapses them into one
        // call; it is not the retry branch, so the /auth/* guard is unaffected.
        const token = await attemptRefresh();
        if (cancelled) return;
        if (!token) { markSignedOut(); setState('anonymous'); return; }
        setAccessToken(token);

        // Step 2 -- rehydrate user identity via /auth/me so the user menu
        // shows a real displayName instead of a placeholder. /auth/me is
        // api() will inject the Authorization header and /auth/me returns 200.
        const me = await api<MeResponse>('/auth/me');
        if (cancelled) return;
        setSession({ id: me.id, email: me.email, displayName: me.displayName, isAdmin: me.isAdmin ?? false }, token);
        setState('ok');
      } catch {
        if (cancelled) return;
        // UnauthenticatedError OR any network/shape failure -- treat as signed out
        // for now, but do not remember it: a later visit should try again.
        setState('anonymous');
      }
    })();
    return () => { cancelled = true; };
  }, [user, signedOut, setSession, markSignedOut]);

  return state;
}

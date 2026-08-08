import { useEffect, useState } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { api, setAccessToken, attemptRefresh } from '../api/client';

/**
 * If we have a session in memory, render children.
 * If not, try one silent refresh. If that fails, redirect to /login.
 */
interface MeResponse {
  id: string;
  email: string;
  displayName: string;
}

export function ProtectedRoute() {
  const user = useAuthStore((s) => s.user);
  const setSession = useAuthStore((s) => s.setSession);
  const [state, setState] = useState<'checking' | 'ok' | 'anonymous'>(
    user ? 'ok' : 'checking'
  );

  useEffect(() => {
    if (user) { setState('ok'); return; }
    let cancelled = false;
    (async () => {
      try {
        // Step 1 -- attempt silent refresh through the SHARED deduped helper.
        //
        // This used to be a raw fetch('/api/auth/refresh'). The comment then
        // explained that api()'s 401-retry branch is guarded away from /auth/*
        // paths — true, but it justified bypassing client.ts entirely, which also
        // skipped `refreshInflight`, the in-flight dedupe that exists precisely to
        // make concurrent refreshes safe. React.StrictMode double-invokes this
        // effect in development and the `cancelled` flag below guards only the
        // state writes, not the request, so both refreshes went out against a
        // single-use rotating token. attemptRefresh() collapses them into one
        // call; it is not the retry branch, so the /auth/* guard is unaffected.
        let token = await attemptRefresh();
        if (cancelled) return;
        if (!token) {
          // DV-12: the desktop app has no login screen. On a server deployment
          // this route 404s and we fall through to /login exactly as before --
          // one extra request on a path that was already about to show a login
          // form, which is why this needs no build-time flag and the web bundle
          // stays shared with the server (D-03).
          const localRes = await fetch('/api/auth/local-session', {
            method: 'POST',
            credentials: 'include',
          });
          if (cancelled) return;
          if (!localRes.ok) { setState('anonymous'); return; }
          token = ((await localRes.json()) as { accessToken: string }).accessToken;
        }
        setAccessToken(token);

        // Step 2 -- rehydrate user identity via /auth/me so the user menu
        // shows a real displayName instead of a placeholder. /auth/me is
        // a protected endpoint but we just set the access token above, so
        // api() will inject the Authorization header and /auth/me returns 200.
        const me = await api<MeResponse>('/auth/me');
        if (cancelled) return;
        setSession({ id: me.id, email: me.email, displayName: me.displayName }, token);
        setState('ok');
      } catch {
        if (cancelled) return;
        // UnauthenticatedError OR any network/shape failure -- bounce to /login.
        setState('anonymous');
      }
    })();
    return () => { cancelled = true; };
  }, [user, setSession]);

  if (state === 'checking') {
    return <div className="px-6 py-8 text-sm text-neutral-500">Loading...</div>;
  }
  if (state === 'anonymous') {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}

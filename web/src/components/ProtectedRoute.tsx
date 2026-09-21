import { useEffect, useState } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { api, setAccessToken, attemptRefresh } from '../api/client';
import { Loading } from './ui/Loading';

interface MeResponse {
  id: string;
  email: string;
  displayName: string;
  isAdmin?: boolean;
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
        // This used to be a raw fetch('/api/auth/refresh'). The comment then
        // explained that api()'s 401-retry branch is guarded away from /auth/*
        // skipped `refreshInflight`, the in-flight dedupe that exists precisely to
        // make concurrent refreshes safe. React.StrictMode double-invokes this
        // single-use rotating token. attemptRefresh() collapses them into one
        // call; it is not the retry branch, so the /auth/* guard is unaffected.
        const token = await attemptRefresh();
        if (cancelled) return;
        if (!token) { setState('anonymous'); return; }
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
        // UnauthenticatedError OR any network/shape failure -- bounce to /login.
        setState('anonymous');
      }
    })();
    return () => { cancelled = true; };
  }, [user, setSession]);

  if (state === 'checking') {
    return <Loading fullPage />;
  }
  if (state === 'anonymous') {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}

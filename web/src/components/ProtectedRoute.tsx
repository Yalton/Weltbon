import { useEffect, useState } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '../store/auth';
import { api, setAccessToken } from '../api/client';

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
        // Step 1 -- attempt silent refresh. Call /auth/refresh directly
        // (the api() client's 401-retry branch is guarded away from /auth/*
        // paths, so we POST directly and inspect the response).
        const refreshRes = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'include',
        });
        if (cancelled) return;
        if (!refreshRes.ok) {
          setState('anonymous');
          return;
        }
        const { accessToken } = (await refreshRes.json()) as { accessToken: string };
        setAccessToken(accessToken);

        // Step 2 -- rehydrate user identity via /auth/me so the user menu
        // shows a real displayName instead of a placeholder. /auth/me is
        // a protected endpoint but we just set the access token above, so
        // api() will inject the Authorization header and /auth/me returns 200.
        const me = await api<MeResponse>('/auth/me');
        if (cancelled) return;
        setSession({ id: me.id, email: me.email, displayName: me.displayName }, accessToken);
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

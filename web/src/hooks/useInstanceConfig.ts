/**
 * Issue #48 Task 7 — GET /api/config wrapper.
 *
 * Instance facts (today, exactly `localMode`). They change only on redeploy
 * of THIS instance, so cache them hard — `staleTime: Infinity` means one
 * fetch per page load, never a background refetch.
 *
 * Auth correction (Task 6 review, carried into Task 7): the brief this hook
 * was originally written against described `/api/config` as unauthenticated.
 * Task 6 put `requireAuth` on it instead — the route needed to sit inside the
 * SHARE-03 / T-29-22 boundary (every non-`/share/*` route must reject a
 * share-token-only request), and no pre-login consumer of this route exists
 * (OllamaConnectionSection, the only consumer, is post-login settings UI
 * mounted under `<ProtectedRoute>`). So `enabled` below gates the fetch on
 * having a session, mirroring the `enabled: !!id && ...` pattern other
 * authenticated hooks in this directory use (e.g. useUniverse.ts's
 * `!shareMode || shareToken !== null`) rather than the "no gate at all"
 * shape of useLlmKeys.ts — that hook is *only* ever mounted on already-
 * protected routes, but `useAuthStore` gives us a direct signal here instead
 * of relying on route placement alone. Without this gate, a hook that
 * mounted even one render before ProtectedRoute resolves 'ok' would issue a
 * request that just 401s — harmless today, but a silent trap for whoever
 * reuses this hook from a spot that isn't already behind ProtectedRoute.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useAuthStore } from '../store/auth';

export function useInstanceConfig(): { localMode: boolean | undefined } {
  const user = useAuthStore((s) => s.user);
  const { data } = useQuery({
    queryKey: ['instance-config'],
    queryFn: () => api<{ localMode: boolean }>('/config'),
    enabled: user !== null,
    staleTime: Infinity,
  });
  return { localMode: data?.localMode };
}

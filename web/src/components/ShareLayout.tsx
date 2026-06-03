import { Outlet, useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { AppBackground } from './AppBackground';
import { ShareSidebar } from './ShareSidebar';
import { ShareModeProvider } from '../contexts/ShareModeContext';
import { ShareNotFound } from '../views/ShareNotFound';
import { api, setShareToken, clearShareToken, ApiError } from '../api/client';
import type { Calendar } from '../lib/calendarFormat';

/**
 * Public root URL for the "Made with Weltbon" banner brand link.
 *
 * UI-SPEC §Copywriting Contract: "Weltbon is a link to https://weltbon.app
 * (or the configured public URL root)". The project has no Vite `.env` file
 * and no `import.meta.env` typing baseline, so this is a hardcoded constant
 * — future plans can introduce a VITE_PUBLIC_URL seam with a `vite-env.d.ts`
 * reference if the public root ever needs per-environment configuration.
 */
const PUBLIC_ROOT_URL = 'https://weltbon.app';

interface UniverseMeta {
  name: string;
  ownerDisplayName: string;
  /**
   * Phase 33 INT-BLOCKER-1 fix: the server already returns `calendar` on this
   * object (api/src/services/share-views.ts getPublicUniverseMeta +
   * universeMetaResponseSchema). Widen the client type so the value flows
   * through instead of being silently dropped.
   */
  calendar?: Calendar | null;
}

interface ShareUniverseResponse {
  universe: UniverseMeta;
}

/**
 * Layout shell for the `/share/:token/*` visitor read-only subtree.
 *
 * Parallels `UniverseLayout` but with auth chrome removed (no `<UserMenu>`,
 * no `<Link to="/universes">`) and a persistent UI-SPEC §A banner mounted
 * sticky at the top.
 *
 * Lifecycle (T-29-27 leak prevention):
 *  - On render: `setShareToken(token)` is called SYNCHRONOUSLY in the render
 *    body (before any descendant queries fire) so the module-level seam is
 *    ready by the time child hooks call their first queryFn. This closes the
 *    StrictMode race (mount→clear→remount cycle) in combination with the
 *    token-keyed query cache in the share-subtree read hooks (half b of the
 *    Gap 1 fix — see useFilteredEntries, useCategories, useUniverse).
 *  - On mount (useEffect): `setShareToken(token)` is also set here for the
 *    metadata fetch, and cleanup runs `clearShareToken()` so navigating away
 *    guarantees no leak into a subsequent authenticated session (T-29-27).
 *
 * Universe metadata is fetched from `GET /api/share/universe` (Plan 04
 * — `{ universe: { name, ownerDisplayName } }`). A 404 here means the token
 * is invalid, revoked, or expired — render `<ShareNotFound />` per
 * UI-SPEC §G (no banner, no login/register CTA per D-19).
 *
 * Mounted children read `isShareMode === true` via `useShareMode()` and
 * gate mutation affordances per the UI-SPEC §A Kept-affordances table.
 */
export function ShareLayout() {
  const { token } = useParams<{ token: string }>();
  const [universeMeta, setUniverseMeta] = useState<UniverseMeta | null>(null);
  const [error, setError] = useState<boolean>(false);

  // HALF (a) — synchronous token readiness (Gap 1 race fix):
  // Set the share token in the render body, BEFORE the useEffect below and
  // BEFORE any descendant component renders or fires its first query. This
  // ensures the module-level shareTokenPlaintext seam is non-null by the time
  // React calls any child queryFn on this render pass. The StrictMode
  // unmount→clearShareToken(null)→remount cycle is safe because the
  // token-keyed cache (half b) ensures a null-token 404 entry occupies a
  // distinct cache slot from the ready-token result.
  if (token) {
    setShareToken(token);
  }

  useEffect(() => {
    if (!token) return;
    setShareToken(token);
    // The leading `/universe` path becomes `/api/share/universe` after the
    // Task 1 client seam (path translation strips the /universes/<uid>
    // prefix when present; here there is none, so /universe passes through
    // and the prefix swap routes it correctly).
    api<ShareUniverseResponse>('/universe')
      .then((res) => setUniverseMeta(res.universe))
      .catch((err) => {
        // 404 → ShareNotFound (invalid/revoked/expired token per UI-SPEC §G).
        // Any other ApiError → also surface ShareNotFound; the visitor has no
        // session, so there is no useful recovery action other than the copy
        // "ask the owner for an updated link". Network errors fall into the
        // same bucket — the visitor cannot do anything else.
        if (err instanceof ApiError) {
          setError(true);
        } else {
          setError(true);
        }
      });
    return () => {
      clearShareToken();
    };
  }, [token]);

  if (!token) return null;
  if (error) return <ShareNotFound />;

  if (!universeMeta) {
    return (
      <div className="min-h-full flex items-center justify-center">
        <div className="h-8 w-48 rounded bg-neutral-100 dark:bg-neutral-800 animate-pulse" />
      </div>
    );
  }

  return (
    <ShareModeProvider
      calendar={universeMeta.calendar ?? null}
      token={token ?? null}
    >
      <div className="min-h-full flex flex-col">
        <AppBackground />
        <header
          role="banner"
          className="border-b border-neutral-200 dark:border-neutral-800 px-6 py-3 sticky top-0 z-10 bg-neutral-100 dark:bg-neutral-900 flex items-center justify-between flex-wrap gap-2"
        >
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Shared read-only view of{' '}
            <span className="font-semibold text-neutral-900 dark:text-neutral-100">
              {universeMeta.name}
            </span>{' '}
            by {universeMeta.ownerDisplayName}
          </p>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            · Made with{' '}
            <a
              href={PUBLIC_ROOT_URL}
              className="text-sm font-semibold text-[color:var(--color-accent)] hover:underline"
              aria-label="Weltbon — free worldbuilding tool"
            >
              Weltbon
            </a>
          </p>
        </header>
        <div className="flex-1 flex min-h-0">
          <ShareSidebar token={token} />
          <main className="flex-1 overflow-y-auto px-6 py-8">
            <Outlet />
          </main>
        </div>
      </div>
    </ShareModeProvider>
  );
}

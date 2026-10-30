import { Outlet, useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { AppBackground } from './AppBackground';
import { ShareSidebar } from './ShareSidebar';
import { ThemeScope } from './theme/ThemeScope';
import { ShareModeProvider } from '../contexts/ShareModeContext';
import { ShareNotFound } from '../views/ShareNotFound';
import { api, setShareToken, clearShareToken, ApiError } from '../api/client';
import type { Calendar } from '../lib/calendarFormat';
import type { TimelineWindow } from '../hooks/useTimelineWindow';
import type { UniverseTheme } from '../types/theme';

const PUBLIC_ROOT_URL = 'https://weltbon.app';

interface UniverseMeta {
  name: string;
  ownerDisplayName: string;
  calendar?: Calendar | null;
  timelineWindow?: TimelineWindow | null;
  theme?: UniverseTheme | null;
  backdropUrl?: string | null;
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
 * - On render: `setShareToken(token)` is called SYNCHRONOUSLY in the render
 * body (before any descendant queries fire) so the module-level seam is
 * ready by the time child hooks call their first queryFn. This closes the
 * StrictMode race (mount→clear→remount cycle) in combination with the
 * token-keyed query cache in the share-subtree read hooks (half b of the
 * Gap 1 fix — see useFilteredEntries, useCategories, useUniverse).
 * - On mount (useEffect): `setShareToken(token)` is also set here for the
 * metadata fetch, and cleanup runs `clearShareToken()` so navigating away
 * guarantees no leak into a subsequent authenticated session (T-29-27).
 *
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

  // ensures the module-level shareTokenPlaintext seam is non-null by the time
  // token-keyed cache (half b) ensures a null-token 404 entry occupies a
  // distinct cache slot from the ready-token result.
  if (token) {
    setShareToken(token);
  }

  useEffect(() => {
    if (!token) return;
    setShareToken(token);
    api<ShareUniverseResponse>('/universe')
      .then((res) => setUniverseMeta(res.universe))
      .catch((err) => {
        // 404 → ShareNotFound (invalid/revoked/expired token per UI-SPEC §G).
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
        <div className="h-8 w-48 rounded bg-raised animate-pulse" />
      </div>
    );
  }

  return (
    <ShareModeProvider
      calendar={universeMeta.calendar ?? null}
      token={token ?? null}
      timelineWindow={universeMeta.timelineWindow ?? null}
    >
      <ThemeScope
        theme={universeMeta.theme}
        backdropUrl={universeMeta.backdropUrl}
        className="h-full flex flex-col"
      >
        {!universeMeta.backdropUrl && <AppBackground />}
        <header
          role="banner"
          className="border-b border-line px-6 py-3 sticky top-0 z-10 bg-panel flex items-center justify-between flex-wrap gap-2"
        >
          <p className="text-sm text-ink-secondary">
            Shared read-only view of{' '}
            <span className="font-semibold text-ink">
              {universeMeta.name}
            </span>{' '}
            by {universeMeta.ownerDisplayName}
          </p>
          <p className="text-sm text-ink-secondary">
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
      </ThemeScope>
    </ShareModeProvider>
  );
}

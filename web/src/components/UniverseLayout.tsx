import { Outlet, Link, useParams } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { UserMenu } from './UserMenu';
import { AppBackground } from './AppBackground';
import { useUniverse } from '../hooks/useUniverse';

/**
 * Layout shell for universe-scoped routes (/universes/:uid/entries/*,
 * /universes/:uid/graph, /universes/:uid/issues, /universes/:uid/import).
 *
 * Provides the sidebar + outlet split. The header mirrors the header-only
 * Layout so the app feels consistent when transitioning between the
 * universe picker (/universes) and a specific universe. Renders
 * AppBackground so the ambient sim is visible across every authenticated
 * universe-scoped surface (matches the Layout shell used by /universes
 * and /settings).
 */
export function UniverseLayout() {
  const { uid } = useParams<{ uid: string }>();
  const { data: universe } = useUniverse(uid);
  if (!uid) return null;

  return (
    <div className="min-h-full flex flex-col">
      <AppBackground />
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[color:var(--color-chrome)] backdrop-blur-md px-6 py-3 flex items-center justify-between">
        <div className="flex items-baseline gap-3 min-w-0">
          <Link to="/universes" className="wordmark text-lg shrink-0">
            Weltbon
          </Link>
          {universe?.name && (
            <>
              <span className="text-ink-muted">/</span>
              <span className="text-sm text-indigo-200 truncate">{universe.name}</span>
            </>
          )}
        </div>
        <UserMenu />
      </header>
      <div className="flex-1 flex min-h-0">
        <Sidebar universeId={uid} />
        <main className="flex-1 overflow-y-auto px-6 py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

import { Outlet, Link, useParams } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { UserMenu } from './UserMenu';
import { AppBackground } from './AppBackground';

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
  if (!uid) return null;

  return (
    <div className="min-h-full flex flex-col">
      <AppBackground />
      <header className="border-b border-neutral-200 dark:border-neutral-800 px-6 py-3 flex items-center justify-between">
        <Link to="/universes" className="font-semibold text-[color:var(--color-accent)]">
          Weltbon
        </Link>
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

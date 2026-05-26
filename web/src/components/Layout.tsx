import { Outlet, Link } from 'react-router-dom';
import { UserMenu } from './UserMenu';
import { AppBackground } from './AppBackground';
import { InFlightAuditsBadge } from './InFlightAuditsBadge';

export function Layout() {
  return (
    <div className="min-h-full flex flex-col">
      <AppBackground />
      <header className="border-b border-neutral-200 dark:border-neutral-800 px-6 py-3 flex items-center justify-between">
        <Link to="/universes" className="font-semibold text-[color:var(--color-accent)]">
          Weltbon
        </Link>
        {/* Phase 26 D-17: cross-universe in-flight audits badge sits next to
            the user menu. InFlightAuditsBadge returns null when no runs are
            in flight, so the header gracefully collapses to just the UserMenu
            for users without active audits (zero visual delta vs pre-Phase-26). */}
        <div className="flex items-center gap-2">
          <InFlightAuditsBadge />
          <UserMenu />
        </div>
      </header>
      <main className="flex-1 px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}

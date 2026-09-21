import { Outlet, Link } from 'react-router-dom';
import { UserMenu } from './UserMenu';
import { AppBackground } from './AppBackground';
import { InFlightAuditsBadge } from './InFlightAuditsBadge';

export function Layout() {
  return (
    <div className="min-h-full flex flex-col">
      <AppBackground />
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[color:var(--color-chrome)] backdrop-blur-md px-6 py-3 flex items-center justify-between">
        <Link to="/universes" className="wordmark text-lg">
          Weltbon
        </Link>

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

import { Outlet, Link } from 'react-router-dom';
import { UserMenu } from './UserMenu';

export function Layout() {
  return (
    <div className="min-h-full flex flex-col">
      <header className="border-b border-neutral-200 dark:border-neutral-800 px-6 py-3 flex items-center justify-between">
        <Link to="/universes" className="font-semibold text-[color:var(--color-accent)]">
          Weltbon
        </Link>
        <UserMenu />
      </header>
      <main className="flex-1 px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}

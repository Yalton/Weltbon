import { Outlet, Link, useParams } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { UserMenu } from './UserMenu';
import { AppBackground } from './AppBackground';
import { ThemeScope } from './theme/ThemeScope';
import { useUniverse } from '../hooks/useUniverse';

export function UniverseLayout() {
  const { uid } = useParams<{ uid: string }>();
  const { data: universe } = useUniverse(uid);
  if (!uid) return null;

  return (
    <ThemeScope
      theme={universe?.theme}
      backdropUrl={universe?.backdropUrl}
      className="h-full flex flex-col"
    >
      {!universe?.backdropUrl && <AppBackground />}
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[color:var(--color-chrome)] backdrop-blur-md px-6 py-3 flex items-center justify-between">
        <div className="flex items-baseline gap-3 min-w-0">
          <Link to="/universes" className="wordmark text-lg shrink-0">
            Weltbon
          </Link>
          {universe?.name && (
            <>
              <span className="text-ink-muted">/</span>
              <span className="text-sm text-accent-ink truncate">{universe.name}</span>
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
    </ThemeScope>
  );
}

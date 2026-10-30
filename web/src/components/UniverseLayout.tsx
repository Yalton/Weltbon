import { useEffect, useState } from 'react';
import { Outlet, Link, useLocation, useParams } from 'react-router-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { Sidebar } from './Sidebar';
import { UserMenu } from './UserMenu';
import { KeyboardShortcuts } from './KeyboardShortcuts';
import { AppBackground } from './AppBackground';
import { ThemeScope } from './theme/ThemeScope';
import { useUniverse } from '../hooks/useUniverse';

export function UniverseLayout() {
  const { uid } = useParams<{ uid: string }>();
  const { data: universe } = useUniverse(uid);
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(false);

  // Following a link in the drawer should land on the page, not leave the
  // drawer covering it.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname, location.search]);

  if (!uid) return null;

  return (
    <ThemeScope
      theme={universe?.theme}
      backdropUrl={universe?.backdropUrl}
      className="h-full flex flex-col"
    >
      {!universe?.backdropUrl && <AppBackground />}
      <Dialog.Root open={navOpen} onOpenChange={setNavOpen}>
        <header className="sticky top-0 z-30 border-b border-line bg-chrome h-14 px-4 md:px-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Dialog.Trigger
              aria-label="Open navigation"
              className="md:hidden -ml-1 rounded-lg p-1.5 text-ink-secondary hover:bg-white/5 hover:text-ink"
            >
              <svg
                viewBox="0 0 16 16"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
              </svg>
            </Dialog.Trigger>
            <div className="flex items-baseline gap-3 min-w-0">
              <Link to="/universes" className="wordmark text-lg shrink-0">
                Weltbon
              </Link>
              {universe?.name && (
                <>
                  <span className="text-ink-muted" aria-hidden="true">/</span>
                  <span className="font-display text-[15px] text-ink truncate">{universe.name}</span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <KeyboardShortcuts />
            <UserMenu />
          </div>
        </header>
        {/* Rendered without a portal so the drawer stays inside ThemeScope and
            keeps the universe's palette variables. */}
        <Dialog.Overlay className="md:hidden fixed inset-0 z-40 bg-[rgb(3_5_10/0.72)] data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
        <Dialog.Content
          aria-describedby={undefined}
          className="md:hidden fixed inset-y-0 left-0 z-50 flex max-w-[85vw] flex-col shadow-ambient focus:outline-none"
        >
          <Dialog.Title className="sr-only">Universe navigation</Dialog.Title>
          <div className="flex justify-end border-r border-line bg-chrome px-2 pt-2">
            <Dialog.Close
              aria-label="Close navigation"
              className="rounded-lg p-1.5 text-ink-secondary hover:bg-white/5 hover:text-ink"
            >
              <svg
                viewBox="0 0 16 16"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1">
            <Sidebar universeId={uid} />
          </div>
        </Dialog.Content>
      </Dialog.Root>
      <div className="flex-1 flex min-h-0">
        <div className="hidden md:block h-full">
          <Sidebar universeId={uid} />
        </div>
        <main className="flex-1 min-w-0 overflow-y-auto px-4 md:px-6 py-8">
          <Outlet />
        </main>
      </div>
    </ThemeScope>
  );
}

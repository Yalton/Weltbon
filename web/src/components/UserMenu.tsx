import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useAuthStore } from '../store/auth';
import { useLogout } from '../hooks/useAuth';
import { useNavigate, Link } from 'react-router-dom';
import {
  menuContentClasses,
  menuItemClasses,
  menuSeparatorClasses,
} from './ui/overlay';
import { useRuntime } from '../runtime/RuntimeProvider';

export function UserMenu() {
  const { authMode } = useRuntime();
  const user = useAuthStore((s) => s.user);
  const logout = useLogout();
  const navigate = useNavigate();

  if (authMode === 'local') {
    return (
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          aria-label="Application menu"
          className="rounded-lg px-2 py-1.5 text-sm text-ink-secondary hover:bg-white/5 hover:text-ink"
        >
          Settings
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className={menuContentClasses} sideOffset={6}>
            <DropdownMenu.Item asChild>
              <Link to="/settings" className={`block ${menuItemClasses}`}>
                Settings
              </Link>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    );
  }

  if (!user) return null;

  const handleLogout = async () => {
    await logout.mutateAsync().catch(() => {});
    navigate('/login', { replace: true });
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/5 text-sm text-ink-secondary hover:text-ink"
        aria-label="User menu"
      >
        <span
          aria-hidden="true"
          className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-accent-strong to-accent text-[11px] font-semibold text-white shadow-glow-soft"
        >
          {user.displayName.charAt(0).toLowerCase()}
        </span>
        {user.displayName}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          sideOffset={6}
          className={menuContentClasses}
        >
          {/* Settings link — POL-03 §14.3, positioned above Log out */}
          <DropdownMenu.Item asChild>
            <Link
              to="/settings"
              className={`block ${menuItemClasses}`}
            >
              Settings
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className={menuSeparatorClasses} />
          <DropdownMenu.Item
            onSelect={handleLogout}
            className={menuItemClasses}
          >
            Log out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

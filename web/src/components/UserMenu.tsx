import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useAuthStore } from '../store/auth';
import { useLogout } from '../hooks/useAuth';
import { useNavigate, Link } from 'react-router-dom';

export function UserMenu() {
  const user = useAuthStore((s) => s.user);
  const logout = useLogout();
  const navigate = useNavigate();

  if (!user) return null;

  const handleLogout = async () => {
    await logout.mutateAsync().catch(() => {});
    navigate('/login', { replace: true });
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className="px-3 py-1.5 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800 text-sm"
        aria-label="User menu"
      >
        {user.displayName}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          sideOffset={6}
          className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md shadow-md p-1 min-w-[160px]"
        >
          {/* Settings link — POL-03 §14.3, positioned above Log out */}
          <DropdownMenu.Item asChild>
            <Link
              to="/settings"
              className="block px-3 py-1.5 text-sm rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer outline-none"
            >
              Settings
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-neutral-200 dark:bg-neutral-800" />
          <DropdownMenu.Item
            onSelect={handleLogout}
            className="px-3 py-1.5 text-sm rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer outline-none"
          >
            Log out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

import { useSearchParams } from 'react-router-dom';

/**
 * Phase 26 — URL-state tab bar for the UniverseSettings tabbed layout.
 *
 * URL is the source of truth: `?tab=<id>` selects the active tab. Reads from
 * `useSearchParams()` and writes back on click (preserving any other query
 * params already in the URL). This keeps deep-links and browser back/forward
 * navigation working out of the box (D-09 audit-history empty-state nudge
 * deep-links to `?tab=audit-history`).
 *
 * Per 26-UI-SPEC tabs decision: NOT @radix-ui/react-tabs — a button group +
 * useSearchParams is simpler, smaller, and gives us URL state for free.
 *
 * Accessibility: roles `tablist` / `tab` + `aria-selected` are present. No
 * arrow-key roving focus — Tab key cycles through tabs (UI-SPEC §Accessibility
 * accepted limitation; revisit if user testing flags it).
 */

export interface SettingsTab {
  id: string;
  label: string;
}

export interface SettingsTabBarProps {
  tabs: SettingsTab[];
  /** Active tab when `?tab=` is absent from the URL. */
  defaultTab: string;
}

export function SettingsTabBar({ tabs, defaultTab }: SettingsTabBarProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeId = searchParams.get('tab') ?? defaultTab;

  return (
    <nav
      role="tablist"
      className="flex gap-1 border-b border-neutral-200 dark:border-neutral-800 mb-6"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        // Active vs inactive styling per 26-UI-SPEC §Component Inventory
        // SettingsTabBar. `-mb-px` makes the active tab's bottom border sit
        // on top of the tablist's bottom border (visual seam).
        const className = active
          ? 'text-sm px-3 py-2 border-b-2 border-[color:var(--color-accent)] text-neutral-900 dark:text-neutral-100 -mb-px'
          : 'text-sm px-3 py-2 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100';
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`panel-${tab.id}`}
            aria-current={active ? 'page' : undefined}
            className={className}
            onClick={() => {
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.set('tab', tab.id);
                return next;
              });
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}

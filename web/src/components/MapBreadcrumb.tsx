import { useNavigate } from 'react-router-dom';

export interface MapBreadcrumbProps {
  originMapId: string;
  originMapName: string;
  shareToken?: string | null;
  universeId?: string;
}

/**
 *
 * Placement: absolute left-4 top-4 z-20 — the parent must shift MapToolbar to
 * top-16 while this is visible (UI-SPEC §3: toolbar default is left-4 top-4).
 *
 * Chrome: same glassy chip as MapToolbar — backdrop-blur-sm rounded-md border
 * bg-white/90 dark:bg-neutral-900/90 shadow-sm px-3 py-1.5.
 *
 * Navigation is share-token-aware (copied verbatim from MapList.tsx:48-54):
 *   - Share mode:  /share/:token/maps/:originMapId
 *   - Auth mode:   /universes/:uid/maps/:originMapId
 *
 * Single-level only — browser/router back handles deeper chains;
 * cycles are harmless (D-03).
 *
 * Rendering decision: the parent decides whether to render this component
 * (only when router nav state carries `from`). This component does not read
 * router state itself — props are the source of truth.
 *
 * Accessibility: aria-label="Back to {originMapName}"; focus-visible accent ring.
 */
export function MapBreadcrumb({
  originMapId,
  originMapName,
  shareToken,
  universeId,
}: MapBreadcrumbProps) {
  const navigate = useNavigate();

  // Share-token-aware navigation — copied verbatim from MapList.tsx:48-54.
  const navigateToMap = (mapId: string) => {
    if (shareToken) {
      navigate(`/share/${shareToken}/maps/${mapId}`);
    } else {
      navigate(`/universes/${universeId}/maps/${mapId}`);
    }
  };

  return (
    <button
      type="button"
      onClick={() => navigateToMap(originMapId)}
      aria-label={`Back to ${originMapName}`}
      title={originMapName}
      className={[
        'absolute left-4 top-4 z-20',
        'rounded-md border border-neutral-200 dark:border-neutral-800',
        'bg-white/90 dark:bg-neutral-900/90 backdrop-blur-sm shadow-sm',
        'px-3 py-1.5',
        'flex items-center gap-1.5',
        'text-sm text-[color:var(--color-accent)] hover:underline',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2',
      ].join(' ')}
    >
      {/* Left-arrow character — no icon package (T-40-10) */}
      <span aria-hidden>&#8592;</span>
      <span>Back to </span>
      <span className="truncate max-w-[160px]" title={originMapName}>
        {originMapName}
      </span>
    </button>
  );
}

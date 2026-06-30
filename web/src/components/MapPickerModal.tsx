import { useState } from 'react';
import { useMaps } from '../hooks/useMaps';

// ─── Locked copy strings (UI-SPEC §2 Map-picker panel + Copywriting Contract) ─
const COPY = {
  title: 'Link to map',
  searchPlaceholder: 'Search maps…',
  emptySearch: (query: string) => `No maps match “${query}”.`,
  emptyHeading: 'No other maps to link',
  emptyBody:
    'This universe has only this map. Create another map, then link to it from here.',
  linkedBadge: 'Linked',
  linkButton: 'Link',
  unlinkButton: 'Unlink',
  close: 'Close map picker',
} as const;

// Inline SVG map glyph — two offset rounded rects (stacked-maps motif, UI-SPEC §4).
// No icon package (T-40-10); no emoji in source files.
function MapGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="-8 -8 16 16"
      aria-hidden
      focusable="false"
      className="shrink-0"
    >
      {/* Back square */}
      <rect
        x="-1"
        y="-4"
        width="7"
        height="7"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
        opacity="0.5"
      />
      {/* Front square */}
      <rect
        x="-5"
        y="-1"
        width="7"
        height="7"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
      />
    </svg>
  );
}

export interface MapPickerModalProps {
  /** Whether the panel is visible. */
  open: boolean;
  /** Called when the user dismisses the panel (× button or Esc). */
  onClose: () => void;
  /** Called when the user selects a map to link. Closes immediately. */
  onSelect: (mapId: string) => void;
  /** Called when the user clicks Unlink. */
  onUnlink: () => void;
  /** The current map's id — excluded from the list. */
  currentMapId: string;
  /** The currently linked target map id (undefined / null = no link set). */
  currentTargetMapId?: string | null;
  /** Universe id — passed to useMaps. */
  universeId: string;
}

/**
 * Right-side slide-in panel (w-72, absolute right-0 top-0 h-full) for linking
 * a map target to a pin or region. Modeled on AddEntriesPicker verbatim —
 * swaps entries → maps, drops ConfirmDialog (unlink is non-destructive, UI-SPEC Color note).
 *
 * Animation: translate-x-full → translate-x-0 (180ms --motion-ease-out).
 * Respects prefers-reduced-motion (handled globally in styles.css).
 * Accessibility: role="region" aria-label="Link to map", search aria-label="Search maps",
 * close aria-label="Close map picker"; Esc closes.
 */
export function MapPickerModal({
  open,
  onClose,
  onSelect,
  onUnlink,
  currentMapId,
  currentTargetMapId,
  universeId,
}: MapPickerModalProps) {
  const [query, setQuery] = useState('');
  const { data: allMaps = [] } = useMaps(universeId);

  // Exclude the current map — a map can't target itself.
  const otherMaps = allMaps.filter((m) => m.id !== currentMapId);

  const filtered = query.trim()
    ? otherMaps.filter((m) =>
        m.name.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : otherMaps;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  return (
    <div
      role="region"
      aria-label="Link to map"
      onKeyDown={handleKeyDown}
      className={[
        'absolute right-0 top-0 h-full w-72 z-20',
        'bg-white dark:bg-neutral-900',
        'border-l border-neutral-200 dark:border-neutral-800',
        'flex flex-col',
        'transition-transform duration-[180ms]',
        open ? 'translate-x-0' : 'translate-x-full',
      ].join(' ')}
      style={{ willChange: 'transform' }}
    >
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 shrink-0">
        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
          {COPY.title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={COPY.close}
          className="rounded-md px-1.5 text-lg leading-none text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
        >
          &times;
        </button>
      </div>

      {/* Search input */}
      <div className="px-4 py-2 shrink-0">
        <input
          type="text"
          aria-label="Search maps"
          placeholder={COPY.searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
        />
      </div>

      {/* Map list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {otherMaps.length === 0 ? (
          /* Empty state — no other maps exist at all */
          <div className="flex flex-col items-center text-center px-4 py-6 gap-2">
            <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
              {COPY.emptyHeading}
            </p>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {COPY.emptyBody}
            </p>
          </div>
        ) : filtered.length === 0 && query.trim() ? (
          /* Empty search state */
          <p className="px-2 py-3 text-xs text-neutral-500 dark:text-neutral-400">
            {COPY.emptySearch(query.trim())}
          </p>
        ) : (
          <ul>
            {filtered.map((map) => {
              const isLinked = map.id === currentTargetMapId;
              return (
                <li
                  key={map.id}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
                >
                  {/* Thumbnail — null-guarded (no <img src="">, known MapList warning) */}
                  {map.thumbUrl ? (
                    <img
                      src={map.thumbUrl}
                      alt=""
                      aria-hidden
                      className="w-10 h-10 rounded object-cover shrink-0"
                    />
                  ) : (
                    <div
                      className="w-10 h-10 rounded shrink-0 flex items-center justify-center bg-neutral-100 dark:bg-neutral-800 text-neutral-400 dark:text-neutral-500"
                      aria-hidden
                    >
                      <MapGlyph />
                    </div>
                  )}

                  {/* Map name */}
                  <span
                    className="text-sm text-neutral-900 dark:text-neutral-100 truncate flex-1"
                    title={map.name}
                  >
                    {map.name}
                  </span>

                  {/* Per-row action */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {isLinked ? (
                      <>
                        <span className="text-xs font-medium text-[color:var(--color-accent)]">
                          {COPY.linkedBadge}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            onUnlink();
                            onClose();
                          }}
                          className="text-xs rounded-md border border-neutral-300 dark:border-neutral-700 px-2 py-0.5 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
                        >
                          {COPY.unlinkButton}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          onSelect(map.id);
                          onClose();
                        }}
                        className="text-xs rounded-md border border-neutral-300 dark:border-neutral-700 px-2 py-0.5 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
                      >
                        {COPY.linkButton}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

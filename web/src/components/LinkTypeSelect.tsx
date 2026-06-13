import { useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useLinkTypes } from '../hooks/useLinks';
import { getLinkTypeColor, PRESET_LINK_TYPES } from '../lib/linkTypeColor';

interface Props {
  universeId: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /**
   * Called when a preset type is selected. The preset's known direction is
   * passed so the parent can auto-set the direction toggle (UI-SPEC Surface 1).
   */
  onDirectionChange?: (direction: 'directed' | 'undirected') => void;
}

/**
 * Combobox for selecting a link type (preset or custom).
 *
 * Mirrors RelationCombobox pattern: Radix Popover + text input + filtered
 * suggestion list + free-entry support.
 *
 * Data source: PRESET_LINK_TYPES (always shown first) merged with previously-
 * used custom types from GET /universes/:uid/link-types. Each row shows a
 * color swatch using getLinkTypeColor.
 *
 * When a preset is selected, onDirectionChange fires with the preset's
 * canonical direction (e.g. parent_of → directed). For custom types the
 * caller's direction state is unchanged.
 */
export function LinkTypeSelect({
  universeId,
  value,
  onChange,
  placeholder = 'Search or enter a type...',
  onDirectionChange,
}: Props) {
  const { data } = useLinkTypes(universeId);
  // Defensive: useLinkTypes resolves to LinkTypeCount[] in production, but guard
  // against undefined (loading) and any non-array shape so a transient/odd
  // response can never crash the combobox with `.filter is not a function`.
  const usedTypes = Array.isArray(data) ? data : [];
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Build merged suggestion list: presets first, then in-use custom types
  // (exclude types already covered by presets)
  const presetKeys = Object.keys(PRESET_LINK_TYPES);
  const customTypes = usedTypes
    .filter((t) => !presetKeys.includes(t.linkType))
    .map((t) => ({ type: t.linkType, count: t.count }));

  const allSuggestions = [
    ...presetKeys.map((k) => ({ type: k, count: undefined as number | undefined })),
    ...customTypes,
  ];

  const lowered = value.trim().toLowerCase();
  const filtered = lowered
    ? allSuggestions.filter((s) => s.type.toLowerCase().includes(lowered)).slice(0, 8)
    : allSuggestions.slice(0, 8);

  const handleSelect = (type: string) => {
    onChange(type);
    setOpen(false);
    // Auto-set direction when a preset is selected
    if (PRESET_LINK_TYPES[type] && onDirectionChange) {
      onDirectionChange(PRESET_LINK_TYPES[type].direction);
    }
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              setOpen(false);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={open}
          aria-controls="link-type-suggestions"
          aria-autocomplete="list"
          className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-1 text-sm outline-none focus:border-[color:var(--color-accent)]"
        />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          id="link-type-suggestions"
          className="w-[var(--radix-popover-trigger-width)] max-h-48 overflow-y-auto bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md shadow-lg z-50 data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out"
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-sm text-neutral-500">
              No matches — Enter to use this type
            </p>
          ) : (
            <ul role="listbox">
              {filtered.map((s) => (
                <li key={s.type}>
                  <button
                    type="button"
                    onClick={() => handleSelect(s.type)}
                    className="w-full flex items-center justify-between px-3 py-1 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        style={{ backgroundColor: getLinkTypeColor(s.type, {}) }}
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        aria-hidden="true"
                      />
                      {s.type}
                    </span>
                    {s.count !== undefined && (
                      <span className="text-xs text-neutral-500 tabular-nums">{s.count}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

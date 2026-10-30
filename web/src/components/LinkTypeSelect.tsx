import { useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useLinkTypes } from '../hooks/useLinks';
import { getLinkTypeColor, PRESET_LINK_TYPES } from '../lib/linkTypeColor';

interface Props {
  universeId: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  onDirectionChange?: (direction: 'directed' | 'undirected') => void;
}

export function LinkTypeSelect({
  universeId,
  value,
  onChange,
  placeholder = 'Search or enter a type...',
  onDirectionChange,
}: Props) {
  const { data } = useLinkTypes(universeId);
  // against undefined (loading) and any non-array shape so a transient/odd
  const usedTypes = Array.isArray(data) ? data : [];
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Build merged suggestion list: presets first, then in-use custom types
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
          className="w-full rounded-md border border-line-strong bg-transparent px-3 py-1 text-sm outline-none focus:border-[color:var(--color-accent)]"
        />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          id="link-type-suggestions"
          className="w-[var(--radix-popover-trigger-width)] max-h-48 overflow-y-auto bg-panel border border-line rounded-md shadow-lg z-50 data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out"
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-sm text-ink-muted">
              No matches — Enter to use this type
            </p>
          ) : (
            <ul role="listbox">
              {filtered.map((s) => (
                <li key={s.type}>
                  <button
                    type="button"
                    onClick={() => handleSelect(s.type)}
                    className="w-full flex items-center justify-between px-3 py-1 text-left text-sm hover:bg-white/5"
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
                      <span className="text-xs text-ink-muted tabular-nums">{s.count}</span>
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

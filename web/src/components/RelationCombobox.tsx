import { useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useRelations } from '../hooks/useLinks';

interface Props {
  universeId: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}

/**
 * Standalone relation-label combobox. Custom Radix Popover (~80 LOC; cmdk
 * intentionally NOT installed per research §7).
 *
 * Behavior:
 *  - Shows up to 8 suggestions filtered by case-insensitive substring of `value`
 *  - Each row renders the label and a small dim usage count
 *  - Clicking a suggestion calls onChange with that label and closes the popover
 *  - Pressing Enter on a typed value (with or without a match) closes the
 *    popover and keeps the typed string — preserves free-entry semantics
 *  - Empty filtered list shows a hint that pressing Enter will use the typed
 *    label as-is
 */
export function RelationCombobox({ universeId, value, onChange, placeholder }: Props) {
  const { data: relations = [] } = useRelations(universeId);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const lowered = value.trim().toLowerCase();
  const filtered = lowered
    ? relations.filter((r) => r.label.toLowerCase().includes(lowered)).slice(0, 8)
    : relations.slice(0, 8);

  const handleSelect = (label: string) => {
    onChange(label);
    setOpen(false);
    // refocus input so the user can keep typing or hit Submit
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
          aria-controls="relation-suggestions"
          aria-autocomplete="list"
          className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
        />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          id="relation-suggestions"
          className="w-[var(--radix-popover-trigger-width)] max-h-48 overflow-y-auto bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md shadow-lg z-50"
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-sm text-neutral-500">
              No matches — Enter to use this label
            </p>
          ) : (
            <ul role="listbox">
              {filtered.map((r) => (
                <li key={r.label}>
                  <button
                    type="button"
                    onClick={() => handleSelect(r.label)}
                    className="w-full flex items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  >
                    <span>{r.label}</span>
                    <span className="text-xs text-neutral-500 tabular-nums">{r.count}</span>
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

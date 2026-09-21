import { useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useIssues } from '../hooks/useIssues';

interface Props {
  universeId: string;
  value: string;
  onChange: (v: string) => void;
  onSelect: (issue: { id: string; title: string }) => void;
}

export function HumanIssueTypeahead({ universeId, value, onChange, onSelect }: Props) {
  const { data: issues, isLoading } = useIssues(universeId, { source: 'human' });
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const lowered = value.trim().toLowerCase();
  const filtered = (issues ?? [])
    .filter((i) => i.title.toLowerCase().includes(lowered))
    .slice(0, 8);

  const handleSelect = (issue: { id: string; title: string }) => {
    setOpen(false);
    onSelect({ id: issue.id, title: issue.title });
    onChange(issue.title);
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
          placeholder="Search issues by title…"
          role="combobox"
          aria-expanded={open}
          aria-controls="human-issue-suggestions"
          aria-autocomplete="list"
          className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
        />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          id="human-issue-suggestions"
          className="w-[var(--radix-popover-trigger-width)] max-h-48 overflow-y-auto bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md shadow-lg z-50 data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out"
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {isLoading ? (
            <p className="px-3 py-2 text-sm text-neutral-500">Loading issues…</p>
          ) : filtered.length === 0 ? (
            <p className="px-3 py-2 text-sm text-neutral-500">No matches</p>
          ) : (
            <ul role="listbox">
              {filtered.map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    onClick={() => handleSelect({ id: i.id, title: i.title })}
                    className="w-full flex items-center px-3 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  >
                    {i.title}
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

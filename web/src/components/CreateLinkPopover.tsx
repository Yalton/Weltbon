import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { RelationCombobox } from './RelationCombobox';
import { LinkTypeSelect } from './LinkTypeSelect';
import { useCreateLink } from '../hooks/useLinks';
import type { GraphNode } from '../hooks/useGraphData';

export interface CreateLinkPopoverProps {
  universeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  from: GraphNode;
  to: GraphNode;
  dropX: number;
  dropY: number;
  existingLabelHint?: string;
  onError?: (err: unknown) => void;
}

export function CreateLinkPopover({
  universeId,
  open,
  onOpenChange,
  from,
  to,
  dropX,
  dropY,
  existingLabelHint,
  onError,
}: CreateLinkPopoverProps) {
  const [label, setLabel] = useState<string>(existingLabelHint ?? '');
  const [linkType, setLinkType] = useState<string>('');
  const [direction, setDirection] = useState<'directed' | 'undirected'>('directed');
  const [error, setError] = useState<unknown>(null);
  const createLink = useCreateLink(universeId);
  const pending = createLink.isPending;

  const handleCreate = async () => {
    try {
      setError(null);
      await createLink.mutateAsync({
        sourceEntryId: from.id,
        targetEntryId: to.id,
        label: label.trim() || null,
        linkType: linkType || null,
        direction,
      });
      onOpenChange(false);
    } catch (err) {
      setError(err);
      onError?.(err);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Anchor asChild>
        <div
          style={{
            position: 'absolute',
            left: dropX,
            top: dropY,
            width: 1,
            height: 1,
            pointerEvents: 'none',
          }}
          aria-hidden="true"
        />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="center"
          sideOffset={12}
          collisionPadding={8}
          // Prevent FocusScope from auto-focusing the LinkTypeSelect
          // user's first Esc (Rule 2: UX correctness — UI-SPEC §E expects
          onOpenAutoFocus={(e) => e.preventDefault()}
          // Explicit Esc + outside-click hooks (UI-SPEC §E lifecycle).
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            onOpenChange(false);
          }}
          onPointerDownOutside={() => onOpenChange(false)}
          className="w-[300px] bg-panel border border-line rounded-md shadow-lg z-50 p-4 data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out"
        >
          <h3 className="text-sm font-semibold mb-3">Create link</h3>

          <div className="flex items-baseline gap-2">
            <span className="text-xs text-ink-secondary w-10 shrink-0">
              From
            </span>
            <span
              className="text-sm font-medium text-ink truncate"
              title={from.title}
            >
              {from.title}
            </span>
          </div>
          <div className="flex items-baseline gap-2 mb-3">
            <span className="text-xs text-ink-secondary w-10 shrink-0">
              To
            </span>
            <span
              className="text-sm font-medium text-ink truncate"
              title={to.title}
            >
              {to.title}
            </span>
          </div>

          {/* Link type (above display label) */}
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-ink-secondary mb-1">Type</label>
              <LinkTypeSelect
                universeId={universeId}
                value={linkType}
                onChange={setLinkType}
                onDirectionChange={setDirection}
                placeholder="Search or enter a type..."
              />
            </div>

            {/* Direction toggle pill group (UI-SPEC Surface 2) */}
            <div>
              <label className="block text-sm text-ink-secondary mb-1">Direction</label>
              <div className="flex gap-1 mt-1" role="group" aria-label="Direction">
                <button
                  type="button"
                  aria-pressed={direction === 'directed'}
                  onClick={() => setDirection('directed')}
                  className={`rounded-md border px-3 py-1 text-sm cursor-pointer ${
                    direction === 'directed'
                      ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]'
                      : ' border-line-strong text-ink-secondary'
                  }`}
                >
                  A &rarr; B
                </button>
                <button
                  type="button"
                  aria-pressed={direction === 'undirected'}
                  onClick={() => setDirection('undirected')}
                  className={`rounded-md border px-3 py-1 text-sm cursor-pointer ${
                    direction === 'undirected'
                      ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]'
                      : ' border-line-strong text-ink-secondary'
                  }`}
                >
                  A &harr; B
                </button>
              </div>
            </div>

            {/* Display label (optional — demoted from primary position) */}
            <div>
              <label className="block text-sm text-ink-secondary mb-1">
                Display label (optional)
              </label>
              <RelationCombobox
                universeId={universeId}
                value={label}
                onChange={setLabel}
                placeholder="e.g. sworn shield since the Sundering"
              />
            </div>
          </div>

          {error != null && (
            <p className="mt-2 text-xs text-red-500">
              Couldn't create link. Try again.
            </p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="Discard link"
              className="rounded-md border border-line-strong px-3 py-1.5 text-sm"
            >
              &times;
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={pending}
              className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {pending ? 'Creating...' : 'Create link'}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

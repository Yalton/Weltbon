import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { RelationCombobox } from './RelationCombobox';
import { useCreateLink } from '../hooks/useLinks';
import type { GraphNode } from '../hooks/useGraphData';

export interface CreateLinkPopoverProps {
  universeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  from: GraphNode;
  to: GraphNode;
  /** Container-relative drop coordinates (UI-SPEC §E). */
  dropX: number;
  dropY: number;
  /**
   * Existing A→B label, if any. Hydrates the label input as an editable
   * default value (CONTEXT.md D-03d — hint AS default value, not as a
   * separate badge / chip).
   */
  existingLabelHint?: string;
  /**
   * Error callback fired alongside the inline error message so the parent
   * (GraphView, Plan 19-04) can surface a Toast. The popover stays open
   * on error (UI-SPEC §H belt-and-suspenders).
   */
  onError?: (err: unknown) => void;
}

/**
 * Radix Popover anchored at arbitrary drop coordinates via an invisible 1×1
 * Popover.Anchor div (UI-SPEC §E + 19-RESEARCH §"Pattern 2"). Hosts a
 * `RelationCombobox` reused as-is for the label input. Submission calls
 * `useCreateLink.mutateAsync` and closes on success; failure renders an
 * inline error AND fires the `onError` callback (parent surfaces Toast).
 *
 * Locked copywriting (UI-SPEC §"Copywriting Contract"):
 *  - Title: "Create link"
 *  - From/To row captions: "From" / "To"
 *  - Input placeholder: "Relation label (optional)"
 *  - Buttons: "Cancel" / "Create link"
 *  - Pending button label: "Creating..." (ASCII three dots — grep parity with UniverseList.tsx)
 *  - Inline error: "Couldn't create link. Try again." (ASCII apostrophe)
 *
 * Wiring to GraphView happens in Plan 19-04. This component does NOT depend
 * on any global toast provider; error surfacing is via the `onError` prop
 * that the parent bridges to its own per-view Toast state.
 */
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
  const [error, setError] = useState<unknown>(null);
  const createLink = useCreateLink(universeId);
  const pending = createLink.isPending;

  const handleCreate = async () => {
    try {
      setError(null);
      await createLink.mutateAsync({
        sourceEntryId: from.id,
        targetEntryId: to.id,
        label: label.trim(),
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
          // Prevent FocusScope from auto-focusing the RelationCombobox
          // input on open — its `onFocus={() => setOpen(true)}` would
          // immediately open the inner suggestions popover, capturing the
          // user's first Esc (Rule 2: UX correctness — UI-SPEC §E expects
          // Esc to close the outer popover in one keypress).
          onOpenAutoFocus={(e) => e.preventDefault()}
          // Explicit Esc + outside-click hooks (UI-SPEC §E lifecycle).
          onEscapeKeyDown={(e) => {
            e.preventDefault();
            onOpenChange(false);
          }}
          onPointerDownOutside={() => onOpenChange(false)}
          className="w-[300px] bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md shadow-lg z-50 p-4 data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out"
        >
          <h3 className="text-sm font-semibold mb-3">Create link</h3>

          <div className="flex items-baseline gap-2">
            <span className="text-xs text-neutral-500 dark:text-neutral-400 w-10 shrink-0">
              From
            </span>
            <span
              className="text-sm font-medium text-neutral-900 dark:text-neutral-100 truncate"
              title={from.title}
            >
              {from.title}
            </span>
          </div>
          <div className="flex items-baseline gap-2 mb-3">
            <span className="text-xs text-neutral-500 dark:text-neutral-400 w-10 shrink-0">
              To
            </span>
            <span
              className="text-sm font-medium text-neutral-900 dark:text-neutral-100 truncate"
              title={to.title}
            >
              {to.title}
            </span>
          </div>

          <RelationCombobox
            universeId={universeId}
            value={label}
            onChange={setLabel}
            placeholder="Relation label (optional)"
          />

          {error != null && (
            <p className="mt-2 text-xs text-red-500">
              Couldn't create link. Try again.
            </p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm"
            >
              Cancel
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

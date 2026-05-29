/**
 * Templates view — /settings/templates (Phase 28-07)
 *
 * Two sections: "Default templates" (in-tree defaults, read-only) and
 * "Your templates" (user DB rows with kebab Rename/Delete per row).
 *
 * Per UI-SPEC §D: no "Create template" button — creation flows exclusively
 * from EntryEditor's kebab (Save as template…).
 *
 * Analog: web/src/views/Tokens.tsx (page header, skeleton, table, ConfirmDialog wiring).
 */

import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  useTemplates,
  useRenameTemplate,
  useDeleteTemplate,
  type UserTemplate,
} from '../hooks/useTemplates';
import { TEMPLATES } from '../lib/entryTemplates';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { Toast } from '../components/Toast';
import { formatRelative } from '../utils/formatRelative';
import { ApiError } from '../api/client';

/** Renders a horizontal chip list of the first 4 meta field names + "+N more" chip. */
function MetaChips({ meta }: { meta: Array<{ name: string; default_value: string }> }) {
  const shown = meta.slice(0, 4);
  const overflow = meta.length - 4;
  return (
    <td className="py-3 pr-4">
      <div className="flex flex-wrap gap-1">
        {shown.map((f) => (
          <span
            key={f.name}
            className="bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 text-xs font-mono px-1.5 py-0.5 rounded-sm"
          >
            {f.name}
          </span>
        ))}
        {overflow > 0 && (
          <span className="bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 text-xs font-mono px-1.5 py-0.5 rounded-sm">
            +{overflow} more
          </span>
        )}
      </div>
    </td>
  );
}

export default function Templates() {
  const { data: userTemplates, isPending } = useTemplates();
  const renameMutation = useRenameTemplate();
  const deleteMutation = useDeleteTemplate();

  const [deleteTarget, setDeleteTarget] = useState<UserTemplate | null>(null);
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; variant: 'success' | 'error' } | null>(
    null,
  );

  const cancelRename = () => {
    setRenameTargetId(null);
    setRenameDraft('');
    setRenameError(null);
  };

  const submitRename = async () => {
    const trimmed = renameDraft.trim();
    if (!trimmed) {
      setRenameError('Name is required.');
      return;
    }
    try {
      await renameMutation.mutateAsync({ id: renameTargetId!, name: trimmed });
      setRenameTargetId(null);
      setRenameDraft('');
      setRenameError(null);
      setToast({ message: 'Template renamed.', variant: 'success' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Show the server's message verbatim (UI-SPEC §D deliberate simplification —
        // the server message is already user-facing; no client-side string surgery).
        setRenameError(err.message);
      } else {
        setToast({ message: "Couldn't rename the template. Try again.", variant: 'error' });
        setRenameTargetId(null);
        setRenameDraft('');
        setRenameError(null);
      }
    }
  };

  /** Shared table column headers for both Default and Your templates tables. */
  const TableHead = ({ caption }: { caption: string }) => (
    <thead>
      <tr className="border-b border-neutral-200 dark:border-neutral-800">
        <th
          scope="col"
          className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-32"
        >
          Type
        </th>
        <th
          scope="col"
          className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-auto"
        >
          Name
        </th>
        <th
          scope="col"
          className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-auto"
        >
          Fields
        </th>
        <th
          scope="col"
          className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-32"
        >
          Last used
        </th>
        <th
          scope="col"
          className="pb-2 text-right text-xs uppercase tracking-wide font-medium text-neutral-500 w-20"
        >
          {/* action column — no header text */}
        </th>
      </tr>
      {/* sr-only caption is in the <table> element via <caption> */}
      <caption className="sr-only">{caption}</caption>
    </thead>
  );

  return (
    <div className="max-w-3xl">
      {/* Page header — NO "New template" button per UI-SPEC §D */}
      <h1 className="text-2xl font-semibold tracking-tight">Entry templates</h1>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400 leading-[1.5]">
        {'Templates scaffold new entries with a pre-defined structure. Defaults ship with Weltbon and can be cloned. Your saved templates travel across all your universes.'}
      </p>

      {/* ── Section A: Default templates (always rendered, in-tree data) ── */}
      <h3 className="text-xs uppercase tracking-wide text-neutral-500 mb-2 mt-8">
        Default templates
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Default entry templates</caption>
          <thead>
            <tr className="border-b border-neutral-200 dark:border-neutral-800">
              <th
                scope="col"
                className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-32"
              >
                Type
              </th>
              <th
                scope="col"
                className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-auto"
              >
                Name
              </th>
              <th
                scope="col"
                className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-auto"
              >
                Fields
              </th>
              <th
                scope="col"
                className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-32"
              >
                Last used
              </th>
              <th
                scope="col"
                className="pb-2 text-right text-xs uppercase tracking-wide font-medium text-neutral-500 w-20"
              >
                {/* action column — no header text */}
              </th>
            </tr>
          </thead>
          <tbody>
            {TEMPLATES.map((template) => (
              <tr
                key={template.id}
                className="border-b border-neutral-200 dark:border-neutral-800"
              >
                {/* Type */}
                <td className="py-3 pr-4 text-neutral-700 dark:text-neutral-300">
                  {template.entryType}
                </td>
                {/* Name */}
                <td className="py-3 pr-4">{template.label}</td>
                {/* Fields — meta-field chip thumbnail */}
                <MetaChips meta={template.meta} />
                {/* Last used — defaults always show "Never" (no DB row to stamp) */}
                <td className="py-3 pr-4">
                  <span className="italic text-neutral-500">Never</span>
                </td>
                {/* Action — empty; defaults have NO kebab per UI-SPEC §D */}
                <td className="py-3 text-right" />
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Section B: Your templates ── */}
      <h3 className="text-xs uppercase tracking-wide text-neutral-500 mb-2 mt-8">
        Your templates
      </h3>

      {/* Loading skeleton — 3 rows while userTemplates query is pending */}
      {isPending && (
        <div className="mt-2 space-y-2" aria-busy="true" aria-label="Loading templates">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-12 rounded-md bg-neutral-100 dark:bg-neutral-800 animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Empty state — no personal templates yet */}
      {!isPending && userTemplates && userTemplates.length === 0 && (
        <EmptyState
          title="No saved templates yet"
          body="Save a template from any entry editor (kebab menu → Save as template…) to see it here."
        />
      )}

      {/* Populated personal templates table */}
      {!isPending && userTemplates && userTemplates.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Your entry templates</caption>
            <thead>
              <tr className="border-b border-neutral-200 dark:border-neutral-800">
                <th
                  scope="col"
                  className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-32"
                >
                  Type
                </th>
                <th
                  scope="col"
                  className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-auto"
                >
                  Name
                </th>
                <th
                  scope="col"
                  className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-auto"
                >
                  Fields
                </th>
                <th
                  scope="col"
                  className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-32"
                >
                  Last used
                </th>
                <th
                  scope="col"
                  className="pb-2 text-right text-xs uppercase tracking-wide font-medium text-neutral-500 w-20"
                >
                  {/* action column — no header text */}
                </th>
              </tr>
            </thead>
            <tbody>
              {userTemplates.map((t) => (
                <tr
                  key={t.id}
                  className="border-b border-neutral-200 dark:border-neutral-800"
                >
                  {/* Type */}
                  <td className="py-3 pr-4 text-neutral-700 dark:text-neutral-300">
                    {t.entryType}
                  </td>

                  {/* Name — inline-edit mode when renaming */}
                  {renameTargetId === t.id ? (
                    <td className="py-3 pr-4">
                      <input
                        type="text"
                        value={renameDraft}
                        autoFocus
                        onChange={(e) => {
                          setRenameDraft(e.target.value);
                          setRenameError(null);
                        }}
                        onBlur={cancelRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void submitRename();
                          } else if (e.key === 'Escape') {
                            cancelRename();
                          }
                        }}
                        className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-sm w-full focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]"
                      />
                      {renameError && (
                        <p className="mt-1 text-sm text-red-500" role="alert">
                          {renameError}
                        </p>
                      )}
                    </td>
                  ) : (
                    <td className="py-3 pr-4">{t.name}</td>
                  )}

                  {/* Fields — meta-field chip thumbnail */}
                  <MetaChips meta={t.meta} />

                  {/* Last used */}
                  <td className="py-3 pr-4">
                    {t.lastUsedAt ? (
                      <time
                        dateTime={t.lastUsedAt}
                        title={new Date(t.lastUsedAt).toLocaleString()}
                      >
                        {formatRelative(t.lastUsedAt)}
                      </time>
                    ) : (
                      <span className="italic text-neutral-500">Never</span>
                    )}
                  </td>

                  {/* Action — per-row kebab (personal rows only) */}
                  <td className="py-3 text-right">
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button
                          type="button"
                          aria-label={`Actions for ${t.name}`}
                          className="inline-flex items-center justify-center h-8 w-8 rounded-md text-neutral-500 dark:text-neutral-400 bg-transparent hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-neutral-900 data-[state=open]:bg-neutral-100 dark:data-[state=open]:bg-neutral-800 data-[state=open]:text-neutral-900 dark:data-[state=open]:text-neutral-100"
                        >
                          <svg
                            viewBox="0 0 16 16"
                            width="16"
                            height="16"
                            fill="currentColor"
                            aria-hidden="true"
                            focusable="false"
                          >
                            <circle cx="8" cy="3" r="1.5" />
                            <circle cx="8" cy="8" r="1.5" />
                            <circle cx="8" cy="13" r="1.5" />
                          </svg>
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          align="end"
                          sideOffset={4}
                          className="min-w-[160px] rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-1 shadow-lg z-50 data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out"
                        >
                          <DropdownMenu.Item
                            onSelect={() => {
                              setRenameTargetId(t.id);
                              setRenameDraft(t.name);
                              setRenameError(null);
                            }}
                            className="px-3 py-2 text-sm rounded-sm cursor-pointer outline-none data-[highlighted]:bg-neutral-100 dark:data-[highlighted]:bg-neutral-800"
                          >
                            Rename…
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            onSelect={() => setDeleteTarget(t)}
                            className="px-3 py-2 text-sm rounded-sm cursor-pointer outline-none text-red-600 dark:text-red-400 data-[highlighted]:bg-red-50 data-[highlighted]:text-red-700 dark:data-[highlighted]:bg-red-950/40 dark:data-[highlighted]:text-red-300"
                          >
                            Delete…
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Delete confirmation dialog — ConfirmDialog with destructive=true */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        title="Delete template"
        body={
          deleteTarget
            ? `Deleting "${deleteTarget.name}" removes it from your picker for ${deleteTarget.entryType} entries. Entries you've already created from this template are unaffected. This can't be undone.`
            : ''
        }
        confirmLabel="Delete template"
        destructive
        onConfirm={async () => {
          if (deleteTarget) {
            try {
              await deleteMutation.mutateAsync(deleteTarget.id);
              setToast({ message: 'Template deleted.', variant: 'success' });
            } catch {
              setToast({ message: "Couldn't delete the template. Try again.", variant: 'error' });
            }
          }
        }}
      />

      {/* Toast notifications */}
      {toast && (
        <Toast
          message={toast.message}
          variant={toast.variant}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}

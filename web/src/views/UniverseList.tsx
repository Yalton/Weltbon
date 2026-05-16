import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  useUniverses,
  useCreateUniverse,
  useDeleteUniverse,
  type Universe,
} from '../hooks/useUniverse';
import { EmptyState } from '../components/EmptyState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Toast } from '../components/Toast';

const schema = z.object({ name: z.string().min(1).max(80) });
type FormValues = z.infer<typeof schema>;

type ToastState = { message: string; variant: 'success' | 'error' } | null;

export function UniverseList() {
  const { data: universes, isLoading } = useUniverses();
  const create = useCreateUniverse();
  const del = useDeleteUniverse();
  const navigate = useNavigate();
  const [showForm, setShowForm] = useState(false);
  const [target, setTarget] = useState<Universe | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
  });

  const onSubmit = handleSubmit(async (values) => {
    await create.mutateAsync(values);
    reset();
    setShowForm(false);
  });

  const handleDelete = async () => {
    if (!target) return;
    try {
      await del.mutateAsync(target.id);
      setToast({ message: 'Universe deleted.', variant: 'success' });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[UniverseList] delete failed:', err);
      setToast({ message: "Couldn't delete universe. Try again.", variant: 'error' });
    }
  };

  if (isLoading) return <p className="text-sm text-neutral-500">Loading...</p>;

  const isEmpty = !universes || universes.length === 0;

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Your universes</h1>
        {!isEmpty && (
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5"
          >
            {showForm ? 'Cancel' : 'Create universe'}
          </button>
        )}
      </div>

      {showForm && (
        <form onSubmit={onSubmit} className="mb-6 flex gap-2 items-start">
          <div className="flex-1">
            <input
              {...register('name')}
              placeholder="Universe name"
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
              autoFocus
            />
            {errors.name && <p className="mt-1 text-xs text-red-500">{errors.name.message}</p>}
          </div>
          <button
            type="submit"
            disabled={create.isPending}
            className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-2 disabled:opacity-50"
          >
            {create.isPending ? 'Creating...' : 'Create'}
          </button>
        </form>
      )}

      {isEmpty ? (
        <EmptyState
          title="Start a universe"
          body="A universe is a self-contained world — its own entries, categories, and timeline. Create one to get going."
          action={
            <button
              type="button"
              onClick={() => setShowForm(true)}
              className="bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
            >
              New universe
            </button>
          }
        />
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {universes!.map((u) => (
            <li key={u.id}>
              <div className="relative rounded-md border border-neutral-200 dark:border-neutral-800 p-4 hover:border-[color:var(--color-accent)] transition-colors">
                <Link
                  to={`/universes/${u.id}/entries`}
                  className="absolute inset-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-neutral-900"
                  aria-label={`Open ${u.name}`}
                >
                  <span className="sr-only">Open {u.name}</span>
                </Link>
                <div className="relative pointer-events-none">
                  <h2 className="font-semibold pr-10">{u.name}</h2>
                  {u.description && (
                    <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400 line-clamp-3">{u.description}</p>
                  )}
                </div>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      aria-label={`Actions for ${u.name}`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      className="absolute top-2 right-2 inline-flex items-center justify-center h-8 w-8 rounded-md text-neutral-500 dark:text-neutral-400 bg-transparent hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-neutral-900 data-[state=open]:bg-neutral-100 dark:data-[state=open]:bg-neutral-800 data-[state=open]:text-neutral-900 dark:data-[state=open]:text-neutral-100"
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
                        onSelect={() => navigate(`/universes/${u.id}/settings`)}
                        className="px-3 py-2 text-sm rounded-sm cursor-pointer outline-none data-[highlighted]:bg-neutral-100 dark:data-[highlighted]:bg-neutral-800"
                      >
                        Settings
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        onSelect={() => setTarget(u)}
                        className="px-3 py-2 text-sm rounded-sm cursor-pointer outline-none text-red-600 dark:text-red-400 data-[highlighted]:bg-red-50 data-[highlighted]:text-red-700 dark:data-[highlighted]:bg-red-950/40 dark:data-[highlighted]:text-red-300"
                      >
                        Delete…
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(o) => {
          if (!o) setTarget(null);
        }}
        title={target ? `Delete "${target.name}"?` : ''}
        body="This permanently removes the universe and everything inside it. This cannot be undone."
        confirmLabel="Delete"
        destructive
        confirmPhrase={target?.name ?? ''}
        onConfirm={handleDelete}
      />

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

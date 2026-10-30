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
import { useRuntime } from '../runtime/RuntimeProvider';
import { ThemeScope } from '../components/theme/ThemeScope';
import { EmptyState } from '../components/EmptyState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ConnectToWeltbon } from '../components/ConnectToWeltbon';
import { Toast } from '../components/Toast';
import { Panel } from '../components/ui/Panel';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/PageHeader';
import {
  menuContentClasses,
  menuItemClasses,
  menuItemDangerClasses,
} from '../components/ui/overlay';
import { Loading } from '../components/ui/Loading';

const schema = z.object({ name: z.string().min(1).max(80) });
type FormValues = z.infer<typeof schema>;

type ToastState = { message: string; variant: 'success' | 'error' } | null;

export function UniverseList() {
  const { data: universes, isLoading } = useUniverses();
  const create = useCreateUniverse();
  const del = useDeleteUniverse();
  const navigate = useNavigate();
  const { authMode } = useRuntime();
  const [showForm, setShowForm] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
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

  if (isLoading) return <Loading />;

  const isEmpty = !universes || universes.length === 0;

  const openCreateForm = () => {
    setShowConnect(false);
    setShowForm((v) => !v);
  };

  const openConnect = () => {
    setShowForm(false);
    setShowConnect((v) => !v);
  };

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader
        title="Your universes"
        subtitle={universes && universes.length > 0 ? `${universes.length} universe${universes.length === 1 ? '' : 's'}` : undefined}
        actions={
          !isEmpty && (
            <div className="flex gap-2">
              {authMode === 'local' && (
                <Button onClick={openConnect} variant="ghost">
                  {showConnect ? 'Cancel' : 'Connect to Weltbon'}
                </Button>
              )}
              <Button onClick={openCreateForm} variant={showForm ? 'ghost' : 'primary'}>
                {showForm ? 'Cancel' : 'Create universe'}
              </Button>
            </div>
          )
        }
      />

      {showForm && (
        <form onSubmit={onSubmit} className="mb-6 flex gap-2 items-start">
          <div className="flex-1">
            <Input
              {...register('name')}
              placeholder="Universe name"
              autoFocus
            />
            {errors.name && <p className="mt-1 text-xs text-rose-400">{errors.name.message}</p>}
          </div>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Creating...' : 'Create'}
          </Button>
        </form>
      )}

      {showConnect && (
        <Panel className="mb-6 p-4">
          <ConnectToWeltbon
            onDone={(universeId) => {
              setShowConnect(false);
              navigate(`/universes/${universeId}/entries`);
            }}
            onCancel={() => setShowConnect(false)}
          />
        </Panel>
      )}

      {isEmpty ? (
        <EmptyState
          title="Start a universe"
          body="A universe is a self-contained world — its own entries, categories, and timeline. Create one to get going."
          action={
            <div className="flex flex-wrap justify-center gap-3">
              <Button onClick={() => setShowForm(true)}>New universe</Button>
              {authMode === 'local' && (
                <Button onClick={() => setShowConnect(true)}>Connect to Weltbon</Button>
              )}
            </div>
          }
        />
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {universes!.map((u) => (
            <li key={u.id}>
              <Panel hover className="relative h-full">
                <ThemeScope
                  theme={u.theme ?? null}
                  backdropUrl={u.backdropThumbUrl ?? null}
                  backdropMode="contained"
                  showCanvas={false}
                  className="relative p-4 h-full rounded-[10px]"
                >
                  <Link
                    to={`/universes/${u.id}/entries`}
                    className="absolute inset-0 rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--color-canvas-mid)]"
                    aria-label={`Open ${u.name}`}
                  >
                    <span className="sr-only">Open {u.name}</span>
                  </Link>
                  <div className="relative pointer-events-none">
                    <h2 className="font-display text-lg font-semibold text-ink pr-10">{u.name}</h2>
                    {u.description && (
                      <p className="mt-1 text-sm text-ink-secondary line-clamp-3">{u.description}</p>
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
                        className="absolute top-2 right-2 inline-flex items-center justify-center h-8 w-8 rounded-md text-ink-muted hover:text-ink hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] data-[state=open]:bg-white/10 data-[state=open]:text-ink"
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
                        className={menuContentClasses}
                      >
                        <DropdownMenu.Item
                          onSelect={() => navigate(`/universes/${u.id}/settings`)}
                          className={menuItemClasses}
                        >
                          Settings
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          onSelect={() => setTarget(u)}
                          className={menuItemDangerClasses}
                        >
                          Delete…
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </ThemeScope>
              </Panel>
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

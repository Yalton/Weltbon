import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useUniverses, useCreateUniverse } from '../hooks/useUniverse';
import { EmptyState } from '../components/EmptyState';

const schema = z.object({ name: z.string().min(1).max(80) });
type FormValues = z.infer<typeof schema>;

export function UniverseList() {
  const { data: universes, isLoading } = useUniverses();
  const create = useCreateUniverse();
  const [showForm, setShowForm] = useState(false);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
  });

  const onSubmit = handleSubmit(async (values) => {
    await create.mutateAsync(values);
    reset();
    setShowForm(false);
  });

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
          title="No universes yet"
          body="A universe holds the entries, links, and categories of a world you're building. Create your first one to get started."
          action={
            <button
              type="button"
              onClick={() => setShowForm(true)}
              className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-4 py-2"
            >
              Create your first universe
            </button>
          }
        />
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {universes!.map((u) => (
            <li key={u.id}>
              <Link
                to={`/universes/${u.id}/entries`}
                className="block rounded-md border border-neutral-200 dark:border-neutral-800 p-4 hover:border-[color:var(--color-accent)] transition-colors"
              >
                <h2 className="font-semibold">{u.name}</h2>
                {u.description && (
                  <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400 line-clamp-3">{u.description}</p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

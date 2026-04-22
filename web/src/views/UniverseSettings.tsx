import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useUniverse, useUpdateUniverse, useDeleteUniverse } from '../hooks/useUniverse';
import { ConfirmDialog } from '../components/ConfirmDialog';

export function UniverseSettings() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading } = useUniverse(id);
  const update = useUpdateUniverse(id ?? '');
  const del = useDeleteUniverse();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (data) {
      setName(data.name);
      setDescription(data.description);
    }
  }, [data]);

  if (isLoading || !data) return <p className="text-sm text-neutral-500">Loading...</p>;

  const handleSave = async () => {
    const patch: { name?: string; description?: string } = {};
    if (name !== data.name) patch.name = name;
    if (description !== data.description) patch.description = description;
    if (Object.keys(patch).length === 0) return;
    await update.mutateAsync(patch);
  };

  const handleDelete = async () => {
    if (!id) return;
    await del.mutateAsync(id);
    navigate('/universes', { replace: true });
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-semibold">{data.name}</h1>
      <div>
        <label className="block text-sm mb-1" htmlFor="name">Name</label>
        <input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
        />
      </div>
      <div>
        <label className="block text-sm mb-1" htmlFor="description">Description</label>
        <textarea
          id="description"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
        />
      </div>
      <div className="flex items-center justify-between pt-4 border-t border-neutral-200 dark:border-neutral-800">
        <button
          type="button"
          onClick={handleSave}
          disabled={update.isPending}
          className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5 disabled:opacity-50"
        >
          {update.isPending ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          className="rounded-md bg-red-600 text-white text-sm px-3 py-1.5"
        >
          Delete universe
        </button>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete "${data.name}"?`}
        body="This permanently removes the universe and (in future phases) everything inside it. This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
      />
    </div>
  );
}

import { Link, useParams } from 'react-router-dom';
import { useEntries } from '../hooks/useEntries';
import { useUniverse } from '../hooks/useUniverse';
import { EntryCard } from '../components/EntryCard';
import { EmptyState } from '../components/EmptyState';

export function EntryList() {
  const { uid } = useParams<{ uid: string }>();
  const { data: entries, isLoading } = useEntries(uid!);
  const { data: universe } = useUniverse(uid);

  if (isLoading) return <p className="text-sm text-neutral-500">Loading...</p>;

  const isEmpty = !entries || entries.length === 0;

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Entries</h1>
        <div className="flex gap-2">
          {/* TODO: Wire Export JSON in Plan 06 */}
          <button
            type="button"
            disabled
            className="rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-1.5 opacity-50 cursor-not-allowed"
          >
            Export JSON
          </button>
          {/* TODO: Wire Import JSON in Plan 06 */}
          <button
            type="button"
            disabled
            className="rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-1.5 opacity-50 cursor-not-allowed"
          >
            Import JSON
          </button>
          {!isEmpty && (
            <Link
              to="new"
              className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5"
            >
              Create entry
            </Link>
          )}
        </div>
      </div>

      {isEmpty ? (
        <EmptyState
          title="No entries yet"
          body="Entries are the building blocks of your universe -- people, places, events, and ideas. Create your first entry to start building."
          action={
            <Link
              to="new"
              className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-4 py-2"
            >
              Create your first entry
            </Link>
          }
        />
      ) : (
        <div className="space-y-2">
          {entries!.map((entry) => (
            <Link key={entry.id} to={`/universes/${uid}/entries/${entry.id}`}>
              <EntryCard entry={entry} />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

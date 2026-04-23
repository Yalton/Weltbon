import { useState, useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useEntries } from '../hooks/useEntries';
import { useUniverse } from '../hooks/useUniverse';
import { EntryCard } from '../components/EntryCard';
import { EmptyState } from '../components/EmptyState';
import { ImportDialog } from '../components/ImportDialog';
import { getAccessToken } from '../api/client';

export function EntryList() {
  const { uid } = useParams<{ uid: string }>();
  const { data: entries, isLoading } = useEntries(uid!);
  const { data: universe } = useUniverse(uid);

  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Auto-dismiss toast after 4 seconds
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  if (isLoading) return <p className="text-sm text-neutral-500">Loading...</p>;

  const isEmpty = !entries || entries.length === 0;

  async function handleExport() {
    setExporting(true);
    try {
      const token = getAccessToken();
      const res = await fetch(`/api/universes/${uid}/export?format=json`, {
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${universe?.name || 'universe'}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setToast('Export failed. Try again.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Entries</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-1.5"
          >
            {exporting ? 'Exporting...' : 'Export JSON'}
          </button>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-1.5"
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

      {/* Import dialog */}
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />

      {/* Toast notification */}
      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-red-600 text-white text-sm px-4 py-2 rounded-md shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  );
}

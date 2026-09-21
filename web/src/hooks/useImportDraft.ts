import { useCallback, useState } from 'react';
import type { IngestPreview, ReviewDecisions, SavedDraft } from '../types/ingestReview';

export function useImportDraft(universeId: string) {
  const key = `weltbon.import.${universeId}`;

  const [lastError, setLastError] = useState<string | null>(null);
  const [draft, setDraft] = useState<SavedDraft | null>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as SavedDraft) : null;
    } catch {
      return null;
    }
  });

  const save = useCallback(
    (d: { preview: IngestPreview; decisions: ReviewDecisions }) => {
      const withTime: SavedDraft = { ...d, savedAt: new Date().toISOString() };
      try {
        localStorage.setItem(key, JSON.stringify(withTime));
        setDraft(withTime);
        setLastError(null);
      } catch (err) {
        // Quota exceeded is the typical case (UI-SPEC §7.3). Do NOT update
        // draft state on failure — the in-memory copy is still authoritative.
        setLastError(err instanceof Error ? err.message : 'Storage write failed');
      }
    },
    [key],
  );

  const clear = useCallback(() => {
    localStorage.removeItem(key);
    setDraft(null);
    setLastError(null);
  }, [key]);

  return { draft, save, clear, lastError };
}

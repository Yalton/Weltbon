import { useState, useEffect, useMemo, useRef } from 'react';

interface Row {
  rowId: string;
  key: string;
  val: string;
}

function newRowId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

export function MetaEditor({
  value,
  onChange,
  onValidityChange,
}: {
  value: Record<string, string>;
  onChange: (meta: Record<string, string>) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  // Initialise rows from value once. Subsequent value changes from the parent
  // (e.g. template prefill) are handled by a ref-tracked sync only when rows
  // is empty (avoids clobbering live edits).
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(value).map(([k, v]) => ({
      rowId: newRowId(),
      key: k,
      val: v,
    })),
  );
  const initRef = useRef(true);

  useEffect(() => {
    if (initRef.current) {
      initRef.current = false;
      return;
    }
    // If rows is empty and the parent supplies new entries (e.g. template
    // prefill in EntryEditor), reseed rows. Ongoing edits are not clobbered.
    if (rows.length === 0 && Object.keys(value).length > 0) {
      setRows(
        Object.entries(value).map(([k, v]) => ({
          rowId: newRowId(),
          key: k,
          val: v,
        })),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const keyCount = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of rows) {
      if (r.key) counts[r.key] = (counts[r.key] ?? 0) + 1;
    }
    return counts;
  }, [rows]);

  const hasDups = Object.values(keyCount).some((c) => c > 1);

  useEffect(() => {
    onValidityChange?.(!hasDups);
    if (!hasDups) {
      const obj: Record<string, string> = {};
      for (const r of rows) {
        if (r.key) obj[r.key] = r.val;
      }
      onChange(obj);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, hasDups]);

  const updateKey = (rowId: string, newKey: string) =>
    setRows((rs) =>
      rs.map((r) => (r.rowId === rowId ? { ...r, key: newKey } : r)),
    );
  const updateVal = (rowId: string, newVal: string) =>
    setRows((rs) =>
      rs.map((r) => (r.rowId === rowId ? { ...r, val: newVal } : r)),
    );
  const removeRow = (rowId: string) =>
    setRows((rs) => rs.filter((r) => r.rowId !== rowId));
  const addRow = () =>
    setRows((rs) => [...rs, { rowId: newRowId(), key: '', val: '' }]);

  return (
    <div className="space-y-2">
      {rows.map((r) => {
        const isDup = r.key !== '' && keyCount[r.key] > 1;
        const dupClasses = isDup ? 'ring-2 ring-red-500' : '';
        return (
          <div key={r.rowId} className="flex items-center gap-2">
            <input
              type="text"
              value={r.key}
              onChange={(e) => updateKey(r.rowId, e.target.value)}
              aria-invalid={isDup}
              title={isDup ? 'Duplicate key' : undefined}
              className={`w-2/5 rounded-md border border-neutral-200 dark:border-neutral-800 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)] ${dupClasses}`}
              placeholder="Key"
            />
            <input
              type="text"
              value={r.val}
              onChange={(e) => updateVal(r.rowId, e.target.value)}
              className="w-3/5 rounded-md border border-neutral-200 dark:border-neutral-800 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
              placeholder="Value"
            />
            <button
              type="button"
              onClick={() => removeRow(r.rowId)}
              className="shrink-0 text-neutral-500 hover:text-red-500 text-sm"
              aria-label={`Remove field${r.key ? ` ${r.key}` : ''}`}
            >
              &times;
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={addRow}
        className="text-sm text-neutral-500 hover:text-neutral-300 dark:hover:text-neutral-300"
      >
        + Add field
      </button>
      {hasDups && (
        <p className="text-xs text-red-500">
          Two or more fields share a key. Each key must be unique.
        </p>
      )}
    </div>
  );
}

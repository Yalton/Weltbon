import { useState, useEffect, useMemo, useRef } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useEntries } from '../hooks/useEntries';
import type { FieldRegistryEntry } from '../types/fieldRegistry';

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

// ---------------------------------------------------------------------------
// Type-specific inputs (Phase 36 DATA-02)
//
// Exported (D-07) so Plan 08's AddFilterChip can reuse the same typed value
// inputs instead of re-implementing them inline.
// ---------------------------------------------------------------------------

/** Validates whether a string value matches the registered field type. */
export function isMismatch(type: FieldRegistryEntry['type'], val: string): boolean {
  if (!val) return false;
  switch (type) {
    case 'number':
      return isNaN(Number(val)) || val.trim() === '';
    case 'url': {
      try {
        new URL(val);
        return false;
      } catch {
        return true;
      }
    }
    default:
      return false;
  }
}

// T-29-02-XSS / T-36-05-01 mitigation: url field renders value as a React text
// node + <a href> only after new URL() validation; never dangerouslySetInnerHTML.
export function UrlInput({
  inputId,
  value,
  onChange,
}: {
  inputId: string;
  value: string;
  onChange: (v: string) => void;
}) {
  let isValidUrl = false;
  try {
    new URL(value);
    isValidUrl = true;
  } catch {
    isValidUrl = false;
  }

  return (
    <div className="flex items-center gap-1 w-full">
      <input
        id={inputId}
        type="url"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="https://"
        className="flex-1 rounded-md border border-neutral-200 dark:border-neutral-800 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
      />
      {isValidUrl && (
        <a
          href={value}
          target="_blank"
          rel="noopener"
          className="text-xs text-neutral-400 hover:text-[color:var(--color-accent)] shrink-0"
          aria-label={`Open ${value} in new tab`}
          tabIndex={-1}
        >
          ↗
        </a>
      )}
    </div>
  );
}

export function BooleanInput({
  inputId,
  name,
  value,
  onChange,
}: {
  inputId: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const opts: { label: string; val: string }[] = [
    { label: 'Yes', val: 'true' },
    { label: 'No', val: 'false' },
    { label: '—', val: '' },
  ];
  return (
    <div
      id={inputId}
      role="group"
      aria-label={name}
      className="flex gap-1"
    >
      {opts.map((opt) => {
        const isActive = value === opt.val;
        return (
          <button
            key={opt.val || 'unset'}
            type="button"
            aria-pressed={isActive}
            aria-label={opt.label}
            onClick={() => onChange(isActive ? '' : opt.val)}
            className={`rounded-md border px-2 py-1 text-xs transition-colors ${
              isActive
                ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]'
                : 'border-neutral-300 dark:border-neutral-700 text-neutral-500 hover:border-neutral-400'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function EntryRefInput({
  inputId,
  name,
  value,
  onChange,
  universeId,
}: {
  inputId: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  universeId?: string;
}) {
  const { data: entries = [], isFetched } = useEntries(universeId ?? '');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // If stored value is a UUID (entry id), find the matching entry to display its title.
  const storedEntry = useMemo(
    () => entries.find((e) => e.id === value),
    [entries, value],
  );

  // D-02: a stored UUID with no matching entry is a dangling reference (target
  // deleted). Gate on `isFetched` so a valid ref does NOT flash the placeholder
  // while useEntries is still loading (entries defaults to [] mid-fetch); only
  // treat it as dangling once the entry list has actually resolved.
  const isDangling = !!value && !storedEntry && isFetched;

  // Sync query when value is cleared externally (e.g. from form reset).
  useEffect(() => {
    if (!value) {
      setQuery('');
    }
  }, [value]);

  const lowered = query.toLowerCase();
  const filtered = lowered
    ? entries.filter((e) => e.title.toLowerCase().includes(lowered)).slice(0, 8)
    : entries.slice(0, 8);

  const handleSelect = (entryId: string, entryTitle: string) => {
    onChange(entryId);
    setQuery(entryTitle);
    setOpen(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleChange = (newQuery: string) => {
    setQuery(newQuery);
    if (!open) setOpen(true);
    // If user clears the input, remove the stored UUID.
    if (!newQuery) onChange('');
  };

  const suggestionListId = `${inputId}-suggestions`;

  // D-02: when the stored UUID resolves to no entry, show a clear placeholder
  // (NOT the source's blank `query` fallback). The stored UUID is preserved on
  // `value`, so re-creating the target entry recovers the reference; the user
  // can also re-pick or clear it via the input below.
  return (
    <div className="flex flex-col gap-0.5 w-full">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Anchor asChild>
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            value={storedEntry ? storedEntry.title : query}
            onChange={(e) => handleChange(e.target.value)}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                setOpen(false);
              } else if (e.key === 'Escape') {
                setOpen(false);
              }
            }}
            placeholder={isDangling ? 'Re-link or clear…' : 'Search entries...'}
            role="combobox"
            aria-expanded={open}
            aria-controls={suggestionListId}
            aria-autocomplete="list"
            aria-label={name}
            className={`w-full rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)] ${
              isDangling
                ? 'border-amber-500/60'
                : 'border-neutral-200 dark:border-neutral-800'
            }`}
          />
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            id={suggestionListId}
            className="w-[var(--radix-popover-trigger-width)] max-h-48 overflow-y-auto bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md shadow-lg z-50 data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out"
            align="start"
            sideOffset={4}
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-sm text-neutral-500">No entries found</p>
            ) : (
              <ul role="listbox">
                {filtered.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => handleSelect(entry.id, entry.title)}
                      className="w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    >
                      {entry.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {isDangling && (
        <p className="text-xs text-amber-500">
          Deleted or missing entry — the reference is preserved.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main MetaEditor
// ---------------------------------------------------------------------------

export function MetaEditor({
  value,
  onChange,
  onValidityChange,
  registeredFields,
  universeId,
}: {
  value: Record<string, string>;
  onChange: (meta: Record<string, string>) => void;
  onValidityChange?: (valid: boolean) => void;
  /** Phase 36 DATA-02: optional registered typed fields rendered above freeform rows. */
  registeredFields?: FieldRegistryEntry[];
  /** Phase 36 DATA-02: universe ID for entry-ref typeahead suggestion source. */
  universeId?: string;
}) {
  const hasRegistered = !!registeredFields && registeredFields.length > 0;

  // D-04: collision matching is CASE-INSENSITIVE. We map each registered field
  // to the actual meta key it should own — preferring the entry's pre-existing
  // free-form key of the same case-folded name (so a registry field 'Status'
  // adopts an entry's existing 'status' value), falling back to the field name.
  const valueKeyByLower = useMemo(() => {
    const m = new Map<string, string>();
    for (const k of Object.keys(value)) {
      const lower = k.toLowerCase();
      if (!m.has(lower)) m.set(lower, k);
    }
    return m;
  }, [value]);

  // Resolve each registered field to its meta key ONCE and remember it (sticky).
  // D-04: the first time we see a field we adopt the entry's pre-existing
  // free-form key of the same case-folded name (e.g. 'status' for 'Status').
  // Subsequent edits — including clearing the value, which removes the key from
  // `value` — keep writing under that original key rather than reverting to the
  // field name. Without this, clearing an adopted 'status' value would re-key it
  // to 'Status' on the next keystroke.
  const fieldMetaKeyRef = useRef(new Map<string, string>());
  const fieldMetaKey = useMemo(() => {
    const m = fieldMetaKeyRef.current;
    for (const f of registeredFields ?? []) {
      if (!m.has(f.name)) {
        m.set(f.name, valueKeyByLower.get(f.name.toLowerCase()) ?? f.name);
      }
    }
    // Drop entries for fields no longer registered.
    const live = new Set((registeredFields ?? []).map((f) => f.name));
    for (const k of Array.from(m.keys())) {
      if (!live.has(k)) m.delete(k);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registeredFields, valueKeyByLower]);

  // Case-folded set of registered names — excludes those meta keys from the
  // freeform rows so a registered field doesn't also render as a free-form row.
  const registeredLowerKeys = useMemo(
    () => new Set((registeredFields ?? []).map((f) => f.name.toLowerCase())),
    [registeredFields],
  );

  // Initialise rows from value once. Subsequent value changes from the parent
  // (e.g. template prefill) are handled by a ref-tracked sync only when rows
  // is empty (avoids clobbering live edits).
  // Filter out registered-field keys (case-insensitive) from freeform rows.
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(value)
      .filter(([k]) => !registeredLowerKeys.has(k.toLowerCase()))
      .map(([k, v]) => ({
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
    // Exclude registered-field keys (case-insensitive) from freeform rows.
    const freeformEntries = Object.entries(value).filter(
      ([k]) => !registeredLowerKeys.has(k.toLowerCase()),
    );
    if (rows.length === 0 && freeformEntries.length > 0) {
      setRows(
        freeformEntries.map(([k, v]) => ({
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

  // Build the merged meta object from registered values + freeform rows.
  const buildMeta = (
    currentRows: Row[],
    currentValue: Record<string, string>,
  ): Record<string, string> => {
    const obj: Record<string, string> = {};
    // Carry over registered-field values from current value under their resolved
    // (case-folded) meta key. Registered rows manage their own state via the
    // parent value object.
    for (const f of registeredFields ?? []) {
      const metaKey = fieldMetaKey.get(f.name) ?? f.name;
      const v = currentValue[metaKey];
      if (v !== undefined && v !== '') {
        obj[metaKey] = v;
      }
    }
    // Then freeform rows.
    for (const r of currentRows) {
      if (r.key) obj[r.key] = r.val;
    }
    return obj;
  };

  useEffect(() => {
    onValidityChange?.(!hasDups);
    if (!hasDups) {
      onChange(buildMeta(rows, value));
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

  // Handle changes to a registered field's value (writes to the parent value
  // object under the resolved case-folded meta key, D-04).
  const updateRegisteredVal = (fieldName: string, newVal: string) => {
    const metaKey = fieldMetaKey.get(fieldName) ?? fieldName;
    const next: Record<string, string> = { ...value, [metaKey]: newVal };
    if (!newVal) delete next[metaKey];
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {/* ─── Registered fields section ──────────────────────────── */}
      {hasRegistered && (
        <>
          <p className="text-xs uppercase tracking-wide text-neutral-500 mt-2 mb-1">
            Custom fields
          </p>
          {(registeredFields ?? []).map((field) => {
            const inputId = `reg-field-${field.name.replace(/\s+/g, '-').toLowerCase()}`;
            const metaKey = fieldMetaKey.get(field.name) ?? field.name;
            const fieldVal = value[metaKey] ?? '';
            const mismatch = isMismatch(field.type, fieldVal);

            return (
              <div key={field.name} className="flex items-start gap-2">
                <label
                  htmlFor={inputId}
                  className="w-2/5 text-sm text-neutral-600 dark:text-neutral-400 truncate flex-shrink-0 pt-1.5"
                >
                  {field.name}
                </label>
                <div className="w-3/5 flex flex-col gap-0.5">
                  {field.type === 'text' && (
                    <input
                      id={inputId}
                      type="text"
                      value={fieldVal}
                      onChange={(e) => updateRegisteredVal(field.name, e.target.value)}
                      className="w-full rounded-md border border-neutral-200 dark:border-neutral-800 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
                      aria-label={field.name}
                    />
                  )}
                  {field.type === 'number' && (
                    <input
                      id={inputId}
                      type="number"
                      value={fieldVal}
                      onChange={(e) => updateRegisteredVal(field.name, e.target.value)}
                      placeholder="0"
                      className="w-full rounded-md border border-neutral-200 dark:border-neutral-800 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)] [appearance:textfield]"
                      aria-label={field.name}
                    />
                  )}
                  {field.type === 'boolean' && (
                    <BooleanInput
                      inputId={inputId}
                      name={field.name}
                      value={fieldVal}
                      onChange={(v) => updateRegisteredVal(field.name, v)}
                    />
                  )}
                  {field.type === 'url' && (
                    <UrlInput
                      inputId={inputId}
                      value={fieldVal}
                      onChange={(v) => updateRegisteredVal(field.name, v)}
                    />
                  )}
                  {field.type === 'entry-ref' && (
                    <EntryRefInput
                      inputId={inputId}
                      name={field.name}
                      value={fieldVal}
                      onChange={(v) => updateRegisteredVal(field.name, v)}
                      universeId={universeId}
                    />
                  )}
                  {field.hint && (
                    <p className="text-xs text-neutral-400">{field.hint}</p>
                  )}
                  {mismatch && (
                    <p className="text-xs text-amber-500">{"Doesn't match type"}</p>
                  )}
                </div>
              </div>
            );
          })}
          {/* Divider between registered and freeform fields */}
          <hr className="border-neutral-200 dark:border-neutral-800 my-2" />
          <p className="text-xs uppercase tracking-wide text-neutral-500 mb-1">
            Additional fields
          </p>
        </>
      )}

      {/* ─── Freeform rows ───────────────────────────────────────── */}
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

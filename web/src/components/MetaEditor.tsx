import { useState, useEffect, useMemo, useRef } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useEntries } from '../hooks/useEntries';
import type { FieldRegistryEntry } from '../hooks/useUniverse';

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
// Type-specific inputs
// ---------------------------------------------------------------------------

/** Validates whether a string value matches the registered field type. */
function isMismatch(type: FieldRegistryEntry['type'], val: string): boolean {
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

// T-29-02-XSS mitigation: url field renders value as React text node + <a href>
// only after new URL() validation; never dangerouslySetInnerHTML.
function UrlInput({
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

function BooleanInput({
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

function EntryRefInput({
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
  const { data: entries = [] } = useEntries(universeId ?? '');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // If stored value is a UUID (entry id), display the matching title.
  const storedEntry = useMemo(
    () => entries.find((e) => e.id === value),
    [entries, value],
  );
  const displayValue = storedEntry ? storedEntry.title : query;

  // Sync query when value changes externally (e.g. from form reset).
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

  return (
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
          placeholder="Search entries..."
          role="combobox"
          aria-expanded={open}
          aria-controls={suggestionListId}
          aria-autocomplete="list"
          aria-label={name}
          className="w-full rounded-md border border-neutral-200 dark:border-neutral-800 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
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
  );
  // displayValue is referenced for typescript — remove ts warning
  void displayValue;
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
  /** Phase 29 DATA-02: optional registered typed fields rendered above freeform rows. */
  registeredFields?: FieldRegistryEntry[];
  /** Phase 29 DATA-02: universe ID for entry-ref typeahead suggestion source (D-04). */
  universeId?: string;
}) {
  const hasRegistered = registeredFields && registeredFields.length > 0;
  // Keys managed by registered fields — exclude from freeform rows.
  const registeredKeys = useMemo(
    () => new Set((registeredFields ?? []).map((f) => f.name)),
    [registeredFields],
  );

  // Initialise rows from value once. Subsequent value changes from the parent
  // (e.g. template prefill) are handled by a ref-tracked sync only when rows
  // is empty (avoids clobbering live edits).
  // Filter out registered-field keys from freeform rows.
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(value)
      .filter(([k]) => !registeredKeys.has(k))
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
    // Exclude registered-field keys from freeform rows.
    const freeformEntries = Object.entries(value).filter(
      ([k]) => !registeredKeys.has(k),
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
    // Carry over registered-field values from current value (registered rows manage
    // their own state via the parent value object).
    for (const key of Array.from(registeredKeys)) {
      if (currentValue[key] !== undefined && currentValue[key] !== '') {
        obj[key] = currentValue[key];
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

  // Handle changes to a registered field's value (writes to parent value object).
  const updateRegisteredVal = (fieldName: string, newVal: string) => {
    const next: Record<string, string> = { ...value, [fieldName]: newVal };
    if (!newVal) delete next[fieldName];
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
            const fieldVal = value[field.name] ?? '';
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
                  {mismatch && (
                    <p className="text-xs text-amber-500">{"Doesn't match type"}</p>
                  )}
                </div>
              </div>
            );
          })}
          {/* Divider between registered and freeform — only when freeform rows are present */}
          {(rows.length > 0 || true) && (
            <>
              <hr className="border-neutral-200 dark:border-neutral-800 my-2" />
              <p className="text-xs uppercase tracking-wide text-neutral-500 mb-1">
                Additional fields
              </p>
            </>
          )}
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

export function MetaEditor({
  value,
  onChange,
}: {
  value: Record<string, string>;
  onChange: (meta: Record<string, string>) => void;
}) {
  const entries = Object.entries(value);

  function updateKey(oldKey: string, newKey: string) {
    const updated: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) {
      updated[k === oldKey ? newKey : k] = v;
    }
    onChange(updated);
  }

  function updateValue(key: string, newValue: string) {
    onChange({ ...value, [key]: newValue });
  }

  function removeField(key: string) {
    const { [key]: _, ...rest } = value;
    onChange(rest);
  }

  function addField() {
    // Find a unique placeholder key
    let n = 1;
    let newKey = '';
    while (newKey === '' || newKey in value) {
      newKey = `field${n}`;
      n++;
    }
    onChange({ ...value, [newKey]: '' });
  }

  return (
    <div className="space-y-2">
      {entries.map(([key, val]) => (
        <div key={key} className="flex items-center gap-2">
          <input
            type="text"
            value={key}
            onChange={(e) => updateKey(key, e.target.value)}
            className="w-2/5 rounded-md border border-neutral-200 dark:border-neutral-800 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
            placeholder="Key"
          />
          <input
            type="text"
            value={val}
            onChange={(e) => updateValue(key, e.target.value)}
            className="w-3/5 rounded-md border border-neutral-200 dark:border-neutral-800 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
            placeholder="Value"
          />
          <button
            type="button"
            onClick={() => removeField(key)}
            className="shrink-0 text-neutral-500 hover:text-red-500 text-sm"
            aria-label={`Remove field ${key}`}
          >
            &times;
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addField}
        className="text-sm text-neutral-500 hover:text-neutral-300 dark:hover:text-neutral-300"
      >
        + Add field
      </button>
    </div>
  );
}

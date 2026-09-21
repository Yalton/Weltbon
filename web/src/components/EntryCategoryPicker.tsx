import { useCategories } from '../hooks/useCategories';

interface Props {
  universeId: string;
  value: string | null;
  onChange: (value: string | null) => void;
  id?: string;
}

export function EntryCategoryPicker({ universeId, value, onChange, id }: Props) {
  const { data } = useCategories(universeId);

  return (
    <select
      id={id}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
    >
      <option value="">Uncategorized</option>
      {data?.categories.map((c) => (
        <option key={c.id} value={c.id}>
          {c.icon ? `${c.icon} ` : ''}
          {c.label}
        </option>
      ))}
    </select>
  );
}

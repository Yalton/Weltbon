
export type FieldType = 'text' | 'number' | 'boolean' | 'url' | 'entry-ref';

export interface FieldRegistryEntry {
  name: string;
  type: FieldType;
  hint?: string;
}

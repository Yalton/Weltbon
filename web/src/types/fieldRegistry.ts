/**
 * Types for the universe-scoped typed custom-field registry (DATA-02).
 *
 * Canonical home for the field-registry types. Re-exported from useUniverse.ts
 * (so `Universe.fieldRegistry: FieldRegistryEntry[]` and FieldRegistrySection
 * can import it from the hook) and imported directly by MetaEditor + the Plan 08
 * filter-chip inputs.
 */

/** Supported field types for the universe field registry */
export type FieldType = 'text' | 'number' | 'boolean' | 'url' | 'entry-ref';

/** A single registered custom field in the universe field registry */
export interface FieldRegistryEntry {
  /** Field name — unique within the registry (case-insensitive check on server) */
  name: string;
  /** Data type that governs the typed input rendered in MetaEditor + filter value inputs */
  type: FieldType;
  /** Optional hint text displayed below the input in MetaEditor */
  hint?: string;
}

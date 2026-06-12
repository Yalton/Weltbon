/**
 * Types for the universe-scoped typed custom-field registry (DATA-02).
 *
 * Defined here defensively so Plan 04 (filter chips) can import them
 * independently of Plan 02 (MetaEditor + FieldRegistrySection).
 * When Plan 02 lands and adds `fieldRegistry: FieldRegistryEntry[]` to the
 * Universe type in useUniverse.ts, it should import from this file.
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

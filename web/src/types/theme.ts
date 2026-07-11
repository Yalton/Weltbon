/** Mirrors api/src/db/schema.ts UniverseTheme (spec 2026-07-10). */
export interface UniverseTheme {
  palette?: 'observatory' | 'ember' | 'verdant' | 'abyssal' | 'parchment';
  accent?: string;
  displayFont?: 'spectral' | 'cormorant' | 'cinzel' | 'crimson';
  backdropAssetId?: string;
}

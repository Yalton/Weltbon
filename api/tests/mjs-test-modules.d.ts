declare module '*.mjs' {
  export const DB_GATED_TESTS: string[];
  export const INTEGRATION_TIERS: {
    smoke: string[];
    merge: string[];
    nightly: string[];
  };
  export function filesForTier(tier: keyof typeof INTEGRATION_TIERS): string[];
  export function shardFiles(files: string[], index: number, count: number): string[];
}

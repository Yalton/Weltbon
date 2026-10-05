/**
 * Types for integration-tiers.mjs.
 *
 * The tier list stays plain JavaScript because vitest.config.ts and
 * scripts/run-integration-tier.mjs load it with bare `node`. This declaration
 * file lets the tests that import it typecheck. Keep it in sync with the
 * exports by hand; ci-tier-manifest.test.ts fails to compile if a name drifts.
 */

export type IntegrationTier = 'smoke' | 'merge' | 'nightly';

/** Every test file that needs a live database, relative to api/. */
export const DB_GATED_TESTS: string[];

/** The files each CI tier runs. */
export const INTEGRATION_TIERS: Record<IntegrationTier, string[]>;

/** A copy of one tier's file list. Throws on an unknown tier. */
export function filesForTier(tier: IntegrationTier): string[];

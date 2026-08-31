import { expect, test } from 'vitest';
import { DB_GATED_TESTS, INTEGRATION_TIERS } from '../ci/integration-tiers.mjs';

test('nightly contains every DB-gated file exactly once', () => {
  expect(new Set(INTEGRATION_TIERS.nightly)).toEqual(new Set(DB_GATED_TESTS));
  expect(INTEGRATION_TIERS.nightly).toHaveLength(DB_GATED_TESTS.length);
});

test('smoke is a strict subset of merge, and merge is a subset of nightly', () => {
  expect(INTEGRATION_TIERS.smoke.every((file) => INTEGRATION_TIERS.merge.includes(file))).toBe(true);
  expect(INTEGRATION_TIERS.merge.every((file) => INTEGRATION_TIERS.nightly.includes(file))).toBe(true);
  expect(INTEGRATION_TIERS.smoke.length).toBeLessThan(INTEGRATION_TIERS.merge.length);
});

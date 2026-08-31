import { expect, test } from 'vitest';
import { DB_GATED_TESTS, INTEGRATION_TIERS } from '../ci/integration-tiers.mjs';
import { shardFiles } from '../scripts/run-integration-tier.mjs';

test('nightly contains every DB-gated file exactly once', () => {
  expect(new Set(DB_GATED_TESTS).size).toBe(DB_GATED_TESTS.length);
  expect(new Set(INTEGRATION_TIERS.nightly)).toEqual(new Set(DB_GATED_TESTS));
  expect(INTEGRATION_TIERS.nightly).toHaveLength(DB_GATED_TESTS.length);
});

test('smoke is a strict subset of merge, and merge is a subset of nightly', () => {
  expect(INTEGRATION_TIERS.smoke.every((file) => INTEGRATION_TIERS.merge.includes(file))).toBe(true);
  expect(INTEGRATION_TIERS.merge.every((file) => INTEGRATION_TIERS.nightly.includes(file))).toBe(true);
  expect(INTEGRATION_TIERS.smoke.length).toBeLessThan(INTEGRATION_TIERS.merge.length);
});

test('four shards are disjoint and reconstruct the merge tier', () => {
  const shards = [1, 2, 3, 4].map((index) => shardFiles(INTEGRATION_TIERS.merge, index, 4));
  expect(new Set(shards.flat())).toEqual(new Set(INTEGRATION_TIERS.merge));
  expect(shards.flat()).toHaveLength(INTEGRATION_TIERS.merge.length);
});

test('rejects shards with no selected files', () => {
  expect(() => shardFiles(['tests/example.test.ts'], 2, 2)).toThrow('Empty shard');
});

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { DB_GATED_TESTS, INTEGRATION_TIERS } from '../ci/integration-tiers.mjs';
import { shardFiles } from '../scripts/run-integration-tier.mjs';

const runnerPath = fileURLToPath(new URL('../scripts/run-integration-tier.mjs', import.meta.url));
const ciWorkflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
function workflowJob(name: string) {
  const match = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  \\S|(?![\\s\\S]))`, 'm').exec(ciWorkflow);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

test('CI routes integration tiers to isolated runners and dynamic ports', () => {
  const unit = workflowJob('unit');
  const smoke = workflowJob('integration-smoke');
  const merge = workflowJob('integration-merge');
  const dynamicDatabaseUrl = 'postgresql://weltbon:weltbon@localhost:${{ job.services.postgres.ports[5432] }}/weltbon';
  const migrationStep = `env:\n          DATABASE_URL: ${dynamicDatabaseUrl}\n        run: cd api && pnpm db:migrate`;

  expect(unit).toContain('runs-on: [self-hosted, weltbon-ci-unit]');
  expect(smoke).toContain('runs-on: [self-hosted, weltbon-ci-integration]');
  expect(merge).toContain('runs-on: [self-hosted, weltbon-ci-integration]');
  expect(ciWorkflow).not.toMatch(/runs-on:\s*\[self-hosted,\s*citreum\]/);

  for (const integrationJob of [smoke, merge]) {
    expect(integrationJob).toMatch(/^        ports:\n          - 5432$/m);
    expect(integrationJob).toContain(migrationStep);
    expect(integrationJob).toContain(`env:\n          DATABASE_URL: ${dynamicDatabaseUrl}\n        run:`);
  }

  expect(smoke).toContain('run: cd api && pnpm test:integration:smoke');
  expect(merge).toContain("shard: ['1/4', '2/4', '3/4', '4/4']");
  expect(merge).toContain('run: cd api && pnpm test:integration:merge -- ${{ matrix.shard }}');
});

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

test('returns an empty selection for shards with no files', () => {
  expect(shardFiles(['tests/example.test.ts'], 2, 2)).toEqual([]);
});

test('list mode emits no output for an empty shard', () => {
  const result = spawnSync(process.execPath, [runnerPath, 'smoke', '8/8', '--list'], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
});

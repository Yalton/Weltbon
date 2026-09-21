import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { DB_GATED_TESTS, INTEGRATION_TIERS } from '../ci/integration-tiers.mjs';
import { shardFiles } from '../scripts/run-integration-tier.mjs';

const runnerPath = fileURLToPath(new URL('../scripts/run-integration-tier.mjs', import.meta.url));
const ciWorkflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const nightlyWorkflow = readFileSync(new URL('../../.github/workflows/nightly-integration.yml', import.meta.url), 'utf8');
const releaseWorkflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
const publishWorkflow = readFileSync(new URL('../../.github/workflows/publish-ghcr.yml', import.meta.url), 'utf8');
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
  const mergeCommand = 'env:\n          DATABASE_URL: ' + dynamicDatabaseUrl + '\n        run: cd api && pnpm test:integration:merge ${{ matrix.shard }}';
  const runnerLabels = [...ciWorkflow.matchAll(/^    runs-on: (\[[^\n]+\])$/gm)].map(([, labels]) => labels);

  expect(unit).toContain('runs-on: [self-hosted, weltbon-ci-unit]');
  expect(unit).toContain('run: cd api && pnpm test -- --maxWorkers=1');
  expect(smoke).toContain('runs-on: [self-hosted, weltbon-ci-integration]');
  expect(merge).toContain('runs-on: [self-hosted, weltbon-ci-integration]');
  expect(runnerLabels).toEqual([
    '[self-hosted, weltbon-ci-unit]',
    '[self-hosted, weltbon-ci-integration]',
    '[self-hosted, weltbon-ci-integration]',
  ]);

  for (const integrationJob of [smoke, merge]) {
    expect(integrationJob).toMatch(/^        ports:\n          - 5432\n        options:/m);
    expect(integrationJob).toContain(migrationStep);
  }

  expect(smoke).toContain(`env:\n          DATABASE_URL: ${dynamicDatabaseUrl}\n        run: cd api && pnpm test:integration:smoke`);
  expect(merge).toContain('needs: [unit, integration-smoke]');
  expect(merge).toContain('max-parallel: 2');
  expect(merge).toContain("shard: ['1/4', '2/4', '3/4', '4/4']");
  expect(merge).toContain(mergeCommand);
  expect(merge).toContain("if: github.event_name == 'push'");
});

test.each(['integration-smoke', 'integration-merge'])('%s keeps disposable PostgreSQL data on bounded tmpfs', (name) => {
  const job = workflowJob(name);
  const postgres = /^      postgres:\n([\s\S]*?)(?=^    steps:)/m.exec(job)?.[1];
  expect(postgres).toBeDefined();
  expect(postgres).toContain('image: postgres:16-alpine');
  const options = /^        options: >-\n((?:          .+\n)+)/m.exec(postgres ?? '')?.[1];
  expect(options).toContain('--tmpfs /var/lib/postgresql/data:rw,size=1g');
  expect(options).toContain('--health-cmd "pg_isready -U weltbon -d weltbon"');
  expect(options).toContain('--health-interval 10s');
  expect(options).toContain('--health-timeout 5s');
  expect(options).toContain('--health-retries 5');
});

test('nightly coverage is scheduled while release labels stay on provisioned runners', () => {
  expect(releaseWorkflow).toContain('[self-hosted, citreum]');
  expect(publishWorkflow).toContain('[self-hosted, citreum]');
  expect(publishWorkflow).toContain('group: publish-ghcr');
  expect(nightlyWorkflow).toContain("cron: '30 6 * * *'");
  expect(nightlyWorkflow).toContain('pnpm test:integration:nightly');
});

test('nightly contains every DB-gated file exactly once', () => {
  expect(new Set(DB_GATED_TESTS).size).toBe(DB_GATED_TESTS.length);
  expect(new Set(INTEGRATION_TIERS.nightly)).toEqual(new Set(DB_GATED_TESTS));
  expect(INTEGRATION_TIERS.nightly).toHaveLength(DB_GATED_TESTS.length);
});

test('smoke is a strict subset of merge, and merge is a subset of nightly', () => {
  expect(INTEGRATION_TIERS.smoke).toEqual([
    'tests/auth.test.ts',
    'tests/requireAuth-pat.test.ts',
    'tests/sync-run.test.ts',
    'tests/llm-sharing-migration.test.ts',
    'tests/updated-at-bump.test.ts',
    'tests/ci-entry-smoke.test.ts',
  ]);
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

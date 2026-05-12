import { defineConfig } from 'vitest/config';

/**
 * Phase 17 — Vitest projects mode.
 *
 * Two named projects:
 *   - `unit`         No live Postgres required. Default `pnpm test` target.
 *                    Includes everything under tests/ except the 26 DB-gated
 *                    files listed in the integration project below.
 *   - `integration`  DB-gated. Explicit opt-in via `pnpm test:integration`.
 *                    Preserves pool:'forks' + singleFork:true (the existing
 *                    pool semantics — DB-gated tests share state via per-file
 *                    schemas managed by createTestDb).
 *
 * D-17-02: Files are partitioned by the canonical marker — every DB-gated
 * test imports `createTestDb` or `setTestDb` from `./helpers.ts`. The 26-file
 * list below was derived via:
 *   grep -l 'createTestDb\|setTestDb' tests/*.test.ts
 * If a new DB-gated test is added, append its path to the integration project's
 * `include` AND to the unit project's `exclude`. If a new no-DB test is added,
 * no config change is required — it auto-joins the unit lane.
 */

// Single source of truth for the DB-gated file list.
const DB_GATED_TESTS = [
  'tests/auth.test.ts',
  'tests/categories.test.ts',
  'tests/entries.test.ts',
  'tests/entry-search.test.ts',
  'tests/export-docx.test.ts',
  'tests/export-import.test.ts',
  'tests/export-markdown.test.ts',
  'tests/export-pdf.test.ts',
  'tests/export-streaming.test.ts',
  'tests/graph.test.ts',
  'tests/graph-positions.test.ts',
  'tests/index.test.ts',
  'tests/ingest-commit.test.ts',
  'tests/ingest-endpoint.test.ts',
  'tests/invites.test.ts',
  'tests/issues.test.ts',
  'tests/links.test.ts',
  'tests/pat-parity.test.ts',
  'tests/pat-service.test.ts',
  'tests/requireAuth-pat.test.ts',
  'tests/seedInviteCode.test.ts',
  'tests/timeline.test.ts',
  'tests/timeline-perf.test.ts',
  'tests/tokens.test.ts',
  'tests/universe-types.test.ts',
  'tests/universes.test.ts',
];

export default defineConfig({
  test: {
    // Shared options (apply to every project unless overridden).
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 10_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: DB_GATED_TESTS,
          // Unit lane runs default parallel forks — no shared DB state to protect.
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: DB_GATED_TESTS,
          pool: 'forks',
          poolOptions: {
            forks: { singleFork: true },
          },
        },
      },
    ],
  },
});

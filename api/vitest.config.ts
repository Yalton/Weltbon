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
  'tests/audit-engine-cost-unknown.test.ts',
  'tests/audit-recovery.test.ts',
  'tests/audit-routes.test.ts',
  'tests/audits-estimate.test.ts',
  'tests/audits-history.test.ts',
  'tests/audits-in-flight.test.ts',
  'tests/auth.test.ts',
  'tests/categories.test.ts',
  'tests/entries.test.ts',
  'tests/entry-search.test.ts',
  'tests/export-docx.test.ts',
  // Plan A2 (Export-Payload Completeness) — manifest 2.1.0 round-trip coverage.
  'tests/export-import-completeness.test.ts',
  'tests/export-import.test.ts',
  'tests/export-markdown.test.ts',
  'tests/export-pdf.test.ts',
  'tests/export-streaming.test.ts',
  'tests/graph-positions.test.ts',
  'tests/graph.test.ts',
  'tests/index.test.ts',
  'tests/ingest-commit.test.ts',
  'tests/ingest-endpoint.test.ts',
  'tests/invites.test.ts',
  'tests/issues-audit-run-id-filter.test.ts',
  'tests/issues-dismiss.test.ts',
  // Phase 34 FIX-01 — gap_key nulls-distinct uniqueness regression (DB-gated).
  'tests/issues-fix01-nulls-distinct.test.ts',
  'tests/issues.test.ts',
  'tests/links.test.ts',
  'tests/llm-keys-total-spent.test.ts',
  'tests/llm-keys.test.ts',
  'tests/llm-models-cache.test.ts',
  'tests/pat-parity.test.ts',
  'tests/pat-service.test.ts',
  'tests/requireAuth-pat.test.ts',
  'tests/seedInviteCode.test.ts',
  'tests/templates.test.ts',
  'tests/timeline-perf.test.ts',
  'tests/timeline-window.test.ts',
  'tests/timeline.test.ts',
  'tests/tokens.test.ts',
  'tests/universe-types.test.ts',
  'tests/universes.test.ts',
  // Plan A (sync foundation) — updatedAt timestamptz + $onUpdate regression coverage.
  'tests/updated-at-bump.test.ts',
  // Phase 29 Plan 05 — share-token security boundary + share-view privacy
  // invariants. Both files use createTestDb/setTestDb (DB-gated lane required).
  'tests/share-boundary.test.ts',
  'tests/share-views.test.ts',
  // Phase 31 Plan 01 — diagram CRUD + node + edge write-through integration tests.
  'tests/diagrams.test.ts',
  // Phase 32 Plan 02 — dictionary CRUD + FTS + CSV import + share read integration tests.
  'tests/dictionary-routes.test.ts',
  'tests/dictionary-fts.test.ts',
  'tests/dictionary-import.test.ts',
  // Phase 36 Plan 04 — DATA-05 universe statistics aggregate (DB-gated).
  'tests/stats.test.ts',
  // Phase 38 Plan 02 — MEDIA-01/02/03/04 asset upload/serving/CRUD integration tests.
  'tests/assets.test.ts',
  // Phase 38 Plan 04 — D-13 share asset boundary + privacy integration tests.
  'tests/share-assets.test.ts',
  // Phase 38 Plan 05 — MEDIA-06 export→reimport asset round-trip integration test.
  'tests/import-export-assets.test.ts',
  // Phase 40 Plan 01 — MAPS-04/05 region CRUD + pin style endpoints integration tests.
  'tests/maps.test.ts',
  // Phase 40 Plan 02 — MAPS-06 share map privacy filtering + mutation boundary tests.
  'tests/share-maps-boundary.test.ts',
  // Phase 41 Plan 01 — SC4 maps export→reimport round-trip integration test.
  'tests/import-export-maps.test.ts',
  // Phase 42 — layer + terrain-type CRUD/IDOR integration tests.
  'tests/map-layers.test.ts',
  // Phase 52 Plan 04 — SECRET-02 export→import round-trip integration tests.
  'tests/export-import-roundtrip.test.ts',
  // Plan C (sync protocol) — asset content hash + manifest 2.2.0.
  'tests/sync-asset-hash.test.ts',
  // Plan C Task 3 — the transactional apply engine (C-07/C-09/C-10/C-15).
  'tests/sync-apply.test.ts',
  // Plan C Task 4 — the /api/sync HTTP surface (handshake + snapshot).
  'tests/sync-routes.test.ts',
];

export default defineConfig({
  test: {
    // Shared options (apply to every project unless overridden).
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 10_000,
    // Hooks default to the same 10s as testTimeout. The DB-gated beforeAll/afterAll
    // (createTestDb spins up a per-file schema) run 10/10 in isolation but tip over
    // 10s under CPU contention on a loaded CI runner — cors.test.ts and
    // spa-fallback.test.ts then fail as "Hook timed out in 10000ms": 2 failed FILES,
    // 0 failed tests, exit 1. That is the exact phantom-red shape that hid the CI
    // breakage for months, so give hooks a wider ceiling than the per-test one.
    hookTimeout: 30_000,
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

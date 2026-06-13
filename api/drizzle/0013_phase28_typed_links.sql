-- Phase 28 REL-01 + FIX-01 + DATA-01: typed links migration + issues index fix + universes jsonb columns.
-- Hand-written migration (NOT drizzle-kit generated) because:
-- 1. FIX-01 (D-14) drops and recreates the issues_universe_gap_key_unique index without
--    NULLS NOT DISTINCT — Drizzle DSL has no nullsDistinct support.
-- 2. REL-01 requires a CHECK constraint on direction ("directed"|"undirected") —
--    Drizzle DSL cannot express this in the same additive migration.
-- All existing rows are backfilled before constraints are applied (see Steps 3-5).

-- ─── REL-01: Add typed-link columns to `links` ─────────────────────────────

-- Step 1: Add link_type (nullable — all existing rows get null = untyped)
ALTER TABLE "links" ADD COLUMN "link_type" text;
--> statement-breakpoint

-- Step 2: Add direction (nullable temporarily — will be backfilled then constrained)
ALTER TABLE "links" ADD COLUMN "direction" text;
--> statement-breakpoint

-- Step 3: Backfill direction from bidirectional
-- bidirectional=true → 'undirected', bidirectional=false → 'directed' (D-07)
UPDATE "links" SET "direction" = CASE
  WHEN "bidirectional" = true THEN 'undirected'
  ELSE 'directed'
END;
--> statement-breakpoint

-- Step 4: Add CHECK constraint now that all rows are backfilled (REL-01 / D-07)
ALTER TABLE "links" ADD CONSTRAINT "links_direction_check"
  CHECK ("direction" IN ('directed', 'undirected'));
--> statement-breakpoint

-- Step 5: Make direction NOT NULL now that all rows have a valid value
ALTER TABLE "links" ALTER COLUMN "direction" SET NOT NULL;
--> statement-breakpoint

-- Step 6: Make label nullable (D-04 — freeform label is now an optional display override)
ALTER TABLE "links" ALTER COLUMN "label" DROP NOT NULL;
--> statement-breakpoint

-- Step 7: Drop the bidirectional column (D-07: direction replaces it)
ALTER TABLE "links" DROP COLUMN "bidirectional";
--> statement-breakpoint

-- ─── FIX-01: Fix issues unique index (D-14) ────────────────────────────────

-- Drop the NULLS NOT DISTINCT index that blocks >= 2 manual issues per universe.
-- CORRECTIVE NOTE: The 0008 migration comment was factually backwards — NULLS NOT DISTINCT
-- means NULLs are considered EQUAL in the uniqueness check, so a second gap_key=NULL row
-- gets a unique constraint violation. The original comment claimed it "allows multiple NULLs"
-- which is the behavior of NULLS DISTINCT (the Postgres default), not NULLS NOT DISTINCT.
DROP INDEX "issues_universe_gap_key_unique";
--> statement-breakpoint

-- Recreate WITHOUT NULLS NOT DISTINCT (Postgres default = NULLS DISTINCT).
-- This allows unlimited gap_key=NULL rows (human-authored issues) while AI dedup
-- (ON CONFLICT DO NOTHING on non-null gap_key per universe) still holds because
-- non-null gap_key values are still unique per (universe_id, gap_key) pair.
CREATE UNIQUE INDEX "issues_universe_gap_key_unique"
  ON "issues" ("universe_id", "gap_key");
--> statement-breakpoint

-- ─── DATA-01: Add jsonb columns to universes (D-10 + D-11) ─────────────────

-- link_types registry: per-universe type → { color?, directionDefault?, inverseLabel? }
-- DEFAULT '{}' means no table rewrite stalls on existing rows (D-10).
ALTER TABLE "universes" ADD COLUMN "link_types" jsonb DEFAULT '{}' NOT NULL;
--> statement-breakpoint

-- entry_templates: per-universe user-defined templates (shape mirrors EntryTemplate interface)
-- DEFAULT '[]' means existing universe rows get an empty templates array (D-11).
ALTER TABLE "universes" ADD COLUMN "entry_templates" jsonb DEFAULT '[]' NOT NULL;

-- Phase 29 DATA-02 / DATA-03 / DATA-04: structured data migration.
-- Hand-written migration (NOT drizzle-kit generated) because:
-- 1. pg_trgm is a Postgres built-in extension — Drizzle DSL cannot express CREATE EXTENSION.
-- 2. All three changes are additive with DEFAULT so existing rows backfill without
--    a table-rewrite stall (D-10 precedent from Phase 28).

-- (1) Enable pg_trgm for future fuzzy-search (DATA-04 / research PITFALLS §Candidate-6).
-- IF NOT EXISTS means this is safe to run against DBs where it is already present.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint

-- (2) Add wip flag to entries (DATA-03: WIP/draft filter).
-- DEFAULT false backfills existing rows; NOT NULL enforced after backfill.
ALTER TABLE "entries" ADD COLUMN "wip" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- (3) Add field_registry to universes (DATA-02: typed custom-field registry).
-- DEFAULT '[]' backfills existing universe rows with an empty registry array.
ALTER TABLE "universes" ADD COLUMN "field_registry" jsonb DEFAULT '[]' NOT NULL;

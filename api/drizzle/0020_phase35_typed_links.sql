-- Hand-written migration (NOT drizzle-kit generated) because:
-- 1. REL-01 requires a CHECK constraint on direction ('directed'|'undirected') — Drizzle DSL cannot express this.
-- 2. Backfill from bidirectional must complete before the NOT NULL + CHECK are applied.
-- 3. label is made nullable (D-04: optional display override; link_type is the semantic carrier).

-- Step 1: Add link_type (nullable — all existing rows get null = untyped, D-02)
ALTER TABLE "links" ADD COLUMN "link_type" text;
--> statement-breakpoint

-- Step 2: Add direction (nullable temporarily — will be backfilled then constrained)
ALTER TABLE "links" ADD COLUMN "direction" text;
--> statement-breakpoint

-- Step 3: Backfill direction from bidirectional (D-02 transform rule)
-- bidirectional=true → 'undirected', bidirectional=false → 'directed'
UPDATE "links" SET "direction" = CASE
  WHEN "bidirectional" = true THEN 'undirected'
  ELSE 'directed'
END;
--> statement-breakpoint

-- Step 4: Add CHECK constraint now that all rows are backfilled (REL-01 — Drizzle DSL cannot express this)
ALTER TABLE "links" ADD CONSTRAINT "links_direction_check"
  CHECK ("direction" IN ('directed', 'undirected'));
--> statement-breakpoint

-- Step 5: Make direction NOT NULL (all rows now have a valid value)
ALTER TABLE "links" ALTER COLUMN "direction" SET NOT NULL;
--> statement-breakpoint

-- Step 6: Make label nullable (D-04 — freeform label is now an optional display override)
ALTER TABLE "links" ALTER COLUMN "label" DROP NOT NULL;
--> statement-breakpoint

-- Step 7: Drop the bidirectional column (D-07: direction replaces it)
ALTER TABLE "links" DROP COLUMN "bidirectional";
--> statement-breakpoint

-- Step 8: Add universes.link_types jsonb registry (D-10)
-- DEFAULT '{}' means no table rewrite stalls on existing rows.
ALTER TABLE "universes" ADD COLUMN "link_types" jsonb DEFAULT '{}' NOT NULL;

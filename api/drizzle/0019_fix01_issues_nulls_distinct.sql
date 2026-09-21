-- Hand-written migration (NOT drizzle-kit generated): Drizzle DSL cannot express the
-- null-comparison nuance on a unique index, so this is authored by hand.
-- Fixes a real product bug (CIDEBT-01): worldbuilders cannot file a 2nd manual issue per
-- universe because the original 0008 index treated rows with gap_key = NULL as duplicates
-- of each other. The Postgres default (NULLs compared as distinct) is the correct behavior.

-- Drop the old index that blocks >= 2 manual issues per universe.
-- CORRECTIVE NOTE: the 0008 migration comment was factually backwards — its clause made
-- NULL gap_key rows compare as EQUAL, so a second gap_key = NULL row hit a unique-constraint
-- violation. The original comment claimed it "allows multiple NULLs", which is actually the
-- Postgres default behavior, not the clause that was actually applied.
DROP INDEX "issues_universe_gap_key_unique";
--> statement-breakpoint

-- Recreate as a plain unique index (Postgres default: NULLs compared as distinct).
-- This allows unlimited gap_key = NULL rows (human-authored issues) while AI dedup
-- (ON CONFLICT DO NOTHING on non-null gap_key per universe) still holds because
-- non-null gap_key values remain unique per (universe_id, gap_key) pair.
CREATE UNIQUE INDEX "issues_universe_gap_key_unique"
  ON "issues" ("universe_id", "gap_key");

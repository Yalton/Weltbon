-- Out-of-band index builds for migration 0038 (issue #44, AS-05).
--
-- WHY THIS FILE EXISTS. Migration 0038 creates 13 indexes on the tables that
-- actually grow. Drizzle runs every pending migration inside ONE transaction
-- and the API runs migrations at boot, so a plain CREATE INDEX holds its SHARE
-- lock — reads fine, ALL WRITES BLOCKED — until the whole migration commits.
-- The stall is the SUM of all 13 builds, not the longest one.
--
-- CREATE INDEX CONCURRENTLY takes only SHARE UPDATE EXCLUSIVE, so writes keep
-- working. It cannot run inside a transaction block, which is why it cannot be
-- expressed in the migration itself and lives here instead.
--
-- HOW TO RUN IT. Against the live database, BEFORE deploying the release that
-- carries 0038:
--
--     psql "$DATABASE_URL" -f scripts/0038-indexes-concurrently.sql
--
-- Use psql -f. Do NOT wrap this in BEGIN/COMMIT and do not run it through a
-- client that opens a transaction for you — CONCURRENTLY will error.
--
-- Each statement is IF NOT EXISTS, so re-running after a partial failure picks
-- up where it stopped. Every index below matches 0038 exactly, name for name;
-- 0038's own statements are IF NOT EXISTS too, so the deploy that follows finds
-- them present and costs a catalogue lookup instead of a lock.
--
-- AFTERWARDS, check none came out invalid. A CONCURRENTLY build that fails
-- leaves an INVALID index behind, which is worse than no index: it is
-- maintained on write but never used by the planner.
--
--     SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
--
-- Drop and rebuild anything that appears.
--
-- KEEPING THIS IN STEP WITH 0038. api/tests/migration-0038-indexes.test.ts
-- parses both files and fails if an index is added, removed, or renamed in one
-- but not the other. Do not hand-edit one of them alone.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "categories_universe_id_idx" ON "categories" USING btree ("universe_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "diagrams_universe_id_idx" ON "diagrams" USING btree ("universe_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "dictionary_words_universe_id_idx" ON "dictionary_words" USING btree ("universe_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "entries_universe_id_idx" ON "entries" USING btree ("universe_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issues_universe_id_idx" ON "issues" USING btree ("universe_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "links_universe_id_idx" ON "links" USING btree ("universe_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "map_layers_universe_id_idx" ON "map_layers" USING btree ("universe_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "map_pins_map_id_idx" ON "map_pins" USING btree ("map_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "map_regions_map_id_idx" ON "map_regions" USING btree ("map_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "map_routes_map_id_idx" ON "map_routes" USING btree ("map_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "maps_universe_id_idx" ON "maps" USING btree ("universe_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "share_tokens_universe_id_idx" ON "share_tokens" USING btree ("universe_id");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "terrain_types_layer_id_idx" ON "terrain_types" USING btree ("layer_id");

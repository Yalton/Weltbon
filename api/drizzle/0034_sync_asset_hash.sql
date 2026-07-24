-- Plan C (sync spec S-10): content-addressed asset transfer.
-- content_hash is NULLABLE: asset bytes live in storageBackend, not SQL, so
-- this migration cannot compute hashes for existing rows. ensureAssetHashes()
-- backfills them lazily the first time a sync snapshot is built (C-04).
ALTER TABLE "assets" ADD COLUMN "content_hash" text;
--> statement-breakpoint
-- Lookup key for GET/PUT /api/sync/universes/:uid/assets/:hash.
CREATE INDEX "assets_content_hash_idx" ON "assets" USING btree ("universe_id","content_hash");

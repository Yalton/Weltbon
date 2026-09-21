-- Mirrors the tags text[] pattern exactly: DEFAULT '{}' means no NULL window; every existing
-- row backfills to an empty array (no data loss, no table rewrite stall).
ALTER TABLE "entries" ADD COLUMN "aliases" text[] DEFAULT '{}' NOT NULL;

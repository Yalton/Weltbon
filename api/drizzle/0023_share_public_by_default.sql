-- Share-everything-by-default: flip entries.is_public default to true and backfill.
-- Rationale: sharing a universe should show every entry without manual per-entry
-- toggling. The Public toggle remains as an opt-OUT (set false to hide a specific
-- entry from share links); the server-side share privacy filter
-- (entries.is_public = true in share-views.ts) is UNCHANGED — only the default flips.
ALTER TABLE "entries" ALTER COLUMN "is_public" SET DEFAULT true;
--> statement-breakpoint
UPDATE "entries" SET "is_public" = true WHERE "is_public" = false;

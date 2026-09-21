-- Nullable on purpose: existing rows get NULL, which triggers the first-visit
-- "Configure range" dialog (D-02). No default, no NOT NULL.
ALTER TABLE "universes" ADD COLUMN "timeline_window" jsonb;

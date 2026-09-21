-- Default false = not secret (owner sees everything; share path filters where secret=true).
-- Backfill: existing rows default to false (not secret) automatically via NOT NULL + DEFAULT.
ALTER TABLE "map_pins"    ADD COLUMN "secret" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "map_regions" ADD COLUMN "secret" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "map_routes"  ADD COLUMN "secret" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "map_layers"  ADD COLUMN "secret" boolean DEFAULT false NOT NULL;

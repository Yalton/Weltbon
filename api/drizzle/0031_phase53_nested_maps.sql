-- target_map_id: nullable FK to maps with ON DELETE SET NULL (mirrors terrainTypeId pattern).
-- entry_id DROP NOT NULL: a pin can be map-only with no entry link (D-01a).
ALTER TABLE "map_pins" ADD COLUMN "target_map_id" uuid;
--> statement-breakpoint
ALTER TABLE "map_regions" ADD COLUMN "target_map_id" uuid;
--> statement-breakpoint
ALTER TABLE "map_pins" ALTER COLUMN "entry_id" DROP NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "map_pins" ADD CONSTRAINT "map_pins_target_map_id_maps_id_fk"
    FOREIGN KEY ("target_map_id") REFERENCES "maps"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "map_regions" ADD CONSTRAINT "map_regions_target_map_id_maps_id_fk"
    FOREIGN KEY ("target_map_id") REFERENCES "maps"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null; END $$;

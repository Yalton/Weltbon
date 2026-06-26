-- Phase 51 ROUTE-01: map_routes table — freeform polyline routes / journey lines.
--
-- Structural near-clone of map_regions (0026_phase40_regions_styling.sql):
--   same FK cascade rules and normalized 0..1 points JSON convention.
--   Differences from map_regions:
--     - DROP terrain_type_id (routes have no terrain discriminator)
--     - ADD line_style text DEFAULT 'solid' NOT NULL   (solid | dashed, D-02)
--     - ADD width integer DEFAULT 4 NOT NULL            (discrete preset px, D-03)
--     - ADD show_arrow boolean DEFAULT false NOT NULL   (end-arrowhead, D-04)
--
-- Both FK constraints are ON DELETE cascade so deleting a map or entry
-- automatically removes the associated routes (matching map_regions behavior).
CREATE TABLE "map_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"map_id" uuid NOT NULL,
	"entry_id" uuid,
	"name" text DEFAULT '' NOT NULL,
	"points" text NOT NULL,
	"color" text,
	"line_style" text DEFAULT 'solid' NOT NULL,
	"width" integer DEFAULT 4 NOT NULL,
	"show_arrow" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "map_routes" ADD CONSTRAINT "map_routes_map_id_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "maps"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "map_routes" ADD CONSTRAINT "map_routes_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "entries"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--
-- map_layers: universe-scoped thematic terrain layer palette (biomes, elevation, climate).
--   universe_id FK CASCADE — deleting a universe removes all its layers.
--   ordered boolean — true → ranked elevation bands; false → flat thematic palette (D-42-05).
--   sort_order integer for user-defined display order.
--
-- terrain_types: layer-scoped terrain type definitions (Forest, Grassland, Lowlands, Peaks…).
--   layer_id FK CASCADE — deleting a layer removes all its terrain types.
--   color text NOT NULL — hex, auto-assigned at create, never colorless (D-42-07).
--   label text nullable — free-text height-range label for ordered bands (D-42-06).
--   sort_order integer for user-defined rank within the layer.
--
-- map_regions.terrain_type_id: nullable discriminator column (D-42 Approach A).
--   When set, the region is a terrain area (fill/layer derived from type → layer).
--   ON DELETE SET NULL — deleting a terrain type orphans the discriminator rather than
--   cascade-deleting user regions (T-42-02 threat mitigated).
CREATE TABLE "map_layers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"universe_id" uuid NOT NULL,
	"name" text NOT NULL,
	"ordered" boolean DEFAULT false NOT NULL,
	"default_opacity" double precision DEFAULT 0.6 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terrain_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"layer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"label" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "map_layers" ADD CONSTRAINT "map_layers_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "universes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "terrain_types" ADD CONSTRAINT "terrain_types_layer_id_map_layers_id_fk" FOREIGN KEY ("layer_id") REFERENCES "map_layers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "map_regions" ADD COLUMN "terrain_type_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "map_regions" ADD CONSTRAINT "map_regions_terrain_type_id_terrain_types_id_fk" FOREIGN KEY ("terrain_type_id") REFERENCES "terrain_types"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

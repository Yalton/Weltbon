ALTER TABLE "sync_links" ADD COLUMN "auto_sync" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_links" ADD COLUMN "last_synced_fingerprint" text;--> statement-breakpoint
ALTER TABLE "sync_links" ADD COLUMN "last_remote_fingerprint" text;--> statement-breakpoint
ALTER TABLE "sync_links" ADD COLUMN "next_poll_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_links" ADD COLUMN "failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_links" ADD COLUMN "paused_reason" text;--> statement-breakpoint
CREATE INDEX "categories_universe_id_idx" ON "categories" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "diagrams_universe_id_idx" ON "diagrams" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "dictionary_words_universe_id_idx" ON "dictionary_words" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "entries_universe_id_idx" ON "entries" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "issues_universe_id_idx" ON "issues" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "links_universe_id_idx" ON "links" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "map_layers_universe_id_idx" ON "map_layers" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "map_pins_map_id_idx" ON "map_pins" USING btree ("map_id");--> statement-breakpoint
CREATE INDEX "map_regions_map_id_idx" ON "map_regions" USING btree ("map_id");--> statement-breakpoint
CREATE INDEX "map_routes_map_id_idx" ON "map_routes" USING btree ("map_id");--> statement-breakpoint
CREATE INDEX "maps_universe_id_idx" ON "maps" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "share_tokens_universe_id_idx" ON "share_tokens" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "terrain_types_layer_id_idx" ON "terrain_types" USING btree ("layer_id");
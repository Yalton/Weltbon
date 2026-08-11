CREATE TABLE "instance_identity" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"instance_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	CONSTRAINT "instance_identity_instance_id_unique" UNIQUE("instance_id"),
	CONSTRAINT "instance_identity_singleton_true" CHECK ("instance_identity"."singleton" = true)
);
--> statement-breakpoint
INSERT INTO "instance_identity" ("singleton") VALUES (true)
ON CONFLICT ("singleton") DO NOTHING;

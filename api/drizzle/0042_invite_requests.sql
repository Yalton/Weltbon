CREATE TABLE "invite_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"invite_code_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	CONSTRAINT "invite_requests_status_check" CHECK ("invite_requests"."status" IN ('pending', 'issued', 'dismissed')),
	CONSTRAINT "invite_requests_name_length" CHECK (char_length("invite_requests"."name") <= 100),
	CONSTRAINT "invite_requests_email_length" CHECK (char_length("invite_requests"."email") <= 254),
	CONSTRAINT "invite_requests_note_length" CHECK ("invite_requests"."note" IS NULL OR char_length("invite_requests"."note") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "invite_requests" ADD CONSTRAINT "invite_requests_invite_code_id_invite_codes_id_fk" FOREIGN KEY ("invite_code_id") REFERENCES "invite_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_requests" ADD CONSTRAINT "invite_requests_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invite_requests_status_created_idx" ON "invite_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_requests_pending_email_unique" ON "invite_requests" USING btree ("email") WHERE "invite_requests"."status" = 'pending';

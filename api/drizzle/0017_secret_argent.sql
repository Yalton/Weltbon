CREATE TABLE "audit_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"universe_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"scope_entry_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 4) DEFAULT '0' NOT NULL,
	"trigger_source" text DEFAULT 'manual' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"gap_key_collision_count" integer DEFAULT 0 NOT NULL,
	"consulted_entry_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"partial_suggestions_persisted_at" timestamp with time zone,
	"hallucinated_entry_reference_count" integer DEFAULT 0 NOT NULL,
	"analyzed_entries" integer DEFAULT 0 NOT NULL,
	"cost_unknown" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diagram_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"diagram_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diagrams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"universe_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entry_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"entry_type" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"meta" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cloned_from" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_templates_user_id_entry_type_name_unique" UNIQUE("user_id","entry_type","name")
);
--> statement-breakpoint
CREATE TABLE "share_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"universe_id" uuid NOT NULL,
	"scope" text DEFAULT 'universe' NOT NULL,
	"scope_entry_id" uuid,
	"label" text DEFAULT '' NOT NULL,
	"hash" text NOT NULL,
	"body_suffix" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_accessed_at" timestamp with time zone,
	"access_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_tokens_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
ALTER TABLE "entries" ADD COLUMN "is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "source" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "gap_key" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "audit_run_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "dismissal_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "dismissal_reason" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "dismissal_notes" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "dismissal_snooze_remaining" integer;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "linked_issue_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "links" ADD COLUMN "diagram_id" uuid;--> statement-breakpoint
ALTER TABLE "links" ADD COLUMN "line_style" text;--> statement-breakpoint
ALTER TABLE "links" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "universes" ADD COLUMN "calendar" jsonb;--> statement-breakpoint
ALTER TABLE "universes" ADD COLUMN "audit_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "universes" ADD COLUMN "audit_provider" text;--> statement-breakpoint
ALTER TABLE "universes" ADD COLUMN "audit_model" text;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."universes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_scope_entry_id_entries_id_fk" FOREIGN KEY ("scope_entry_id") REFERENCES "public"."entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagram_nodes" ADD CONSTRAINT "diagram_nodes_diagram_id_diagrams_id_fk" FOREIGN KEY ("diagram_id") REFERENCES "public"."diagrams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagram_nodes" ADD CONSTRAINT "diagram_nodes_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagrams" ADD CONSTRAINT "diagrams_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."universes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_templates" ADD CONSTRAINT "entry_templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."universes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_tokens" ADD CONSTRAINT "share_tokens_scope_entry_id_entries_id_fk" FOREIGN KEY ("scope_entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_runs_universe_active_unique" ON "audit_runs" USING btree ("universe_id") WHERE status IN ('pending', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "diagram_nodes_unique_idx" ON "diagram_nodes" USING btree ("diagram_id","entry_id");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_audit_run_id_audit_runs_id_fk" FOREIGN KEY ("audit_run_id") REFERENCES "public"."audit_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_linked_issue_id_issues_id_fk" FOREIGN KEY ("linked_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_diagram_id_diagrams_id_fk" FOREIGN KEY ("diagram_id") REFERENCES "public"."diagrams"("id") ON DELETE set null ON UPDATE no action;
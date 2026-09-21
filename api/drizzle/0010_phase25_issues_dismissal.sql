-- Hand-written migration (NOT drizzle-kit generated) because the additive pattern
-- would regenerate the full schema diff rather than a surgical ADD COLUMN block.
-- All new columns are nullable — human issues and pre-Phase-25 AI issues have no
-- dismissal data; existing rows remain byte-identical after this migration.
ALTER TABLE "issues" ADD COLUMN "dismissal_reason" text;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "dismissal_notes" text;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "dismissal_snooze_remaining" integer;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "linked_issue_id" uuid;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "category" text;
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_linked_issue_id_issues_id_fk" FOREIGN KEY ("linked_issue_id") REFERENCES "issues"("id") ON DELETE set null ON UPDATE no action;

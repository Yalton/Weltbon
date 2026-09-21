-- merge.ts keys the universe singleton on the literal string 'universe', so the
-- uuid type raised 22P02 the first time two devices both edited universe-level
-- settings — silently losing the S-03 record the spec promises is restorable.
-- USING is explicit because uuid -> text is not an assignment cast.
ALTER TABLE "sync_conflicts" ALTER COLUMN "row_id" SET DATA TYPE text USING "row_id"::text;

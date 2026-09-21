-- the pre-check SELECT and the INSERT in api/src/routes/audits.ts. Without this
-- index, two concurrent POSTs to /api/universes/:uid/audit can both pass the
-- pre-check and create two pending audit_runs rows for the same universe,
-- violating AUDIT-10's "a parallel-audit attempt returns HTTP 409" guarantee.
-- The 23505 catch branch at audits.ts:269 relies on this index to fire.
CREATE UNIQUE INDEX "audit_runs_universe_active_unique" ON "audit_runs" ("universe_id") WHERE status IN ('pending', 'running');

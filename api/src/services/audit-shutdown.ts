/**
 * In-memory tracking of in-flight audit runs for graceful shutdown.
 * Single-process invariant (matches AUDIT-10 single-process model).
 *
 * T-24-06-02 (accepted): in a multi-replica deploy the Set is per-process;
 * SIGTERM on one replica won't drain runs on another. v3.0 is single-replica.
 */
const inFlight = new Set<string>();

/** Register a run as in-flight. Called at the status='running' transition. */
export function trackRun(runId: string): void { inFlight.add(runId); }

/** Remove a run from the in-flight set. Called at every terminal transition. */
export function releaseRun(runId: string): void { inFlight.delete(runId); }

/** Returns the current count of in-flight runs. Visible for tests. */
export function inFlightCount(): number { return inFlight.size; }

/** Reset the in-flight Set. DO NOT call from production — test isolation only. */
export function _resetInFlightForTest(): void { inFlight.clear(); }

/**
 * Wire SIGTERM handler that stops accepting new connections, waits up to graceMs
 * for in-flight runs to complete, then exits. Anything still running at expiry
 * becomes a process_restarted orphan on next boot via recoverOrphanAuditRuns (AUDIT-12).
 *
 * Default graceMs = cfg.auditShutdownGraceMs (15000ms per CONTEXT D-04).
 * Comfortably under typical k8s terminationGracePeriodSeconds=30.
 *
 * T-24-06-03 (mitigated): the hard deadline ensures SIGTERM never hangs forever.
 * T-24-06-02 (accepted): per-process Set; multi-replica drain is out of scope for v3.0.
 */
export function wireSigtermDrain(
  server: { close: (cb?: (err?: Error) => void) => void },
  graceMs: number,
): void {
  let draining = false;
  const onSigterm = async () => {
    if (draining) return;
    draining = true;
    console.log(
      `[audit-shutdown] SIGTERM received; ${inFlight.size} run(s) in flight; grace=${graceMs}ms`,
    );
    server.close();
    const deadline = Date.now() + graceMs;
    while (inFlight.size > 0 && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 250));
    }
    const leftover = inFlight.size;
    if (leftover > 0) {
      console.warn(
        `[audit-shutdown] grace expired with ${leftover} run(s) still in flight — will be recovered as process_restarted on next boot`,
      );
    }
    process.exit(leftover === 0 ? 0 : 1);
  };
  process.on('SIGTERM', onSigterm);
}

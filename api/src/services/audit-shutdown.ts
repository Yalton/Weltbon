/**
 * In-memory tracking of in-flight audit runs for graceful shutdown.
 * Single-process invariant (matches AUDIT-10 single-process model).
 *
 * T-24-06-02 (accepted): in a multi-replica deploy the Set is per-process;
 * SIGTERM on one replica won't drain runs on another. v3.0 is single-replica.
 */
const inFlight = new Set<string>();

export function trackRun(runId: string): void { inFlight.add(runId); }

export function releaseRun(runId: string): void { inFlight.delete(runId); }

export function inFlightCount(): number { return inFlight.size; }

export function _resetInFlightForTest(): void { inFlight.clear(); }

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

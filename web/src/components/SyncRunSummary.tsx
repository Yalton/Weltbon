
import type { SyncRunResult, SyncRunCounts } from '../hooks/useSyncLinks';

function totalRows(counts: SyncRunCounts) {
  const sum = (rec: Record<string, number>) => Object.values(rec).reduce((a, b) => a + b, 0);
  return sum(counts.upserted) + sum(counts.deleted);
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

export function SyncRunSummary({ result, testId }: { result: SyncRunResult; testId: string }) {
  const sent = totalRows(result.pushed);
  const applied = totalRows(result.appliedLocally);
  const files = result.blobsPushed + result.blobsPulled;

  return (
    <div
      data-testid={testId}
      role="status"
      className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200"
    >
      <p>
        {result.bootstrapped
          ? 'First sync complete — the two instances now hold the same universe.'
          : 'Sync complete.'}{' '}
        {sent === 0 && applied === 0
          ? 'Nothing had changed on either side.'
          : `Sent ${plural(sent, 'change', 'changes')}, applied ${plural(applied, 'change', 'changes')} here.`}
      </p>
      {files > 0 && (
        <p className="mt-1 text-xs opacity-90">
          Transferred {plural(files, 'file', 'files')} ({result.blobsPushed} out, {result.blobsPulled} in).
        </p>
      )}
      {result.conflicts > 0 && (
        <p className="mt-1 text-xs opacity-90">
          {plural(result.conflicts, 'conflict was', 'conflicts were')} recorded — see below for what
          each one kept.
        </p>
      )}
      {/* Deliberately unquantified — see the module docstring. */}
      {result.assetsRepairedLocally > 0 && (
        <p className="mt-1 text-xs opacity-90">
          Some files that were missing here were restored from the remote instance.
        </p>
      )}
      {result.assetsRepairedOnPeer > 0 && (
        <p className="mt-1 text-xs opacity-90">
          Files missing on the remote instance were sent to repair it.
        </p>
      )}
      {/* Amber inside the success box: the run finished, and this is what it
          could not recover. The count is part of the statement. */}
      {result.assetsUnrepairable > 0 && (
        <p className="mt-2 text-xs text-amber-300">
          {plural(result.assetsUnrepairable, 'asset file', 'asset files')} could not be restored —
          neither instance still holds their contents. Everything else synced.
        </p>
      )}
    </div>
  );
}
